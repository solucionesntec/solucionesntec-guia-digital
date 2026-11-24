(() => {
  "use strict";

  const PIXEL_ID = "9697363423621125";
  const CONSENT_KEY = "ntec_meta_consent_v1";
  const CONSENT_MAX_AGE_DAYS = 180;
  const sentPurchaseEvents = new Set();
  let pageViewSentThisLoad = false;

  const byId = (id) => document.getElementById(id);
  const banner = byId("privacy-consent");
  const mainActions = byId("privacy-main-actions");
  const settingsPanel = byId("privacy-settings");
  const metaToggle = byId("privacy-meta-toggle");

  function getChoice() {
    try {
      const raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || !["accepted", "rejected"].includes(saved.choice) ||
          !Number.isFinite(saved.savedAt)) return null;
      const maxAge = CONSENT_MAX_AGE_DAYS * 86400 * 1000;
      if (Date.now() - saved.savedAt > maxAge) {
        localStorage.removeItem(CONSENT_KEY);
        return null;
      }
      return saved.choice;
    } catch {
      return null;
    }
  }

  function saveChoice(value) {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({
        choice: value,
        savedAt: Date.now()
      }));
    } catch {
      // If storage is unavailable, the current page still honors the in-memory choice.
    }
    document.cookie = CONSENT_KEY + "=" + value +
      "; Max-Age=" + (CONSENT_MAX_AGE_DAYS * 86400) +
      "; Path=/; SameSite=Lax; Secure";
  }

  function expireMetaCookie(name) {
    document.cookie = name + "=; Max-Age=0; Path=/; SameSite=Lax; Secure";
    document.cookie = name + "=; Max-Age=0; Path=/; Domain=" + location.hostname +
      "; SameSite=Lax; Secure";
  }

  function revokePixel() {
    if (typeof window.fbq === "function") {
      window.fbq("consent", "revoke");
    }
    expireMetaCookie("_fbp");
    expireMetaCookie("_fbc");
  }

  function loadPixel() {
    if (typeof window.fbq !== "function") {
      (function(f,b,e,v,n,t,s) {
        if (f.fbq) return;
        n = f.fbq = function() {
          n.callMethod ? n.callMethod.apply(n,arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n;
        n.loaded = true;
        n.version = "2.0";
        n.queue = [];
        t = b.createElement(e);
        t.async = true;
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s);
      })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
      window.fbq("init", PIXEL_ID);
    }
    window.fbq("consent", "grant");
    if (!pageViewSentThisLoad) {
      window.fbq("track", "PageView");
      pageViewSentThisLoad = true;
    }
  }

  function showBanner(openSettings = false) {
    if (!banner) return;
    banner.hidden = false;
    if (mainActions) mainActions.hidden = openSettings;
    if (settingsPanel) settingsPanel.hidden = !openSettings;
    if (metaToggle) metaToggle.checked = getChoice() === "accepted";
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  function applyChoice(value) {
    saveChoice(value);
    if (value === "accepted") loadPixel();
    else revokePixel();
    hideBanner();
    window.dispatchEvent(new CustomEvent("ntec:privacy-choice", { detail: { choice: value } }));
  }

  if (getChoice() === "accepted") {
    loadPixel();
  } else if (getChoice() === "rejected") {
    revokePixel();
  } else {
    showBanner(false);
  }

  byId("privacy-accept")?.addEventListener("click", () => applyChoice("accepted"));
  byId("privacy-reject")?.addEventListener("click", () => applyChoice("rejected"));
  byId("privacy-open-settings")?.addEventListener("click", () => showBanner(true));
  byId("privacy-back")?.addEventListener("click", () => showBanner(false));
  byId("privacy-save-settings")?.addEventListener("click", () =>
    applyChoice(metaToggle && metaToggle.checked ? "accepted" : "rejected")
  );
  byId("privacy-manage")?.addEventListener("click", () => showBanner(true));

  function readCookie(name) {
    const prefix = name + "=";
    const item = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : "";
  }

  window.NTECAnalytics = {
    hasMetaConsent: () => getChoice() === "accepted",
    prepareCheckoutEvent: () => {
      if (getChoice() !== "accepted") return null;
      const eventId = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "ntec-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      return {
        meta_consent: true,
        meta_event_id: eventId,
        meta_fbp: readCookie("_fbp"),
        meta_fbc: readCookie("_fbc"),
        meta_event_source_url: location.href
      };
    },
    trackInitiateCheckout: (payload) => {
      if (getChoice() !== "accepted" || typeof window.fbq !== "function" || !payload) return;
      window.fbq("track", "InitiateCheckout", {
        value: 14900,
        currency: "ARS",
        num_items: 7
      }, { eventID: payload.meta_event_id });
    },
    trackPurchase: (payload) => {
      if (
        getChoice() !== "accepted" ||
        typeof window.fbq !== "function" ||
        !payload ||
        typeof payload.event_id !== "string" ||
        !payload.event_id.startsWith("ntec-purchase-")
      ) return false;

      const value = Number(payload.value);
      const currency = String(payload.currency || "").toUpperCase();
      if (!Number.isFinite(value) || value <= 0 || !/^[A-Z]{3}$/.test(currency)) return false;

      const storageKey = "ntec_meta_purchase_browser_" + payload.event_id;
      try {
        if (localStorage.getItem(storageKey) === "sent") return false;
      } catch {
        // Continue with in-memory deduplication when browser storage is unavailable.
      }
      if (sentPurchaseEvents.has(payload.event_id)) return false;

      window.fbq("track", "Purchase", {
        value,
        currency,
        content_name: "El negocio de la seguridad electrónica",
        content_ids: ["ntec-guia-seguridad-electronica"],
        content_type: "product",
        num_items: 1
      }, { eventID: payload.event_id });

      sentPurchaseEvents.add(payload.event_id);
      try {
        localStorage.setItem(storageKey, "sent");
      } catch {
        // The in-memory Set prevents repeats during this page session.
      }
      return true;
    }
  };
})();