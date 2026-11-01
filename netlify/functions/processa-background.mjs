import { getStore } from "@netlify/blobs";
import { PROMPT } from "./prompt.mjs";

const {
  WA_TOKEN,
  WA_PHONE_ID,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = "claude-haiku-5-5",
  NUVEM_STORE_ID,
  NUVEM_TOKEN,
  SHEET_URL,
  SHEET_SECRET,
} = process.env;

const historico = () => getStore("historico");
const vistos = () => getStore("vistos");
const cache = () => getStore("cache");
const debugStore = () => getStore("debug");

const trilha = [];
const erroOriginal = console.error;
console.error = (...a) => {
  erroOriginal(...a);
  trilha.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const brl = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",").replace(",00", "");

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

async function fichaLer(telefone) {
  if (!SHEET_URL) return null;
  try {
    const u = `${SHEET_URL}?senha=${encodeURIComponent(SHEET_SECRET || "")}&telefone=${telefone}`;
    const r = await fetch(u);
    const j = await r.json();
    return j.encontrado ? j : null;
  } catch (e) {
    console.error("Erro planilha (ler):", e.message);
    return null;
  }
}

async function fichaSalvar(telefone, dados) {
  if (!SHEET_URL) return;
  try {
    const r = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ senha: SHEET_SECRET, telefone, ...dados }),
    });
    if (!r.ok) console.error("Erro planilha (salvar):", r.status);
  } catch (e) {
    console.error("Erro planilha (salvar):", e.message);
  }
}

async function catalogo() {
  const c = await cache().get("catalogo_v2", { type: "json" });
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
      const disponiveis = (p.variants || []).filter(
        (v) => v.stock === null || v.stock === undefined || Number(v.stock) > 0
      );
      if (!disponiveis.length) return `- ${p.name?.pt} | ESGOTADO | ${p.canonical_url}`;

      const v0 = disponiveis[0];
      const regular = Number(v0.price);
      const promo = v0.promotional_price ? Number(v0.promotional_price) : null;
      const preco = promo && promo < regular
        ? `de ${brl(regular)} por ${brl(promo)}`
        : brl(regular);

      const opcoes = disponiveis
        .map((v) => {
          const nome = (v.values || []).map((x) => x.pt).join(" ") || "único";
          const est = v.stock === null || v.stock === undefined ? "" : ` (${v.stock} un)`;
          return nome + est;
        })
        .join(", ");

      const desc = (p.description?.pt || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);

      return `- ${p.name?.pt} | ${preco} | opções: ${opcoes} | ${p.canonical_url}${desc ? " | descrição: " + desc : ""}`;
    })
    .join("\n");

  await cache().setJSON("catalogo_v2", { t: Date.now(), texto });
  return texto;
}

function janela(hist) {
  const h = hist.slice(-20);
  while (h.length && h[0].role !== "user") h.shift();
  return h;
}

async function perguntarIA(hist, catalogoTexto, ficha) {
  const fichaTexto = ficha
    ? `FICHA DESTA CLIENTE (ja conversou antes): nome ${ficha.nome || "nao informado"}, status ${ficha.status || "em conversa"}, primeira compra ${ficha.primeira_compra || "nao informado"}, interesse ${ficha.interesse || "nao informado"}, ultima conversa ${ficha.ultima || "nao informado"}.`
    : "FICHA DESTA CLIENTE: cliente nova, sem registro.";

  const system =
    PROMPT +
    "\n\nCATALOGO ATUAL (so use o que esta aqui):\n" +
    catalogoTexto +
    "\n\n" +
    fichaTexto;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system,
      messages: janela(hist),
    }),
  });
  const j = await r.json();
  if (!r.ok) console.error("Erro Claude:", r.status, JSON.stringify(j));

  const texto = j?.content?.find((b) => b.type === "text")?.text;
  if (!texto) {
    console.error("Claude sem texto:", r.status, j?.stop_reason, JSON.stringify(j).slice(0, 400));
  }
  return texto || null;
}

function separarFicha(bruto) {
  const m = bruto.match(/\[\[FICHA([^\]]*)\]\]/);
  let dados = null;
  if (m) {
    dados = {};
    for (const par of m[1].split("|")) {
      const i = par.indexOf("=");
      if (i > 0) dados[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    }
  }
  return { texto: bruto.replace(/\[\[FICHA[^\]]*\]\]/g, "").trim(), dados };
}

function partes(texto) {
  const p = texto.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (p.length > 4) return [...p.slice(0, 3), p.slice(3).join("\n\n")];
  return p;
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

  const hist = (await historico().get(numero, { type: "json" })) || [];
  hist.push({ role: "user", content: texto });

  const ficha = await fichaLer(numero);
  trilha.push("ficha: " + (ficha ? JSON.stringify(ficha).slice(0, 150) : "cliente nova"));

  const cat = await catalogo();
  trilha.push("catalogo: " + cat.slice(0, 120).replace(/\n/g, " | "));

  const bruto = await perguntarIA(hist, cat, ficha);
  if (!bruto) {
    await enviarWhatsApp(numero, "Deu um probleminha aqui. Pode me mandar de novo?");
    trilha.push("falha tecnica ao responder");
    return;
  }

  const { texto: resposta, dados } = separarFicha(bruto);
  hist.push({ role: "assistant", content: resposta });
  await historico().setJSON(numero, hist.slice(-20));
  trilha.push("resposta: " + resposta.slice(0, 150));

  const blocos = partes(resposta);
  await espera(1200);
  for (let i = 0; i < blocos.length; i++) {
    if (i > 0) await espera(Math.min(2500, 800 + blocos[i].length * 20));
    await enviarWhatsApp(numero, blocos[i]);
  }

  await fichaSalvar(numero, dados || {});
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
