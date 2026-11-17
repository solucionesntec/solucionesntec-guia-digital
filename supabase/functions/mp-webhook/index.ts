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
  const parts = Object.fromEntries(signature.split(",").map(p => p.trim().split("=", 2)));
  const ts = parts.ts;
  const receivedHash = parts.v1;
  if (!ts || !receivedHash || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const expected = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(expected, receivedHash);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const url = new URL(req.url);
    const dataId = url.searchParams.get("data.id") || url.searchParams.get("id") || "";
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
    if (!paymentResponse.ok) throw new Error("No se pudo consultar el pago en Mercado Pago.");

    if (payment.status !== "approved") return new Response("Payment not approved", { status: 200 });
    if (payment.currency_id !== "ARS" || Number(payment.transaction_amount) !== 14900) {
      return new Response("Amount or currency mismatch", { status: 422 });
    }

    const orderId = String(payment.external_reference || payment.metadata?.order_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return new Response("Invalid order reference", { status: 422 });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: order, error: orderError } = await supabase.from("orders")
      .select("id, amount, currency, status")
      .eq("id", orderId).maybeSingle();
    if (orderError || !order) return new Response("Order not found", { status: 404 });
    if (order.amount !== 14900 || order.currency !== "ARS") return new Response("Order mismatch", { status: 422 });

    const { error: updateError } = await supabase.from("orders").update({
      status: "approved",
      mp_payment_id: String(payment.id),
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", orderId);
    if (updateError) throw updateError;

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(error);
    return new Response("Webhook processing error", { status: 500 });
  }
});
