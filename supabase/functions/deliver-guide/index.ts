import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  // CORS requires an origin only (scheme + host), while SITE_URL retains the full Pages path for redirects.
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ? new URL(Deno.env.get("SITE_URL")!).origin : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// All seven files are stored in the private "guias" bucket.
const GUIDE_FILES = [
  { path: "01_Guia_Profesional_Seguridad_Electronica_actualizada.pdf", name: "Guía principal: El negocio de la seguridad electrónica" },
  { path: "02_Checklist_Instalador_Profesional.pdf", name: "Bono 1: Checklist del instalador profesional" },
  { path: "03_Guia_Proveedores_y_Materiales.pdf", name: "Bono 2: Guía de proveedores y materiales" },
  { path: "04_Presupuestos_Profesionales.pdf", name: "Bono 3: Presupuestos profesionales" },
  { path: "05_Sistema_Clientes_Meta_Ads.pdf", name: "Bono 4: Sistema de clientes y Meta Ads" },
  { path: "06_Guiones_WhatsApp_Cerrar_Clientes.pdf", name: "Bono 5: Guiones de WhatsApp para cerrar clientes" },
  { path: "07_IA_para_Instaladores_Prompts_ChatGPT.pdf", name: "Bono 6: IA para instaladores — prompts de ChatGPT" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
  try {
    const { order_id, email } = await req.json();
    if (typeof order_id !== "string" || typeof email !== "string") {
      return json({ error: "Pedido o correo inválido." }, 400);
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: order, error } = await supabase.from("orders")
      .select("id,status,buyer_email")
      .eq("id", order_id)
      .maybeSingle();
    if (error || !order) return json({ error: "No encontramos ese pedido." }, 404);
    if (order.buyer_email.toLowerCase() !== email.trim().toLowerCase()) {
      return json({ error: "El correo no coincide con el de la compra." }, 403);
    }
    if (order.status !== "approved") return json({ error: "Pago pendiente de confirmación." }, 202);

    const downloads = [];
    for (const file of GUIDE_FILES) {
      const { data, error: signError } = await supabase.storage.from("guias")
        .createSignedUrl(file.path, 20 * 60, { download: file.path });
      if (signError || !data?.signedUrl) {
        console.error("Could not sign guide file:", file.path, signError);
        return json({ error: "No se pudo preparar la descarga de todos los materiales. Contactanos para recibir asistencia." }, 500);
      }
      downloads.push({ name: file.name, file_name: file.path, download_url: data.signedUrl });
    }
    return json({ downloads, expires_in_seconds: 1200 });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno." }, 500);
  }
});
