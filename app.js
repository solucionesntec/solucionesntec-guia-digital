(() => {
  const cfg = window.NTEC_CONFIG || {};
  const statusBox = document.getElementById("checkout-status");
  const emailInput = document.getElementById("buyer-email");
  const buyButton = document.getElementById("buy-button");
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get("external_reference") || params.get("order_id");
  const paymentStatus = params.get("status");

  function show(message, isError = false) {
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.style.color = isError ? "#ffb4a9" : "#e9b949";
    statusBox.hidden = false;
  }

  function validConfig() {
    return cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      !cfg.SUPABASE_ANON_KEY.includes("PEGAR_AQUI");
  }

  async function callFunction(name, payload) {
    const response = await fetch(cfg.SUPABASE_URL + "/functions/v1/" + name, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
    return data;
  }

  async function deliverWhenApproved(id, email) {
    show("Estamos verificando tu pago. Esto puede tardar unos segundos…");
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const result = await callFunction("deliver-guide", { order_id: id, email });
        if (result.download_url) {
          show("Pago confirmado. Tu guía está lista.");
          const link = document.createElement("a");
          link.href = result.download_url;
          link.textContent = "Descargar mi guía PDF";
          link.className = "btn primary";
          link.style.marginTop = "14px";
          link.style.display = "inline-block";
          statusBox.appendChild(document.createElement("br"));
          statusBox.appendChild(link);
          sessionStorage.removeItem("ntec_buyer_email");
          return;
        }
      } catch (error) {
        if (!String(error.message).toLowerCase().includes("pendiente")) {
          show(error.message, true);
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    show("Todavía no recibimos la confirmación del pago. No vuelvas a pagar. Actualizá esta página en un minuto o escribinos a contacto@solucionesntec.com.ar.");
  }

  if (paymentStatus === "success" && orderId) {
    const email = sessionStorage.getItem("ntec_buyer_email");
    if (email && validConfig()) deliverWhenApproved(orderId, email);
    else show("Volvé a ingresar el correo usado al comprar y contactanos para validar la entrega.");
  } else if (paymentStatus === "failure") {
    show("El pago no se completó. Podés volver a intentarlo cuando quieras.", true);
  } else if (paymentStatus === "pending") {
    show("Tu pago está pendiente de acreditación. La guía se habilitará cuando Mercado Pago lo confirme.");
  }

  if (buyButton) {
    buyButton.addEventListener("click", async () => {
      const email = (emailInput?.value || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        show("Ingresá un correo electrónico válido para recibir el acceso.", true);
        emailInput?.focus();
        return;
      }
      if (!validConfig()) {
        show("La tienda todavía está en configuración. Volvé a intentarlo más tarde.", true);
        return;
      }
      buyButton.disabled = true;
      buyButton.textContent = "Preparando pago…";
      try {
        sessionStorage.setItem("ntec_buyer_email", email);
        const result = await callFunction("create-checkout", { email });
        if (!result.init_point) throw new Error("Mercado Pago no devolvió el enlace de pago.");
        window.location.assign(result.init_point);
      } catch (error) {
        show(error.message, true);
        buyButton.disabled = false;
        buyButton.textContent = "Comprar por $14.900";
      }
    });
  }
})();
