import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok =
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === process.env.VERIFY_TOKEN;
    return ok
      ? new Response(url.searchParams.get("hub.challenge"), { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  const body = await req.text();

  let resumo = "";
  try {
    const j = JSON.parse(body);
    const ch = j.entry?.[0]?.changes?.[0];
    const v = ch?.value;
    const m = v?.messages?.[0];
    resumo =
      "campo=" + ch?.field +
      (v?.metadata?.display_phone_number ? " para=" + v.metadata.display_phone_number : "") +
      (m ? " tipo=" + m.type + " de=" + m.from : "") +
      (v?.statuses?.[0] ? " status=" + v.statuses[0].status : "") +
      (v?.event ? " evento=" + v.event : "");
  } catch (e) {
    resumo = "corpo ilegivel";
  }

  let status = "";
  try {
    const r = await fetch(`${url.origin}/.netlify/functions/processa-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    status = "background " + r.status;
  } catch (e) {
    status = "background falhou: " + e.message;
  }

  try {
    const s = getStore("debug");
    const log = (await s.get("log", { type: "json" })) || [];
    log.unshift(new Date().toISOString() + " | " + resumo + " | " + status);
    await s.setJSON("log", log.slice(0, 15));
  } catch (e) {}

  return new Response("ok", { status: 200 });
};

export const config = { path: "/webhook" };
