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
    const { order_id, email } = await req.json();
    if (typeof order_id !== "string" || typeof email !== "string") {
      return json({ error: "Pedido o correo inválido." }, 400);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: order, error } = await supabase.from("orders")
      .select("id,status,buyer_email,guide_path")
      .eq("id", order_id)
      .maybeSingle();
    if (error || !order) return json({ error: "No encontramos ese pedido." }, 404);
    if (order.buyer_email.toLowerCase() !== email.trim().toLowerCase()) {
      return json({ error: "El correo no coincide con el de la compra." }, 403);
    }
    if (order.status !== "approved") return json({ error: "Pago pendiente de confirmación." }, 202);

    const { data: signed, error: signError } = await supabase.storage.from("guias")
      .createSignedUrl(order.guide_path, 20 * 60, { download: "Guia_Soluciones_NTEC.pdf" });
    if (signError || !signed?.signedUrl) throw signError || new Error("No se pudo generar el enlace.");
    return json({ download_url: signed.signedUrl, expires_in_seconds: 1200 });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno." }, 500);
  }
});
