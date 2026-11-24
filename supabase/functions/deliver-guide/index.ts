import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMetaEvent } from "../_shared/meta.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ? new URL(Deno.env.get("SITE_URL")!).origin : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const GUIDE_FILES = [
  { path: "01_Guia_Profesional_Seguridad_Electronica_actualizada.pdf", name: "Guía principal: El negocio de la seguridad electrónica" },
  { path: "02_Checklist_Instalador_Profesional.pdf", name: "Bono 1: Checklist del instalador profesional" },
  { path: "03_Guia_Proveedores_y_Materiales.pdf", name: "Bono 2: Guía de proveedores y materiales" },
  { path: "04_Presupuestos_Profesionales.pdf", name: "Bono 3: Presupuestos profesionales" },
  { path: "05_Sistema_Clientes_Meta_Ads.pdf", name: "Bono 4: Sistema de clientes y Meta Ads" },
  { path: "06_Guiones_WhatsApp_Cerrar_Clientes.pdf", name: "Bono 5: Guiones de WhatsApp para cerrar clientes" },
  { path: "07_IA_para_Instaladores_Prompts_ChatGPT.pdf", name: "Bono 6: IA para instaladores — prompts de ChatGPT" },
];


async function sendPurchaseEmail(email: string, orderId: string) {
  const appsScriptUrl = Deno.env.get("APPS_SCRIPT_URL") || "";
  const appsScriptSecret = Deno.env.get("APPS_SCRIPT_SECRET") || "";
  if (!appsScriptUrl || !appsScriptSecret) {
    console.error("Purchase email not configured: missing Apps Script secrets");
    return { ok: false, error: "El envío automático de correo no está configurado." };
  }

  try {
    const response = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: appsScriptSecret,
        email,
        order_id: orderId,
      }),
      redirect: "follow",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      console.error("Purchase email send failed", {
        httpStatus: response.status,
        appError: result?.error || "Invalid response",
      });
      return { ok: false, error: result?.error || "No se pudo enviar el correo automático." };
    }
    console.info("Purchase email confirmed", {
      orderId,
      duplicateEmail: result.duplicate === true,
    });
    return { ok: true, duplicate: result.duplicate === true };
  } catch (error) {
    console.error("Purchase email request failed", error);
    return { ok: false, error: "No se pudo conectar con el servicio de correo." };
  }
}

