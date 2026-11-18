/**
 * Soluciones NTEC — entrega automática de compras
 *
 * Implementación como Google Apps Script Web App.
 * El endpoint solo envía enlaces de acceso; los PDF siguen en el bucket privado
 * y la tienda valida nuevamente email + pedido aprobado antes de entregar.
 *
 * CONFIGURACIÓN INICIAL:
 * 1) Ejecutá setupSecret() UNA sola vez desde el editor de Apps Script.
 * 2) Copiá APPS_SCRIPT_SECRET desde el registro de ejecución.
 * 3) Desplegá como Aplicación web: ejecutar como tu cuenta; acceso: cualquiera.
 * 4) Guardá la URL de la aplicación y el mismo secreto en Supabase Secrets:
 *    APPS_SCRIPT_URL y APPS_SCRIPT_SECRET.
 */

const STORE_URL = "https://solucionesntec.github.io/solucionesntec-guia-digital/";
const SECRET_PROPERTY = "APPS_SCRIPT_SECRET";
const SENT_PREFIX = "NTEC_EMAIL_SENT_";

function authorizeMail() {
  const remaining = MailApp.getRemainingDailyQuota();
  Logger.log("Permiso de correo autorizado. Destinatarios disponibles hoy: " + remaining);
}

function setupSecret() {
  const secret = Utilities.getUuid() + "-" + Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(SECRET_PROPERTY, secret);
  Logger.log("Copiá este valor a Supabase como APPS_SCRIPT_SECRET. No lo compartas:");
  Logger.log(secret);
}

function doGet() {
  return jsonOutput_({
    ok: true,
    service: "Soluciones NTEC email delivery",
    message: "Servicio de correo activo."
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonOutput_({ ok: false, error: "El servicio está ocupado. Reintentá en unos segundos." });
  }

  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(raw);

    const expectedSecret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY) || "";
    const suppliedSecret = String(payload.secret || "");
    if (!expectedSecret || !constantTimeEqual_(suppliedSecret, expectedSecret)) {
      return jsonOutput_({ ok: false, error: "No autorizado." });
    }

    const email = String(payload.email || "").trim().toLowerCase();
    const orderId = String(payload.order_id || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return jsonOutput_({ ok: false, error: "El correo del comprador no es válido." });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      return jsonOutput_({ ok: false, error: "La referencia del pedido no es válida." });
    }

    const props = PropertiesService.getScriptProperties();
    const sentKey = SENT_PREFIX + orderId;
    if (props.getProperty(sentKey)) {
      return jsonOutput_({ ok: true, duplicate: true });
    }

    const accessUrl = STORE_URL + "?access=" + encodeURIComponent(orderId);
    const subject = "Tu compra está lista — Soluciones NTEC";
    const body =
      "¡Gracias por tu compra!\n\n" +
      "Ya podés acceder a los 7 materiales digitales de Soluciones NTEC.\n\n" +
      "Abrí este enlace: " + accessUrl + "\n\n" +
      "Ingresá el mismo correo que utilizaste al comprar para validar tu pedido y descargar los archivos.\n\n" +
      "Si no podés acceder, respondé este correo o escribinos a solucionesntec@gmail.com.\n\n" +
      "Soluciones NTEC — Seguridad y Tecnología";

    const safeEmail = escapeHtml_(email);
    const safeUrl = escapeHtml_(accessUrl);
    const htmlBody =
      '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:600px;margin:auto">' +
      '<h2 style="color:#0b2442">¡Tu compra está lista!</h2>' +
      '<p>Gracias por comprar <strong>El negocio de la seguridad electrónica</strong>.</p>' +
      '<p>Ya tenés disponible tu pack completo: <strong>1 guía principal + 6 bonos digitales</strong>.</p>' +
      '<p style="margin:28px 0"><a href="' + safeUrl + '" style="background:#e9b949;color:#171717;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">ACCEDER A MIS 7 MATERIALES</a></p>' +
      '<p>Al abrir el enlace, ingresá <strong>' + safeEmail + '</strong>, el mismo correo que utilizaste al comprar, para validar tu pedido y descargar los siete archivos.</p>' +
      '<p>¿No podés acceder? Escribinos a <a href="mailto:solucionesntec@gmail.com">solucionesntec@gmail.com</a>.</p>' +
      '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">' +
      '<p style="font-size:13px;color:#667085">Soluciones NTEC · Seguridad y Tecnología</p></div>';

    MailApp.sendEmail({
      to: email,
      subject: subject,
      body: body,
      htmlBody: htmlBody,
      name: "Soluciones NTEC"
    });

    props.setProperty(sentKey, new Date().toISOString());
    return jsonOutput_({ ok: true, duplicate: false });
  } catch (error) {
    console.error("NTEC email delivery error", error);
    return jsonOutput_({
      ok: false,
      error: error && error.message ? String(error.message) : "No se pudo enviar el correo."
    });
  } finally {
    lock.releaseLock();
  }
}

function constantTimeEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml_(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character];
  });
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
