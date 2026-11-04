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
  ESPERA_MS = "20000",
} = process.env;

const historico = () => getStore("historico");
const vistos = () => getStore("vistos");
const cache = () => getStore("cache");
const debugStore = () => getStore("debug");
const fila = () => getStore({ name: "fila", consistency: "strong" });

const trilha = [];
let semLog = false;
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

// marca como lida e mostra "digitando..." (se a Meta recusar, ignora)
async function sinalizar(msgId) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: msgId,
        typing_indicator: { type: "text" },
      }),
    });
  } catch (e) {}
}

async function baixarMidia(mediaId) {
  const r1 = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  if (!r1.ok) {
    console.error("Erro midia (url):", r1.status, await r1.text());
    return null;
  }
  const meta = await r1.json();
  const r2 = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  if (!r2.ok) {
    console.error("Erro midia (download):", r2.status);
    return null;
  }
  const buf = Buffer.from(await r2.arrayBuffer());
  if (buf.length > 3.5 * 1024 * 1024) {
    console.error("Foto grande demais:", buf.length);
    return null;
  }
  let tipo = (meta.mime_type || "image/jpeg").split(";")[0];
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(tipo)) tipo = "image/jpeg";
  return { tipo, base64: buf.toString("base64") };
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
        "User-Agent": "Wanessa (suporte.lince.intimates@gmail.com)",
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
      const preco =
        promo && promo < regular ? `de ${brl(regular)} por ${brl(promo)}` : brl(regular);

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

      return `- ${p.name?.pt} | ${preco} | opções: ${opcoes} | ${p.canonical_url}${
        desc ? " | descrição: " + desc : ""
      }`;
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

const REGRAS_FOTO = `

QUANDO A CLIENTE MANDA UMA FOTO
Veja a cor e o tipo de peca e procure no catalogo a que mais combina. So diga que e a mesma peca se o nome e a cor baterem claramente. Se nao achar igual, diga em uma frase e ofereca a mais parecida. Se ela perguntar de tamanho, confira no catalogo o estoque daquele tamanho na peca encontrada. Fale so da peca, nunca descreva pessoas nem o corpo de ninguem.`;

const REGRAS_RAJADA = `

A cliente mandou varias mensagens em sequencia, aparecem abaixo, uma por linha. Leia todas juntas e responda UMA vez, seguindo o caminho da conversa. Nao responda cada linha separadamente e nao repita perguntas que ela ja respondeu.`;

