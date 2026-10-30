export default async (req) => {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return new Response("Sem code", { status: 400 });

  const r = await fetch("https://www.tiendanube.com/apps/authorize/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.NUVEM_CLIENT_ID,
      client_secret: process.env.NUVEM_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  const j = await r.json();
  return new Response(
    "NUVEM_TOKEN: " + (j.access_token || "erro") +
    "\nNUVEM_STORE_ID: " + (j.user_id || "erro") +
    "\n\n" + (j.access_token ? "" : JSON.stringify(j)),
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
};

export const config = { path: "/nuvem" };
