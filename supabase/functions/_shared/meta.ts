const GRAPH_API_VERSION = "v26.0";

export interface MetaEventInput {
  eventName: "InitiateCheckout" | "Purchase";
  eventId: string;
  email: string;
  eventSourceUrl: string;
  clientUserAgent: string;
  clientIpAddress?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  value: number;
  currency: string;
  orderId?: string;
  eventTime?: number;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function cleanEventUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new Error("La URL del evento Meta no es válida.");
  }
}

export async function sendMetaEvent(input: MetaEventInput) {
  const accessToken = Deno.env.get("META_ACCESS_TOKEN") || "";
  const pixelId = Deno.env.get("META_PIXEL_ID") || "";
  if (!accessToken || !pixelId) {
    throw new Error("Falta configurar META_ACCESS_TOKEN o META_PIXEL_ID.");
  }
  if (!input.eventId || input.eventId.length > 100) {
    throw new Error("El identificador del evento Meta no es válido.");
  }
  if (!input.email || !input.clientUserAgent || !input.eventSourceUrl) {
    throw new Error("Faltan datos obligatorios para el evento web de Meta.");
  }

  const userData: Record<string, unknown> = {
    em: [await sha256Hex(input.email.trim().toLowerCase())],
    client_user_agent: input.clientUserAgent.slice(0, 500),
  };
  if (input.clientIpAddress) userData.client_ip_address = input.clientIpAddress.slice(0, 64);
  if (input.fbp) userData.fbp = input.fbp.slice(0, 255);
  if (input.fbc) userData.fbc = input.fbc.slice(0, 255);

  const customData: Record<string, unknown> = {
    value: input.value,
    currency: input.currency,
    content_name: "Pack digital: El negocio de la seguridad electrónica",
    content_type: "product",
    content_ids: ["ntec-guia-seguridad-electronica"],
    num_items: 1,
  };
  if (input.orderId) customData.order_id = input.orderId;

  const event = {
    event_name: input.eventName,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: "website",
    event_source_url: cleanEventUrl(input.eventSourceUrl),
    user_data: userData,
    custom_data: customData,
  };

  const body: Record<string, unknown> = { data: [event] };
  const testEventCode = Deno.env.get("META_TEST_EVENT_CODE") || "";
  if (testEventCode) body.test_event_code = testEventCode;

  const endpoint = "https://graph.facebook.com/" + GRAPH_API_VERSION + "/" +
    encodeURIComponent(pixelId) + "/events?access_token=" + encodeURIComponent(accessToken);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || result?.error ||
      (typeof result?.events_received === "number" && result.events_received < 1)) {
    const detail = result?.error?.message || result?.error?.error_user_msg ||
      "Meta no confirmó la recepción del evento.";
    throw new Error("Meta Conversions API (" + response.status + "): " + String(detail).slice(0, 400));
  }

  return result;
}
