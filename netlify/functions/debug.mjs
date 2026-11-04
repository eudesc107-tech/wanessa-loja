import { getStore } from "@netlify/blobs";

const WABA = "1839792817160030";

async function chamar(url, opts) {
  try {
    const r = await fetch(url, opts);
    const t = await r.text();
    return r.status + " " + t.slice(0, 400);
  } catch (e) {
    return "falhou: " + e.message;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== process.env.VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }
  const txt = (s) =>
    new Response(s, { headers: { "content-type": "text/plain; charset=utf-8" } });

  const reset = url.searchParams.get("reset");
  if (reset) {
    await getStore("historico").delete(reset);
    await getStore("pausados").delete(reset);
    return txt("historico e pausa limpos para " + reset);
  }

  const saude = url.searchParams.get("saude");
  if (saude) {
    const tk = process.env.WA_TOKEN || "";
    const id = process.env.WA_PHONE_ID || "";
    const h = { Authorization: `Bearer ${tk}` };
    let out = "SAUDE\n";
    out += "WA_PHONE_ID: " + id + "\n";
    out += "token: " + (tk ? tk.length + " caracteres, comeca com " + tk.slice(0, 3) : "NAO EXISTE") + "\n\n";
    out +=
      "NUMERO:\n" +
      (await chamar(
        `https://graph.facebook.com/v21.0/${id}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: h }
      )) +
      "\n\n";
    if (saude === "assinar") {
      out +=
        "ASSINANDO O APP NA CONTA:\n" +
        (await chamar(`https://graph.facebook.com/v21.0/${WABA}/subscribed_apps`, {
          method: "POST",
          headers: h,
        })) +
        "\n\n";
    }
    out +=
      "APPS ASSINADOS NA CONTA:\n" +
      (await chamar(`https://graph.facebook.com/v21.0/${WABA}/subscribed_apps`, { headers: h }));
    return txt(out);
  }

  const s = getStore("debug");
  const w = (await s.get("webhook")) || "webhook: nada recebido";
  const u = (await s.get("ultimo")) || "processamento: nada registrado";
  return txt("WEBHOOK\n" + w + "\n\nPROCESSAMENTO\n" + u);
};

export const config = { path: "/debug" };
