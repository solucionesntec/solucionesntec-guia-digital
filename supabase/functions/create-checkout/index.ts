import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") || "*",
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
    const { data: order, error: insertError } = await supabase
      .from("orders")
      .insert({ buyer_email: email, amount: 14900, currency: "ARS" })
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
      notification_url: SUPABASE_URL + "/functions/v1/mp-webhook",
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
    return json({ init_point: preference.init_point, order_id: order.id });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno." }, 500);
  }
});
