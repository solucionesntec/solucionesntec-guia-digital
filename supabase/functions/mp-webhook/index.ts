import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMetaEvent } from "../_shared/meta.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      fields[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }

  const ts = fields.ts;
  const receivedHash = fields.v1;
  if (!ts || !receivedHash || !dataId) {
    console.warn("Webhook signature rejected: missing required signature fields", {
      hasTimestamp: Boolean(ts),
      hasHash: Boolean(receivedHash),
      hasDataId: Boolean(dataId)
    });
    return false;
  }

  // Mercado Pago's manifest omits any pair whose value is absent.
  const manifest = [
    dataId ? `id:${dataId.toLowerCase()};` : "",
    requestId ? `request-id:${requestId};` : "",
    ts ? `ts:${ts};` : ""
  ].join("");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.trim()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const expected = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  const valid = constantTimeEqual(expected, receivedHash.toLowerCase());
  if (!valid) console.warn("Webhook signature rejected: HMAC mismatch");
  return valid;
}

async function mpGet(path: string, token: string) {
  const response = await fetch("https://api.mercadopago.com" + path, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const url = new URL(req.url);
    const dataId = (
      url.searchParams.get("data.id") ||
      url.searchParams.get("id") ||
      ""
    ).trim();

    let bodyType = "";
    try {
      const body = await req.clone().json();
      bodyType = String(body?.type || "").trim().toLowerCase();
    } catch {
      // Some notifications may arrive without a JSON body.
    }

    const eventType = (
      url.searchParams.get("type") ||
      url.searchParams.get("topic") ||
      bodyType ||
      "payment"
    ).trim().toLowerCase();

    const secret = Deno.env.get("MP_WEBHOOK_SECRET") || "";
    if (!secret || !(await validSignature(req, dataId, secret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const isPaymentEvent = eventType === "payment" || eventType === "topic_payment";
    const isMerchantOrderEvent = [
      "topic_merchant_order_wh",
      "merchant_order",
      "merchant_order_wh"
    ].includes(eventType);

    if (!isPaymentEvent && !isMerchantOrderEvent) {
      console.info("Webhook topic ignored", { eventType });
      return new Response("Topic ignored", { status: 200 });
    }
    if (!dataId) return new Response("Missing resource id", { status: 400 });

    const token = Deno.env.get("MP_ACCESS_TOKEN") || "";
    if (!token) throw new Error("Falta configurar MP_ACCESS_TOKEN.");

    let expectedOrderId = "";
    let expectedPreferenceId = "";
    let paymentId = dataId;

    if (isMerchantOrderEvent) {
      // For topic_merchant_order_wh, data.id is the merchant-order ID,
      // not the payment ID. Resolve it first, then verify its approved payment.
      const merchantOrderResult = await mpGet(
        "/merchant_orders/" + encodeURIComponent(dataId),
        token
      );

      if (merchantOrderResult.response.status === 404) {
        console.info("Merchant order not found; likely simulator payload.", { dataId });
        return new Response("Merchant order not found; notification acknowledged", { status: 200 });
      }
      if (!merchantOrderResult.response.ok) {
        console.error("Mercado Pago merchant-order lookup failed", {
          status: merchantOrderResult.response.status
        });
        throw new Error("No se pudo consultar la orden comercial en Mercado Pago.");
      }

      const merchantOrder = merchantOrderResult.data;
      expectedOrderId = String(merchantOrder.external_reference || "");
      expectedPreferenceId = String(merchantOrder.preference_id || "");

      if (!UUID_RE.test(expectedOrderId) || !expectedPreferenceId) {
        console.warn("Merchant order missing a valid reference or preference", {
          hasExternalReference: Boolean(expectedOrderId),
          hasPreferenceId: Boolean(expectedPreferenceId)
        });
        return new Response("Merchant order reference invalid", { status: 422 });
      }

      const approvedPayments = Array.isArray(merchantOrder.payments)
        ? merchantOrder.payments.filter((item: { id?: string | number; status?: string }) =>
            item?.id && String(item.status).toLowerCase() === "approved"
          )
        : [];

      if (approvedPayments.length === 0) {
        console.info("Merchant order has no approved payments yet", { dataId });
        return new Response("Merchant order payment pending", { status: 200 });
      }
      if (approvedPayments.length !== 1) {
        console.error("Merchant order has multiple approved payments; manual review required", {
          dataId,
          approvedPaymentCount: approvedPayments.length
        });
        return new Response("Multiple approved payments require review", { status: 409 });
      }

      paymentId = String(approvedPayments[0].id);
    }

    const paymentResult = await mpGet(
      "/v1/payments/" + encodeURIComponent(paymentId),
      token
    );

    // The Mercado Pago webhook simulator can send synthetic IDs (for example 123456).
    if (paymentResult.response.status === 404) {
      console.info("Payment ID not found; likely simulator payload.", { dataId, paymentId });
      return new Response("Payment not found; notification acknowledged", { status: 200 });
    }
    if (!paymentResult.response.ok) {
      console.error("Mercado Pago payment lookup failed", {
        status: paymentResult.response.status
      });
      throw new Error("No se pudo consultar el pago en Mercado Pago.");
    }

    const payment = paymentResult.data;
    if (payment.status !== "approved") {
      console.info("Payment is not approved yet", { paymentId, status: payment.status });
      return new Response("Payment not approved", { status: 200 });
    }

    if (payment.currency_id !== "ARS" || Number(payment.transaction_amount) !== 14900) {
      console.warn("Payment amount or currency mismatch", {
        paymentId,
        currency: payment.currency_id,
        amount: payment.transaction_amount
      });
      console.warn("Webhook rejected: payment amount/currency mismatch", {
        paymentId: String(paymentId),
        currency: payment.currency_id ?? null,
        amount: payment.transaction_amount ?? null
      });
      return new Response("Amount or currency mismatch", { status: 422 });
    }

    const paymentExternalReference = String(
      payment.external_reference || payment.metadata?.order_id || ""
    );
    if (!UUID_RE.test(paymentExternalReference)) {
      console.warn("Webhook rejected: invalid payment external reference", {
        paymentId: String(paymentId),
        hasExternalReference: Boolean(paymentExternalReference)
      });
      return new Response("Invalid payment order reference", { status: 422 });
    }

    const orderId = expectedOrderId || paymentExternalReference;
    if (paymentExternalReference !== orderId) {
      console.warn("Webhook rejected: merchant-order/payment reference mismatch", {
        paymentId: String(paymentId),
        expectedOrderId: orderId,
        paymentReference: paymentExternalReference
      });
      return new Response("Merchant order and payment reference mismatch", { status: 422 });
    }

    // The Payments API may omit preference_id on the payment resource.
    // When present, verify it; when absent, the merchant-order event below
    // provides the preference ID used for the checkout.
    if (expectedPreferenceId && payment.preference_id &&
      String(payment.preference_id) !== expectedPreferenceId) {
      console.warn("Webhook rejected: merchant-order/payment preference mismatch", {
        paymentId: String(paymentId),
        expectedPreferenceId,
        paymentPreferenceId: String(payment.preference_id)
      });
      return new Response("Merchant order and payment preference mismatch", { status: 422 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, amount, currency, status, buyer_email, mp_payment_id, mp_preference_id, meta_consent_at, meta_fbp, meta_fbc, meta_client_ip_address, meta_client_user_agent, meta_event_source_url, meta_purchase_sent_at")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError || !order) return new Response("Order not found", { status: 404 });
    if (order.amount !== 14900 || order.currency !== "ARS") {
      console.warn("Webhook rejected: database order amount/currency mismatch", {
        orderId,
        orderAmount: order.amount,
        orderCurrency: order.currency
      });
      return new Response("Order amount or currency mismatch", { status: 422 });
    }
    if (!order.mp_preference_id) {
      console.warn("Webhook rejected: order has no stored preference ID", { orderId });
      return new Response("Order preference is missing", { status: 422 });
    }
    if (expectedPreferenceId && String(order.mp_preference_id) !== expectedPreferenceId) {
      console.warn("Webhook rejected: merchant-order/database preference mismatch", {
        orderId,
        merchantOrderPreferenceId: expectedPreferenceId,
        orderPreferenceId: String(order.mp_preference_id)
      });
      return new Response("Merchant order and database preference mismatch", { status: 422 });
    }
    if (payment.preference_id && String(payment.preference_id) !== String(order.mp_preference_id)) {
      console.warn("Webhook rejected: database/payment preference mismatch", {
        orderId,
        paymentPreferenceId: String(payment.preference_id),
        orderPreferenceId: String(order.mp_preference_id)
      });
      return new Response("Preference mismatch", { status: 422 });
    }
    if (order.status !== "pending" && order.status !== "approved") {
      return new Response("Order is not payable", { status: 409 });
    }

    // Verify that the payment was collected by the Mercado Pago account owning this access token.
    const accountResult = await mpGet("/users/me", token);
    if (!accountResult.response.ok) {
      console.error("Mercado Pago account verification failed", {
        status: accountResult.response.status
      });
      throw new Error("No se pudo verificar la cuenta receptora.");
    }
    const account = accountResult.data;
    if (!account.id || String(payment.collector_id) !== String(account.id)) {
      console.warn("Webhook rejected: collector/account mismatch", {
        paymentId: String(paymentId),
        paymentCollectorId: String(payment.collector_id || ""),
        tokenAccountId: String(account.id || "")
      });
      return new Response("Collector mismatch", { status: 422 });
    }

    if (!order.buyer_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(order.buyer_email))) {
      return new Response("Order email is invalid", { status: 422 });
    }
    if (order.mp_payment_id && String(order.mp_payment_id) !== String(payment.id)) {
      return new Response("Order already linked to another payment", { status: 409 });
    }

    // Update even if the order is already approved but its payment ID was not saved.
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: "approved",
        mp_payment_id: String(payment.id),
        approved_at: now,
        updated_at: now
      })
      .eq("id", orderId);

    if (updateError) throw updateError;

    // Send Purchase only for orders with recorded opt-in consent.
    // Claim the row atomically so duplicate Mercado Pago notifications do not
    // send the same event concurrently. A stable event_id lets Meta deduplicate
    // retries if the network fails after Meta has accepted an event.
    if (
      order.meta_consent_at &&
      !order.meta_purchase_sent_at &&
      order.meta_client_user_agent &&
      order.meta_event_source_url
    ) {
      const claimTime = new Date().toISOString();
      const claimExpiredBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: claimedOrder, error: claimError } = await supabase
        .from("orders")
        .update({ meta_purchase_claimed_at: claimTime })
        .eq("id", orderId)
        .is("meta_purchase_sent_at", null)
        .or("meta_purchase_claimed_at.is.null,meta_purchase_claimed_at.lt." + claimExpiredBefore)
        .select("id")
        .maybeSingle();

      if (claimError) {
        console.error("Could not claim Meta Purchase event", { orderId, claimError });
      } else if (claimedOrder) {
        try {
          const approvedTime = payment.date_approved
            ? Math.floor(new Date(payment.date_approved).getTime() / 1000)
            : Math.floor(Date.now() / 1000);
          await sendMetaEvent({
            eventName: "Purchase",
            eventId: "ntec-purchase-" + orderId,
            email: String(order.buyer_email),
            eventSourceUrl: String(order.meta_event_source_url),
            clientUserAgent: String(order.meta_client_user_agent),
            clientIpAddress: order.meta_client_ip_address
              ? String(order.meta_client_ip_address)
              : null,
            fbp: order.meta_fbp ? String(order.meta_fbp) : null,
            fbc: order.meta_fbc ? String(order.meta_fbc) : null,
            value: 14900,
            currency: "ARS",
            orderId,
            eventTime: approvedTime,
          });
          await supabase.from("orders")
            .update({
              meta_purchase_sent_at: new Date().toISOString(),
              meta_purchase_claimed_at: null,
            })
            .eq("id", orderId)
            .eq("meta_purchase_claimed_at", claimTime);
          console.info("Meta Purchase event accepted", { orderId });
        } catch (metaError) {
          await supabase.from("orders")
            .update({ meta_purchase_claimed_at: null })
            .eq("id", orderId)
            .eq("meta_purchase_claimed_at", claimTime);
          console.error("Meta Purchase delivery failed; retry is possible", {
            orderId,
            error: metaError instanceof Error ? metaError.message : "Unknown Meta error",
          });
        }
      }
    }

    // Apps Script delivery is idempotent. A failure returns 500 so Mercado Pago can retry.
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
      paymentId: String(payment.id),
      eventType,
      duplicateEmail: emailResult.duplicate === true
    });
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(error);
    return new Response("Webhook processing error", { status: 500 });
  }
});
