import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== process.env.VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }
  const reset = url.searchParams.get("reset");
  if (reset) {
    await getStore("historico").delete(reset);
    await getStore("pausados").delete(reset);
    return new Response("historico e pausa limpos para " + reset);
  }
  const s = getStore("debug");
  const w = (await s.get("webhook")) || "webhook: nada recebido";
  const u = (await s.get("ultimo")) || "processamento: nada registrado";
  return new Response("WEBHOOK\n" + w + "\n\nPROCESSAMENTO\n" + u, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

export const config = { path: "/debug" };