async function reconcileApprovedPayment(
  supabase: ReturnType<typeof createClient>,
  order: {
    id: string;
    status: string;
    buyer_email: string;
    amount: number;
    currency: string;
    mp_preference_id: string | null;
    mp_payment_id: string | null;
  },
  paymentId: string,
) {
  const token = Deno.env.get("MP_ACCESS_TOKEN") || "";
  if (!token) {
    return { ok: false, status: 503, error: "No está configurada la validación de pagos." };
  }

  const paymentResponse = await fetch(
    "https://api.mercadopago.com/v1/payments/" + encodeURIComponent(paymentId),
    { headers: { Authorization: "Bearer " + token } },
  );
  const payment = await paymentResponse.json().catch(() => ({}));

  if (paymentResponse.status === 404) {
    return { ok: false, status: 202, error: "Pago pendiente de confirmación." };
  }
  if (!paymentResponse.ok) {
    console.error("Payment verification failed", { status: paymentResponse.status });
    return { ok: false, status: 502, error: "No se pudo verificar el pago con Mercado Pago." };
  }
  if (String(payment.status || "").toLowerCase() !== "approved") {
    return { ok: false, status: 202, error: "Pago pendiente de confirmación." };
  }

  const reference = String(payment.external_reference || payment.metadata?.order_id || "");
  if (reference !== order.id) {
    console.warn("Payment/order reference mismatch", { orderId: order.id, paymentId });
    return { ok: false, status: 422, error: "El pago no corresponde a este pedido." };
  }
  if (payment.currency_id !== order.currency || Number(payment.transaction_amount) !== Number(order.amount)) {
    console.warn("Payment amount/currency mismatch", {
      orderId: order.id,
      paymentId,
      currency: payment.currency_id,
      amount: payment.transaction_amount,
    });
    return { ok: false, status: 422, error: "El importe o la moneda del pago no coinciden con el pedido." };
  }
  if (order.mp_payment_id && String(order.mp_payment_id) !== String(payment.id)) {
    return { ok: false, status: 409, error: "El pedido ya está asociado a otro pago." };
  }
  if (
    order.mp_preference_id &&
    payment.preference_id &&
    String(order.mp_preference_id) !== String(payment.preference_id)
  ) {
    console.warn("Payment/preference mismatch", { orderId: order.id, paymentId });
    return { ok: false, status: 422, error: "La preferencia del pago no coincide con el pedido." };
  }

  const accountResponse = await fetch("https://api.mercadopago.com/users/me", {
    headers: { Authorization: "Bearer " + token },
  });
  const account = await accountResponse.json().catch(() => ({}));
  if (!accountResponse.ok || !account.id) {
    console.error("Mercado Pago account verification failed", { status: accountResponse.status });
    return { ok: false, status: 502, error: "No se pudo validar la cuenta receptora del pago." };
  }
  if (!payment.collector_id || String(payment.collector_id) !== String(account.id)) {
    console.warn("Payment collector mismatch", { orderId: order.id, paymentId });
    return { ok: false, status: 422, error: "El pago no fue recibido por la cuenta configurada." };
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("orders")
    .update({
      status: "approved",
      mp_payment_id: String(payment.id),
      approved_at: now,
      updated_at: now,
    })
    .eq("id", order.id)
    .in("status", ["pending", "approved"]);

  if (updateError) {
    console.error("Could not approve verified order", updateError);
    return { ok: false, status: 500, error: "Se verificó el pago, pero no se pudo actualizar el pedido." };
  }

  return { ok: true, status: 200, error: "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const body = await req.json();
    const order_id = body?.order_id;
    const email = body?.email;
    const payment_id = typeof body?.payment_id === "string" || typeof body?.payment_id === "number"
      ? String(body.payment_id).trim()
      : "";

    if (typeof order_id !== "string" || typeof email !== "string") {
      return json({ error: "Pedido o correo inválido." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: order, error } = await supabase
      .from("orders")
      .select("id,status,buyer_email,amount,currency,mp_preference_id,mp_payment_id,meta_consent_at,meta_fbp,meta_fbc,meta_client_ip_address,meta_client_user_agent,meta_event_source_url,meta_purchase_sent_at")
      .eq("id", order_id)
      .maybeSingle();

    if (error || !order) return json({ error: "No encontramos ese pedido." }, 404);
    if (String(order.buyer_email || "").toLowerCase() !== email.trim().toLowerCase()) {
      return json({ error: "El correo no coincide con el de la compra." }, 403);
    }
    if (order.status !== "approved") {
      if (order.status !== "pending") {
        return json({ error: "Este pedido no está habilitado para la entrega." }, 409);
      }
      if (!payment_id) {
        return json({ error: "Pago pendiente de confirmación." }, 202);
      }

      const verification = await reconcileApprovedPayment(supabase, order, payment_id);
      if (!verification.ok) {
        return json({ error: verification.error }, verification.status);
      }
    }

    // The browser return can reconcile a valid payment before the webhook arrives.
    // Send Purchase here as a fallback, using the same atomic claim and event ID.
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
        .eq("id", order_id)
        .is("meta_purchase_sent_at", null)
        .or("meta_purchase_claimed_at.is.null,meta_purchase_claimed_at.lt." + claimExpiredBefore)
        .select("id")
        .maybeSingle();

      if (claimError) {
        console.error("Could not claim Meta Purchase event from delivery flow", {
          orderId: order_id,
          claimError,
        });
      } else if (claimedOrder) {
        try {
          await sendMetaEvent({
            eventName: "Purchase",
            eventId: "ntec-purchase-" + order_id,
            email: String(order.buyer_email),
            eventSourceUrl: String(order.meta_event_source_url),
            clientUserAgent: String(order.meta_client_user_agent),
            clientIpAddress: order.meta_client_ip_address
              ? String(order.meta_client_ip_address)
              : null,
            fbp: order.meta_fbp ? String(order.meta_fbp) : null,
            fbc: order.meta_fbc ? String(order.meta_fbc) : null,
            value: Number(order.amount),
            currency: String(order.currency),
            orderId: order_id,
          });
          await supabase.from("orders")
            .update({
              meta_purchase_sent_at: new Date().toISOString(),
              meta_purchase_claimed_at: null,
            })
            .eq("id", order_id)
            .eq("meta_purchase_claimed_at", claimTime);
          console.info("Meta Purchase event accepted from delivery reconciliation", {
            orderId: order_id,
          });
        } catch (metaError) {
          await supabase.from("orders")
            .update({ meta_purchase_claimed_at: null })
            .eq("id", order_id)
            .eq("meta_purchase_claimed_at", claimTime);
          console.error("Meta Purchase from delivery flow failed; retry is possible", {
            orderId: order_id,
            error: metaError instanceof Error ? metaError.message : "Unknown Meta error",
          });
        }
      }
    }

    const downloads = [];
    for (const file of GUIDE_FILES) {
      const candidates = [file.path, `${file.path}.pdf`];
      let signedUrl: string | null = null;
      let resolvedPath: string | null = null;
      let lastSignError: unknown = null;

      for (const candidate of candidates) {
        const { data, error: signError } = await supabase.storage.from("guias")
          .createSignedUrl(candidate, 20 * 60, { download: file.path });
        if (!signError && data?.signedUrl) {
          signedUrl = data.signedUrl;
          resolvedPath = candidate;
          break;
        }
        lastSignError = signError;
      }

      if (!signedUrl || !resolvedPath) {
        console.error("Could not sign guide file:", file.path, lastSignError);
        return json({ error: "No se pudo preparar la descarga de todos los materiales. Contactanos para recibir asistencia." }, 500);
      }
      downloads.push({ name: file.name, file_name: resolvedPath, download_url: signedUrl });
    }

    // Attempt email delivery on every validated access, including already-approved orders.
    // This lets a buyer recover a missing email without paying again.
    const emailDelivery = await sendPurchaseEmail(order.buyer_email, order.id);

    return json({
      downloads,
      expires_in_seconds: 1200,
      email_sent: emailDelivery.ok,
      email_error: emailDelivery.ok ? null : emailDelivery.error,
      // Only expose a browser Purchase event for orders with saved opt-in consent.
      // This stable ID is identical to the one used by Meta Conversions API.
      meta_purchase_event: order.meta_consent_at
        ? {
            event_id: "ntec-purchase-" + order.id,
            value: Number(order.amount),
            currency: String(order.currency),
          }
        : null,
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno." }, 500);
  }
});
