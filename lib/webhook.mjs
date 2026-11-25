// Stripe webhook: verify the signature and, when a family starts monthly payments, set the date the subscription ends.
import { createHmac, timingSafeEqual } from "node:crypto";
import { sget, spost } from "./stripe.mjs";

export function signatureOk(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSec - t) > tolerance) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  // header may hold several v1 signatures (during secret rotation)
  return header.split(",").filter((p) => p.startsWith("v1=")).some((p) => {
    const got = Buffer.from(p.slice(3)), exp = Buffer.from(want);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

const TAGS = ["org", "team", "player", "payer_name"];
const idOf = (x) => (x && typeof x === "object" ? x.id : x) || "";

/** A subscription's payments don't inherit its metadata, so stamp the family's tags onto each payment's PaymentIntent. */
async function tagInvoicePayment(inv) {
  const subId = idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription);
  if (!subId) return { status: 200, note: "not a subscription invoice" };
  let full = inv;
  try { full = await sget(`invoices/${inv.id}`, { expand: ["payments"] }); } catch { full = await sget(`invoices/${inv.id}`); }
  const pi = idOf(full.payment_intent) || full.payments?.data?.map((p) => idOf(p.payment?.payment_intent)).find(Boolean);
  if (!pi) return { status: 200, note: "no payment on this invoice" };
  const sub = await sget(`subscriptions/${subId}`);
  const tags = Object.fromEntries(TAGS.filter((k) => sub.metadata?.[k]).map((k) => [k, sub.metadata[k]]));
  if (!tags.org) return { status: 200, note: "subscription has no tags" };
  // Name the payment like the portal's other payments: the amount charged when the plan is set up is the catch-up
  // ("Summit Payment" or "Summit Down Payment"); every later charge is the subscription's "Summit Monthly".
  const org = String(tags.org).charAt(0).toUpperCase() + String(tags.org).slice(1).toLowerCase();
  const first = (full.billing_reason || inv.billing_reason) === "subscription_create";
  const description = first ? `${org} ${sub.metadata?.catchup === "down" ? "Down Payment" : "Payment"}` : `${org} Monthly`;
  await spost(`payment_intents/${pi}`, { description, metadata: { ...tags, kind: "plan" } });
  return { status: 200, note: "payment tagged" };
}

export async function handleEvent(event) {
  if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") return tagInvoicePayment(event.data.object);
  if (event.type !== "checkout.session.completed") return { status: 200, note: "ignored" };
  const s = event.data.object;
  if (s.mode !== "subscription" || !s.subscription) return { status: 200, note: "not a plan" };
  const sid = typeof s.subscription === "object" ? s.subscription.id : s.subscription;
  let cancelAt = Number(s.metadata && s.metadata.cancel_at);
  if (!cancelAt) cancelAt = Number((await sget(`subscriptions/${sid}`)).metadata?.cancel_at);
  if (!cancelAt) return { status: 200, note: "no end date on this subscription" };
  await spost(`subscriptions/${sid}`, { cancel_at: cancelAt });
  return { status: 200, note: "end date set" };
}
