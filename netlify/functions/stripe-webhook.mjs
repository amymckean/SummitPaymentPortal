import { handleEvent, signatureOk } from "../../lib/webhook.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text(); // the signature covers the exact raw body
  if (!signatureOk(raw, req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) return new Response("bad signature", { status: 400 });
  try {
    const r = await handleEvent(JSON.parse(raw));
    return new Response(r.note, { status: r.status });
  } catch (e) {
    console.error("webhook failed:", e.message);
    return new Response("error", { status: 500 }); // Stripe will retry
  }
};

export const config = { path: "/api/stripe-webhook" };
