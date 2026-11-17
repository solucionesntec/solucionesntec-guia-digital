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
        if (Array.isArray(result.downloads) && result.downloads.length === 7) {
          show("Pago confirmado. Ya podés descargar los siete archivos de tu compra.");
          const list = document.createElement("div");
          list.style.display = "grid";
          list.style.gap = "10px";
          list.style.marginTop = "18px";
          result.downloads.forEach((file, index) => {
            const link = document.createElement("a");
            link.href = file.download_url;
            link.textContent = (index + 1) + ". " + file.name + " — Descargar PDF";
            link.className = "btn primary";
            link.style.display = "block";
            link.style.textAlign = "left";
            link.style.overflowWrap = "anywhere";
            link.target = "_blank";
            link.rel = "noopener";
            list.appendChild(link);
          });
          statusBox.appendChild(list);
          sessionStorage.removeItem("ntec_buyer_email");
          localStorage.removeItem("ntec_buyer_email");
          return;
        }
        throw new Error("No se pudieron preparar los siete archivos.");
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
    const email = localStorage.getItem("ntec_buyer_email") || sessionStorage.getItem("ntec_buyer_email");
    if (email && validConfig()) {
      deliverWhenApproved(orderId, email);
    } else {
      show("Ingresá el mismo correo que usaste al pagar y tocá el botón de recuperación para validar tu compra.", true);
      if (emailInput) {
        emailInput.value = "";
        emailInput.placeholder = "Correo usado al pagar";
      }
      if (buyButton) {
        buyButton.textContent = "Recuperar mi compra";
        buyButton.disabled = false;
      }
    }
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
      if (paymentStatus === "success" && orderId) {
        sessionStorage.setItem("ntec_buyer_email", email);
        localStorage.setItem("ntec_buyer_email", email);
        deliverWhenApproved(orderId, email);
        return;
      }
      buyButton.textContent = "Preparando pago…";
      try {
        sessionStorage.setItem("ntec_buyer_email", email);
        localStorage.setItem("ntec_buyer_email", email);
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
