import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  // CORS requires an origin only (scheme + host), while SITE_URL retains the full Pages path for redirects.
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ? new URL(Deno.env.get("SITE_URL")!).origin : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN")!;
    const SITE_URL = Deno.env.get("SITE_URL")!;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !MP_ACCESS_TOKEN || !SITE_URL) {
      throw new Error("Faltan variables de entorno del servidor.");
    }

    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ error: "Ingresá un correo electrónico válido." }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Save Meta attribution data only when the visitor explicitly opted in.
    const metaConsent = body.meta_consent === true;
    const suppliedEventId = String(body.meta_event_id || "").trim();
    const validEventId = /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedEventId);
    const metaEventId = metaConsent && validEventId ? suppliedEventId : null;
    const siteOrigin = new URL(SITE_URL).origin;
    let eventSourceUrl = SITE_URL;
    if (metaConsent && typeof body.meta_event_source_url === "string") {
      try {
        const candidate = new URL(body.meta_event_source_url);
        if (candidate.origin === siteOrigin && candidate.protocol === "https:") {
          eventSourceUrl = candidate.toString();
        }
      } catch {
        // Fall back to the configured storefront URL.
      }
    }

    const cookieValue = (value: unknown, pattern: RegExp) => {
      const text = String(value || "").trim();
      return text.length <= 255 && pattern.test(text) ? text : null;
    };
    const metaFbp = metaConsent
      ? cookieValue(body.meta_fbp, /^fb\.1\.\d{8,16}\.\d+$/)
      : null;
    const metaFbc = metaConsent
      ? cookieValue(body.meta_fbc, /^fb\.1\.\d{8,16}\.[A-Za-z0-9_-]+$/)
      : null;
    const userAgent = metaConsent
      ? String(req.headers.get("user-agent") || "").slice(0, 500)
      : null;
    const forwardedIp = req.headers.get("cf-connecting-ip") ||
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const clientIp = metaConsent && forwardedIp && forwardedIp.length <= 64
      ? forwardedIp
      : null;
    const consentFields = metaConsent ? {
      meta_fbp: metaFbp,
      meta_fbc: metaFbc,
      meta_client_ip_address: clientIp,
      meta_client_user_agent: userAgent,
      meta_event_source_url: eventSourceUrl,
      meta_consent_at: new Date().toISOString(),
      meta_consent_version: "2026-11-24",
      meta_initiate_checkout_event_id: metaEventId,
    } : {};

    const { data: order, error: insertError } = await supabase
      .from("orders")
      .insert({
        buyer_email: email,
        amount: 14900,
        currency: "ARS",
        ...consentFields,
      })
      .select("id")
      .single();
    if (insertError || !order) throw insertError || new Error("No se pudo crear el pedido.");

    const preferenceBody = {
      items: [{
        id: "ntec-guia-seguridad-electronica",
        title: "El negocio de la seguridad electrónica — Guía digital Soluciones NTEC",
        quantity: 1,
        currency_id: "ARS",
        unit_price: 14900
      }],
      payer: { email },
      external_reference: order.id,
      metadata: { order_id: order.id },
      back_urls: {
        success: SITE_URL + "/?status=success&external_reference=" + order.id,
        failure: SITE_URL + "/?status=failure&external_reference=" + order.id,
        pending: SITE_URL + "/?status=pending&external_reference=" + order.id
      },
      auto_return: "approved",
      // Use the app-level signed Webhook configured in Mercado Pago Developers.
      // Do not set notification_url here: per-preference URLs override that configuration and use legacy IPN.
      statement_descriptor: "SOLUCIONES NTEC"
    };

    const mpResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preferenceBody)
    });
    const preference = await mpResponse.json();
    if (!mpResponse.ok || !preference.id || !preference.init_point) {
      await supabase.from("orders").update({ status: "rejected" }).eq("id", order.id);
      console.error("Mercado Pago preference error", preference);
      return json({ error: "Mercado Pago no pudo iniciar el checkout." }, 502);
    }

    await supabase.from("orders").update({ mp_preference_id: String(preference.id) }).eq("id", order.id);

    // Send the server event with the same event_id used by the browser Pixel.
    // Analytics failures never interrupt a valid payment checkout.
    if (metaConsent && metaEventId && userAgent) {
      try {
        const { sendMetaEvent } = await import("../_shared/meta.ts");
        await sendMetaEvent({
          eventName: "InitiateCheckout",
          eventId: metaEventId,
          email,
          eventSourceUrl,
          clientUserAgent: userAgent,
          clientIpAddress: clientIp,
          fbp: metaFbp,
          fbc: metaFbc,
          value: 14900,
          currency: "ARS",
          orderId: order.id,
        });
        await supabase.from("orders")
          .update({ meta_initiate_checkout_sent_at: new Date().toISOString() })
          .eq("id", order.id);
      } catch (metaError) {
        console.error("Meta InitiateCheckout delivery failed", {
          orderId: order.id,
          error: metaError instanceof Error ? metaError.message : "Unknown Meta error",
        });
      }
    }

    return json({ init_point: preference.init_point, order_id: order.id });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno." }, 500);
  }
});
