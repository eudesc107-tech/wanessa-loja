export default async (req) => {
  const url = new URL(req.url);

  // Verificacao do webhook (GET)
  if (req.method === "GET") {
    const ok =
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === process.env.VERIFY_TOKEN;
    return ok
      ? new Response(url.searchParams.get("hub.challenge"), { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  // Mensagens (POST): dispara a funcao background e responde 200 rapido
  const body = await req.text();
  try {
    await fetch(`${url.origin}/.netlify/functions/processa-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (e) {
    console.error("Erro ao chamar background:", e);
  }

  return new Response("ok", { status: 200 });
};

export const config = { path: "/webhook" };
