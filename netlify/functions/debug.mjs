import { getStore } from "@netlify/blobs";

const WABA = "1839792817160030";
const G = "https://graph.facebook.com/v21.0";
const MEU_ENDERECO = "https://shimmering-mousse-b5f43f.netlify.app/webhook";

async function chamar(url, opts) {
  try {
    const r = await fetch(url, opts);
    const t = await r.text();
    return r.status + " " + t.slice(0, 600);
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
    const hj = { ...h, "content-type": "application/json" };
    let out = "SAUDE\nWA_PHONE_ID: " + id + "\n";
    out += "token: " + (tk ? tk.length + " caracteres, comeca com " + tk.slice(0, 3) : "NAO EXISTE") + "\n\n";

    if (saude === "corrigir") {
      out +=
        "1) ASSINAR APP NA CONTA:\n" +
        (await chamar(`${G}/${WABA}/subscribed_apps`, {
          method: "POST",
          headers: hj,
          body: JSON.stringify({
            override_callback_uri: MEU_ENDERECO,
            verify_token: process.env.VERIFY_TOKEN,
          }),
        })) +
        "\n\n2) GRAVAR ENDERECO NO NUMERO:\n" +
        (await chamar(`${G}/${id}`, {
          method: "POST",
          headers: hj,
          body: JSON.stringify({
            webhook_configuration: {
              override_callback_uri: MEU_ENDERECO,
              verify_token: process.env.VERIFY_TOKEN,
            },
          }),
        })) +
        "\n\n";
    }

    out +=
      "NUMERO:\n" +
      (await chamar(`${G}/${id}?fields=display_phone_number,verified_name,quality_rating`, { headers: h })) +
      "\n\nNUMERO (detalhes):\n" +
      (await chamar(`${G}/${id}?fields=status,platform_type,account_mode,webhook_configuration`, { headers: h })) +
      "\n\nAPPS NA CONTA:\n" +
      (await chamar(`${G}/${WABA}/subscribed_apps`, { headers: h }));
    return txt(out);
  }

  const s = getStore("debug");
  const log = (await s.get("log", { type: "json" })) || [];
  const u = (await s.get("ultimo")) || "processamento: nada registrado";
  return txt(
    "EVENTOS RECEBIDOS (mais novo primeiro)\n" +
      (log.length ? log.join("\n") : "nenhum") +
      "\n\nPROCESSAMENTO\n" +
      u
  );
};

export const config = { path: "/debug" };
