import { getStore } from "@netlify/blobs";
import { PROMPT } from "./prompt.mjs";

const {
  WA_TOKEN,
  WA_PHONE_ID,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.0-flash",
  NUVEM_STORE_ID,
  NUVEM_TOKEN,
  NUMERO_DONA, // WhatsApp da dona da loja, so digitos, ex: 5583999999999
} = process.env;

const historico = () => getStore("historico");
const pausados = () => getStore("pausados");
const vistos = () => getStore("vistos");
const cache = () => getStore("cache");

async function enviarWhatsApp(para, texto) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "text",
      text: { body: texto },
    }),
  });
  if (!r.ok) console.error("Erro WhatsApp:", r.status, await r.text());
}

// Catalogo da Nuvemshop, com cache de 5 minutos
async function catalogo() {
  const c = await cache().get("catalogo", { type: "json" });
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.texto;

  const r = await fetch(
    `https://api.nuvemshop.com.br/v1/${NUVEM_STORE_ID}/products?published=true&per_page=100`,
    {
      headers: {
        Authentication: `bearer ${NUVEM_TOKEN}`,
        "User-Agent": "Wanessa (contato@loja.com)",
      },
    }
  );
  if (!r.ok) {
    console.error("Erro Nuvemshop:", r.status, await r.text());
    return c?.texto || "(catalogo indisponivel no momento)";
  }
  const produtos = await r.json();

  const texto = produtos
    .map((p) => {
      const variacoes = (p.variants || [])
        .filter((v) => v.stock === null || v.stock > 0)
        .map(
          (v) =>
            `${(v.values || []).map((x) => x.pt).join(" ")} (R$ ${v.promotional_price || v.price})`
        )
        .join("; ");
      return `- ${p.name?.pt} | ${variacoes || "ESGOTADO"} | ${p.canonical_url}`;
    })
    .join("\n");

  await cache().setJSON("catalogo", { t: Date.now(), texto });
  return texto;
}

async function perguntarIA(hist, catalogoTexto) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                PROMPT +
                "\n\nCATALOGO ATUAL (so ofereca o que esta aqui):\n" +
                catalogoTexto +
                "\n\nSe precisar chamar a dona da loja, inclua no fim da resposta exatamente: [CHAMAR_DONA]",
            },
          ],
        },
        contents: hist,
      }),
    }
  );
  const j = await r.json();
  if (!r.ok) console.error("Erro Gemini:", r.status, JSON.stringify(j));
  return (
    j?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Vou chamar a responsavel para te atender. Um minuto. [CHAMAR_DONA]"
  );
}

export default async (req) => {
  const data = await req.json().catch(() => null);
  const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg || msg.type !== "text") return; // v1: ignora status, audio, imagem

  // evita processar a mesma mensagem duas vezes
  if (await vistos().get(msg.id)) return;
  await vistos().set(msg.id, "1");

  const numero = msg.from;
  const texto = msg.text.body;

  // se a conversa esta com a dona, a Wanessa fica quieta
  if (await pausados().get(numero)) return;

  const hist = (await historico().get(numero, { type: "json" })) || [];
  hist.push({ role: "user", parts: [{ text: texto }] });

  let resposta = await perguntarIA(hist.slice(-20), await catalogo());

  const chamar = resposta.includes("[CHAMAR_DONA]");
  resposta = resposta.replace("[CHAMAR_DONA]", "").trim();

  hist.push({ role: "model", parts: [{ text: resposta }] });
  await historico().setJSON(numero, hist.slice(-20));

  await enviarWhatsApp(numero, resposta);

  if (chamar) {
    await pausados().set(numero, "1");
    if (NUMERO_DONA) {
      await enviarWhatsApp(
        NUMERO_DONA,
        `Cliente precisa de atendimento: wa.me/${numero}\nUltima mensagem: ${texto}`
      );
    }
  }
};
