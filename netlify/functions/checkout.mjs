import { handleCheckout } from "../../lib/portal.mjs";

export default async (req, context) => {
  const h = { "cache-control": "no-store" };
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers: h });
  let body;
  try { const t = await req.text(); if (t.length > 2000) throw 0; body = JSON.parse(t); } catch { return Response.json({ error: "Bad request" }, { status: 400, headers: h }); }
  const site = (process.env.SITE_URL || process.env.URL || new URL(req.url).origin).replace(/\/$/, "");
  try {
    const r = await handleCheckout(body, { ip: context?.ip || req.headers.get("x-nf-client-connection-ip") || "?", site });
    return Response.json(r.json, { status: r.status, headers: h });
  } catch (e) {
    console.error("checkout failed:", e.message);
    return Response.json({ error: "Something went wrong. Please try again in a minute." }, { status: 500, headers: h });
  }
};

export const config = {
  path: "/api/checkout",
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
