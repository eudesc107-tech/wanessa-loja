import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== process.env.VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }
  const v = await getStore("debug").get("ultimo");
  return new Response(v || "nada registrado ainda", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

export const config = { path: "/debug" };
