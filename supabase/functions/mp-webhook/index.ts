import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validSignature(req: Request, dataId: string, secret: string) {
  const signature = req.headers.get("x-signature") || "";
  const requestId = req.headers.get("x-request-id") || "";
  const fields: Record<string, string> = {};
  for (const part of signature.split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      fields[key] = value;
    }
  }
  const ts = fields.ts;
  const receivedHash = fields.v1;
  if (!ts || !receivedHash || !requestId || !dataId) {
    console.warn("Webhook signature rejected: missing signature fields", {
      hasTimestamp: Boolean(ts), hasHash: Boolean(receivedHash),
      hasRequestId: Boolean(requestId), hasDataId: Boolean(dataId)
    });
    return false;
  }
  // Mercado Pago's signature manifest uses the payment ID in lowercase.
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.trim()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const expected = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const valid = constantTimeEqual(expected, receivedHash.toLowerCase());
  if (!valid) console.warn("Webhook signature rejected: HMAC mismatch");
  return valid;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const url = new URL(req.url);
    const dataId = (url.searchParams.get("data.id") || url.searchParams.get("id") || "").trim();
    const secret = Deno.env.get("MP_WEBHOOK_SECRET") || "";
    if (!secret || !(await validSignature(req, dataId, secret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const type = url.searchParams.get("type") || "";
    if (type && type !== "payment") return new Response("Ignored", { status: 200 });
    if (!dataId) return new Response("Missing payment id", { status: 400 });

    const token = Deno.env.get("MP_ACCESS_TOKEN")!;
    const paymentResponse = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(dataId), {
      headers: { "Authorization": "Bearer " + token }
    });
    const payment = await paymentResponse.json();
    // Mercado Pago webhook simulator sends a synthetic payment ID (for example 123456).
    // A 404 for that synthetic ID is an expected test result, not a server failure.
    if (paymentResponse.status === 404) {
      console.info("Webhook acknowledged: payment ID not found (likely simulator payload).", { dataId });
      return new Response("Payment not found; notification acknowledged", { status: 200 });
    }
    if (!paymentResponse.ok) {
      console.error("Mercado Pago payment lookup failed", { status: paymentResponse.status });
      throw new Error("No se pudo consultar el pago en Mercado Pago.");
    }

    if (payment.status !== "approved") return new Response("Payment not approved", { status: 200 });
    if (payment.currency_id !== "ARS" || Number(payment.transaction_amount) !== 14900) {
      return new Response("Amount or currency mismatch", { status: 422 });
    }

    const orderId = String(payment.external_reference || payment.metadata?.order_id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) return new Response("Invalid order reference", { status: 422 });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: order, error: orderError } = await supabase.from("orders")
      .select("id, amount, currency, status, buyer_email, mp_payment_id, mp_preference_id")
      .eq("id", orderId).maybeSingle();
    if (orderError || !order) return new Response("Order not found", { status: 404 });
    if (order.amount !== 14900 || order.currency !== "ARS") return new Response("Order mismatch", { status: 422 });
    if (!payment.preference_id || String(payment.preference_id) !== String(order.mp_preference_id)) {
      return new Response("Preference mismatch", { status: 422 });
    }
    if (order.status !== "pending" && order.status !== "approved") {
      return new Response("Order is not payable", { status: 409 });
    }

    // Verify that the payment was collected by the Mercado Pago account owning this access token.
    const accountResponse = await fetch("https://api.mercadopago.com/users/me", {
      headers: { "Authorization": "Bearer " + token }
    });
    if (!accountResponse.ok) {
      console.error("Mercado Pago account verification failed", { status: accountResponse.status });
      throw new Error("No se pudo verificar la cuenta receptora.");
    }
    const account = await accountResponse.json();
    if (!account.id || String(payment.collector_id) !== String(account.id)) {
      return new Response("Collector mismatch", { status: 422 });
    }
    if (!order.buyer_email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(order.buyer_email))) {
      return new Response("Order email is invalid", { status: 422 });
    }
    if (order.mp_payment_id && String(order.mp_payment_id) !== String(payment.id)) {
      return new Response("Order already linked to another payment", { status: 409 });
    }

    if (order.status !== "approved") {
      const now = new Date().toISOString();
      const { error: updateError } = await supabase.from("orders").update({
        status: "approved",
        mp_payment_id: String(payment.id),
        approved_at: now,
        updated_at: now
      }).eq("id", orderId);
      if (updateError) throw updateError;
    }

    // Email delivery is idempotent in Apps Script. If this call fails, return
    // 500 so Mercado Pago can retry the notification; duplicate sends are blocked.
    const appsScriptUrl = Deno.env.get("APPS_SCRIPT_URL") || "";
    const appsScriptSecret = Deno.env.get("APPS_SCRIPT_SECRET") || "";
    if (!appsScriptUrl || !appsScriptSecret) {
      console.error("Email delivery is not configured");
      return new Response("Email delivery is not configured", { status: 500 });
    }

    const emailResponse = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: appsScriptSecret,
        email: String(order.buyer_email),
        order_id: orderId
      }),
      redirect: "follow"
    });
    const emailResult = await emailResponse.json().catch(() => null);
    if (!emailResult || emailResult.ok !== true) {
      console.error("Apps Script email delivery failed", {
        httpStatus: emailResponse.status,
        appError: emailResult?.error || "Invalid response"
      });
      return new Response("Email delivery failed; retry notification", { status: 500 });
    }

    console.info("Order approved and delivery email confirmed", {
      orderId,
      duplicateEmail: emailResult.duplicate === true
    });
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(error);
    return new Response("Webhook processing error", { status: 500 });
  }
});