async function perguntarIA(hist, catalogoTexto, ficha, imagem, textoAtual, rajada) {
  const fichaTexto = ficha
    ? `FICHA DESTA CLIENTE (ja conversou antes): nome ${ficha.nome || "nao informado"}, status ${ficha.status || "em conversa"}, primeira compra ${ficha.primeira_compra || "nao informado"}, interesse ${ficha.interesse || "nao informado"}, ultima conversa ${ficha.ultima || "nao informado"}.`
    : "FICHA DESTA CLIENTE: cliente nova, sem registro.";

  const system =
    PROMPT +
    "\n\nCATALOGO ATUAL (so use o que esta aqui):\n" +
    catalogoTexto +
    "\n\n" +
    fichaTexto +
    (imagem ? REGRAS_FOTO : "") +
    (rajada ? REGRAS_RAJADA : "");

  const msgs = janela(hist).map((m) => ({ ...m }));
  if (imagem && msgs.length) {
    msgs[msgs.length - 1].content = [
      { type: "image", source: { type: "base64", media_type: imagem.tipo, data: imagem.base64 } },
      { type: "text", text: textoAtual || "A cliente enviou esta foto de uma peca." },
    ];
  }

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
      messages: msgs,
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
      if (i > 0) {
        const v = par.slice(i + 1).trim();
        if (v && !/^(vazio|nenhum|\.\.\.|-)$/i.test(v)) dados[par.slice(0, i).trim()] = v;
      }
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
  if (!msg) return;
  if (!["text", "image", "audio"].includes(msg.type)) return;

  if (await vistos().get(msg.id)) return;
  await vistos().set(msg.id, "1");

  trilha.push("mensagem recebida (" + msg.type + ")");
  const numero = msg.from;
  const agora = Date.now();

  // 1) coloca a mensagem na fila (sem marcar como lida ainda)
  const idCurto = String(msg.id).replace(/[^A-Za-z0-9]/g, "").slice(-10);
  const chave = `${numero}_${String(agora).padStart(13, "0")}_${idCurto}`;
  await fila().setJSON(chave, {
    t: agora,
    tipo: msg.type,
    texto: msg.text?.body || "",
    legenda: msg.image?.caption || "",
    imagemId: msg.image?.id || null,
  });

  // 2) espera para ver se chegam mais mensagens
  await espera(Number(ESPERA_MS) || 20000);

  // 3) so a ULTIMA mensagem da fila continua; as outras desistem
  const { blobs } = await fila().list({ prefix: numero + "_" });
  const chaves = blobs.map((b) => b.key).sort();
  if (!chaves.length || chaves[chaves.length - 1] !== chave) {
    semLog = true;
    return;
  }

  // 4) agora sim: marca como lida e comeca a "digitar"
  await sinalizar(msg.id);

  // 5) le tudo e esvazia a fila
  const itens = [];
  for (const k of chaves) {
    const v = await fila().get(k, { type: "json" });
    if (v && Date.now() - v.t < 5 * 60 * 1000) itens.push(v);
  }
  await Promise.all(chaves.map((k) => fila().delete(k)));
  trilha.push("rajada: " + itens.length + " mensagem(ns) agrupada(s)");

  const textos = itens
    .filter((i) => i.tipo !== "audio")
    .map((i) =>
      i.tipo === "image" ? (i.legenda ? `[foto] ${i.legenda}` : "[foto enviada]") : i.texto
    )
    .filter(Boolean);
  const temAudio = itens.some((i) => i.tipo === "audio");
  const ultimaFoto = [...itens].reverse().find((i) => i.tipo === "image");

  if (!textos.length) {
    if (temAudio) {
      await enviarWhatsApp(numero, "Não consegui ouvir seu áudio por aqui. Pode me escrever?");
      trilha.push("audio: pediu para escrever");
    }
    return;
  }

  let imagem = null;
  if (ultimaFoto?.imagemId) {
    imagem = await baixarMidia(ultimaFoto.imagemId);
    if (!imagem) trilha.push("falha ao baixar foto");
  }

  const combinado = textos.join("\n");

  const hist = (await historico().get(numero, { type: "json" })) || [];
  hist.push({ role: "user", content: combinado });

  const ficha = await fichaLer(numero);
  trilha.push("ficha: " + (ficha ? JSON.stringify(ficha).slice(0, 150) : "cliente nova"));

  const cat = await catalogo();
  trilha.push("catalogo: " + cat.slice(0, 120).replace(/\n/g, " | "));

  const bruto = await perguntarIA(hist, cat, ficha, imagem, combinado, itens.length > 1);
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
  await espera(600);
  for (let i = 0; i < blocos.length; i++) {
    if (i > 0) {
      await sinalizar(msg.id);
      await espera(Math.min(2500, 800 + blocos[i].length * 20));
    }
    await enviarWhatsApp(numero, blocos[i]);
  }

  await fichaSalvar(numero, dados || {});
  trilha.push("fim do processamento");
}

export default async (req) => {
  trilha.length = 0;
  semLog = false;
  const faltando = ["WA_TOKEN", "WA_PHONE_ID", "ANTHROPIC_API_KEY"].filter((n) => !process.env[n]);
  if (faltando.length) trilha.push("Variaveis vazias: " + faltando.join(", "));
  try {
    await principal(req);
  } catch (e) {
    trilha.push("EXCECAO: " + e.message);
    semLog = false;
  }
  if (trilha.length && !semLog) {
    await debugStore().set(
      "ultimo",
      new Date().toISOString() + "\n" + trilha.join("\n").slice(0, 3000)
    );
  }
};
