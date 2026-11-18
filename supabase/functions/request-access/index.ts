import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL")
    ? new URL(Deno.env.get("SITE_URL")!).origin
    : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const genericMessage =
  "Si encontramos una compra aprobada asociada a ese correo, enviaremos un enlace para recuperar el acceso. Revisá Recibidos y Spam.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ error: "Ingresá un correo electrónico válido." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const appsScriptUrl = Deno.env.get("APPS_SCRIPT_URL") || "";
    const appsScriptSecret = Deno.env.get("APPS_SCRIPT_SECRET") || "";

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Recovery service missing Supabase server configuration.");
      return json({ error: "La recuperación no está conectada correctamente con la base de datos. Código: RECOVERY_DB_CONFIG" }, 503);
    }
    if (!appsScriptUrl || !appsScriptSecret) {
      console.error("Recovery service missing Apps Script configuration.");
      return json({ error: "Falta configurar el servicio de correo en Supabase. Código: RECOVERY_MAIL_CONFIG" }, 503);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: order, error } = await supabase
      .from("orders")
      .select("id")
      .eq("buyer_email", email)
      .eq("status", "approved")
      .not("approved_at", "is", null)
      .order("approved_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Recovery order lookup failed:", error);
      return json({ error: "Supabase no pudo consultar los pedidos. Código: RECOVERY_DB_QUERY" }, 503);
    }

    // Always return the same public message whether an approved order exists or not.
    // This avoids revealing which email addresses have purchased.
    if (order) {
      try {
        const mailResponse = await fetch(appsScriptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: appsScriptSecret,
            email,
            order_id: order.id,
            resend: true,
          }),
          redirect: "follow",
        });
        const mailResult = await mailResponse.json().catch(() => null);
        if (!mailResponse.ok || !mailResult || mailResult.ok !== true) {
          const appError = String(mailResult?.error || "");
          console.error("Recovery email request failed", {
            httpStatus: mailResponse.status,
            appError: appError || "Invalid response",
          });
          if (appError.toLowerCase().includes("no autorizado")) {
            return json({ error: "La clave de comunicación no coincide. Revisá que CLAVE_WEBHOOK en Apps Script sea idéntica a APPS_SCRIPT_SECRET en Supabase. Código: RECOVERY_SECRET" }, 502);
          }
          if (!mailResult) {
            return json({ error: "Apps Script no devolvió una respuesta válida. Publicá una nueva versión de la aplicación web. Código: RECOVERY_SCRIPT_RESPONSE" }, 502);
          }
          return json({ error: "Apps Script rechazó el envío. Motivo: " + (appError || "respuesta no válida") + ". Código: RECOVERY_MAIL_REJECTED" }, 502);
        }
      } catch (mailError) {
        console.error("Recovery email request could not reach Apps Script:", mailError);
        return json({ error: "No se pudo conectar con Google Apps Script. Verificá APPS_SCRIPT_URL y la implementación de la aplicación web. Código: RECOVERY_MAIL_CONNECTION" }, 502);
      }
    }

    return json({ ok: true, message: genericMessage });
  } catch (error) {
    console.error("Recovery request failed:", error);
    return json({ error: "No pudimos procesar la solicitud en este momento." }, 500);
  }
});
