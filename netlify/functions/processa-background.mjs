import { getStore } from "@netlify/blobs";
import { PROMPT } from "./prompt.mjs";

const {
  WA_TOKEN,
  WA_PHONE_ID,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = "claude-haiku-5-5",
  NUVEM_STORE_ID,
  NUVEM_TOKEN,
  NUMERO_DONA,
} = process.env;

const historico = () => getStore("historico");
const pausados = () => getStore("pausados");
const vistos = () => getStore("vistos");
const cache = () => getStore("cache");
const debugStore = () => getStore("debug");

const trilha = [];
const erroOriginal = console.error;
console.error = (...a) => {
  erroOriginal(...a);
  trilha.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};

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

async function catalogo() {
  const c = await cache().get("catalogo", { type: "json" });
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.texto;

  if (!NUVEM_STORE_ID || !NUVEM_TOKEN) return "(catalogo ainda nao conectado)";

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

function janela(hist) {
  const h = hist.slice(-20);
  while (h.length && h[0].role !== "user") h.shift();
  return h;
}

async function perguntarIA(hist, catalogoTexto) {
  const system =
    PROMPT +
    "\n\nCATALOGO ATUAL (so ofereca o que esta aqui):\n" +
    catalogoTexto +
    "\n\nSe precisar chamar a dona da loja, inclua no fim da resposta exatamente: [CHAMAR_DONA]";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system,
      messages: janela(hist),
    }),
  });
  const j = await r.json();
  if (!r.ok) console.error("Erro Claude:", r.status, JSON.stringify(j));
  return (
    j?.content?.find((b) => b.type === "text")?.text ||
    "Vou chamar a responsavel para te atender. Um minuto. [CHAMAR_DONA]"
  );
}

async function principal(req) {
  const data = await req.json().catch(() => null);
  const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg || msg.type !== "text") return;

  trilha.push("mensagem recebida");

  if (await vistos().get(msg.id)) return;
  await vistos().set(msg.id, "1");

  const numero = msg.from;
  const texto = msg.text.body;

  if (await pausados().get(numero)) {
    trilha.push("conversa pausada (esta com a dona)");
    return;
  }

  const hist = (await historico().get(numero, { type: "json" })) || [];
  hist.push({ role: "user", content: texto });

  let resposta = await perguntarIA(hist, await catalogo());

  const chamar = resposta.includes("[CHAMAR_DONA]");
  resposta = resposta.replace("[CHAMAR_DONA]", "").trim();

  hist.push({ role: "assistant", content: resposta });
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
  trilha.push("fim do processamento");
}

export default async (req) => {
  trilha.length = 0;
  const faltando = ["WA_TOKEN", "WA_PHONE_ID", "ANTHROPIC_API_KEY"].filter((n) => !process.env[n]);
  if (faltando.length) trilha.push("Variaveis vazias: " + faltando.join(", "));
  try {
    await principal(req);
  } catch (e) {
    trilha.push("EXCECAO: " + e.message);
  }
  if (trilha.length) {
    await debugStore().set(
      "ultimo",
      new Date().toISOString() + "\n" + trilha.join("\n").slice(0, 3000)
    );
  }
};
