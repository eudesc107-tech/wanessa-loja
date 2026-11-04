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
  let status = "";
  try {
    const r = await fetch(`${url.origin}/.netlify/functions/processa-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    status = "background respondeu " + r.status;
  } catch (e) {
    status = "background falhou: " + e.message;
  }

  try {
    await getStore("debug").set(
      "webhook",
      new Date().toISOString() + "\n" + status + "\n" + body.slice(0, 800)
    );
  } catch (e) {}

  return new Response("ok", { status: 200 });
};

export const config = { path: "/webhook" };
