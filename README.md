# Tienda digital Soluciones NTEC

Landing de la guía digital **El negocio de la seguridad electrónica** (ARS $14.900), con Checkout Pro y entrega privada del PDF.

## Archivos incluidos

- `index.html`, `config.js`, `app.js`: frontend estático.
- `supabase/migrations/202611170001_create_orders.sql`: tabla privada de pedidos y bucket privado.
- `supabase/functions/create-checkout`: crea el pedido y la preferencia de Mercado Pago.
- `supabase/functions/mp-webhook`: valida firma, consulta el pago y aprueba el pedido.
- `supabase/functions/deliver-guide`: genera un enlace firmado temporal solo para pedidos aprobados.

## Configuración pendiente (no vender hasta completar)

Proyecto Supabase: `ddpnouenuwmwufsjosng`  
URL: `https://ddpnouenuwmwufsjosng.supabase.co`

### 1. Supabase

1. En SQL Editor ejecutá `supabase/migrations/202611170001_create_orders.sql`.
2. En Storage confirmá que el bucket `guias` sea privado.
3. Subí al bucket `guias` el PDF con este nombre exacto:
   `01_Guia_Profesional_Seguridad_Electronica_actualizada.pdf`
4. En Project Settings → API copiá la publishable key (o anon legacy key) y pegala en `config.js`. Nunca uses la service-role key en el navegador.
5. Desplegá las Edge Functions con Supabase CLI:
   ```bash
   supabase login
   supabase link --project-ref ddpnouenuwmwufsjosng
   supabase functions deploy create-checkout --no-verify-jwt
   supabase functions deploy mp-webhook --no-verify-jwt
   supabase functions deploy deliver-guide --no-verify-jwt
   ```
6. Configurá secrets de las funciones:
   - `MP_ACCESS_TOKEN`: Access Token privado de Mercado Pago.
   - `MP_WEBHOOK_SECRET`: firma secreta de Webhooks.
   - `SITE_URL`: URL HTTPS final de la landing, sin barra final.
   - `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio privada, solo si no está ya disponible automáticamente en el entorno Edge Functions de tu proyecto.
   
   Supabase normalmente proporciona `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno de funciones. No las expongas ni las subas a GitHub.

### 2. Envío automático de correos (Google Apps Script)

El archivo `apps-script/Code.gs` contiene el servicio que envía el correo al comprador con un enlace seguro de acceso a sus siete materiales.

1. Abrí [script.google.com](https://script.google.com/) con la cuenta de Google desde la que querés enviar los correos.
2. Creá un proyecto nuevo, reemplazá el contenido de `Code.gs` por el contenido de `apps-script/Code.gs` de este repositorio y guardá.
3. Desde el editor, ejecutá `setupSecret()` una sola vez y autorizá los permisos. Copiá el secreto que aparece en el registro de ejecución; no lo publiques ni lo compartas.
4. En **Implementar → Nueva implementación → Aplicación web**, elegí **Ejecutar como: yo** y **Quién tiene acceso: cualquier persona**. Implementá y copiá la URL de la aplicación web que termina en `/exec`.
5. En Supabase → Edge Functions → Secrets, configurá:
   - `APPS_SCRIPT_URL`: URL de la aplicación web publicada.
   - `APPS_SCRIPT_SECRET`: el secreto generado en el paso 3.
6. Abrí la URL `/exec` en el navegador. Debe responder que el servicio de correo está activo.

El correo contiene un enlace a la tienda. Los archivos no se adjuntan: la página vuelve a validar el pedido y el correo del comprador antes de habilitar descargas temporales desde el bucket privado.

### 2. Mercado Pago

1. En Tus integraciones, seleccioná o creá la aplicación de Checkout Pro.
2. Empezá con credenciales de prueba; para producción usá el Access Token productivo.
3. Configurá Webhooks para eventos de pago y copiá la firma secreta.
4. URL de notificación:
   `https://ddpnouenuwmwufsjosng.supabase.co/functions/v1/mp-webhook`
5. Probá una compra completa antes de habilitar ventas reales.

### 3. Publicación

Publicá la rama `main` en GitHub Pages o en tu hosting. Configurá `SITE_URL` con el dominio HTTPS exacto.

## Controles de seguridad

- Precio fijado en servidor: ARS 14.900.
- El navegador no puede declarar un pago aprobado.
- El webhook valida HMAC y consulta el pago directamente a Mercado Pago.
- Se comprueba estado aprobado, moneda, importe y referencia de pedido.
- No hay políticas RLS de lectura o escritura pública sobre pedidos.
- El PDF queda en bucket privado y el enlace firmado vence en 20 minutos.
- No subir el PDF pago, tokens, firma webhook ni service-role key al repositorio.

## Checklist antes de producción

- [ ] Configurar la publishable/anon key en `config.js`.
- [ ] Ejecutar la migración SQL.
- [ ] Subir el PDF al bucket privado con el nombre exacto.
- [ ] Desplegar las tres Edge Functions.
- [ ] Configurar secrets y webhook de Mercado Pago.
- [ ] Configurar el dominio HTTPS y `SITE_URL`.
- [ ] Completar una compra de prueba y comprobar que un pago pendiente/rechazado no entregue el PDF.
