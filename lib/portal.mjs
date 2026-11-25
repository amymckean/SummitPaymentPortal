// Family portal logic: verify a family, build their account view, and build Stripe Checkout requests.
// Stateless: every request re-verifies the email + last 4 digits and recomputes everything from Stripe.
import { FEES } from "./fees.mjs";
import { buildLedger, manualCharges } from "./ledger.mjs";
import { chargesFromStripe, subscriptionTagLookup, subsFromStripe } from "./logic.mjs";
import { slist, sget, spost, StripeError } from "./stripe.mjs";
import { authorize, getContacts, samePlayer } from "./contacts.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cents = (x) => Math.round(x * 100);
const money = (x) => "$" + (Math.round(x * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: x % 1 ? 2 : 0, maximumFractionDigits: 2 });
const laToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
function addMonths(iso, n) { // day of month is 1-28 for plans, so no end-of-month clamping is needed
  const [y, m, d] = iso.split("-").map(Number), t = m - 1 + n;
  return new Date(Date.UTC(y + Math.floor(t / 12), ((t % 12) + 12) % 12, d)).toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ who is this?
/** Stripe customers using any of these emails (used to attach a new checkout to an existing customer). */
export async function findCustomers(emails) {
  const found = new Map();
  const wanted = new Set(emails);
  const add = (list) => list.forEach((c) => { if (c.email && wanted.has(c.email.toLowerCase())) found.set(c.id, c); });
  await Promise.all(emails.flatMap((email) => [
    slist("customers", { email }).then(add).catch(() => {}),
    sget("customers/search", { query: `email:'${email.replace(/['\\]/g, "")}'`, limit: 100 }).then((b) => add(b.data || [])).catch(() => {}),
  ]));
  return [...found.values()];
}

/** Email + last 4 phone digits, checked against the contacts sheet. Returns the family or null. */
export async function verify(email, last4, dob) {
  email = String(email || "").trim().toLowerCase();
  last4 = String(last4 || "").trim();
  if (!EMAIL.test(email) || !/^\d{4}$/.test(last4)) return null;
  const auth = authorize(await getContacts(), email, last4, dob);
  if (!auth) return null;
  const customers = await findCustomers(auth.emails);
  return { ...auth, customers, customer: customers.find((c) => (c.email || "").toLowerCase() === email) || customers.find((c) => c.email) || null };
}

// Failed-attempt lockout. In-memory, so it only holds while a function instance is warm; the real throttle is
// the Netlify rate limit in each function's config. Never trust this alone.
const FAILS = new Map();
const LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000;
export function lockedOut(keys) {
  const now = Date.now();
  return keys.some((k) => { const f = FAILS.get(k); return f && f.n >= LOCK_AFTER && now - f.t < LOCK_MS; });
}
function noteFail(keys) {
  const now = Date.now();
  for (const k of keys) { const f = FAILS.get(k); FAILS.set(k, !f || now - f.t > LOCK_MS ? { n: 1, t: now } : { n: f.n + 1, t: now }); }
}
export const resetLockouts = () => FAILS.clear();

// ------------------------------------------------------------------ the account view
const KIND = (k) => (k.startsWith("down") ? "Down payment" : k.startsWith("inst") ? "Monthly payment" : "Payment");
const ACTIVE = new Set(["Current", "Invoice open", "Past due", "Trialing", "Paused"]);
const keyOf = (org, player) => org + "|" + String(player).trim().toLowerCase();
const amountFor = (amounts, method) => (method === "ach" ? Math.min(...amounts) : Math.max(...amounts));
const differs = (amounts) => Math.min(...amounts) !== Math.max(...amounts);

export async function loadFamily(family, today = laToday()) {
  const { players } = family;
  // Same source as the board site: every charge since the season started, with its customer, payment and subscription
  // tags, grouped by the org/player tags. The family's players (from the contacts sheet) pick out their own payments.
  const since = Math.floor(Date.parse(FEES.season_start + "T00:00:00Z") / 1000);
  const [rawCharges, rawSubs, rawInvoices] = await Promise.all([
    slist("charges", { "created[gte]": since }, ["data.customer", "data.payment_intent"]),
    slist("subscriptions", { status: "all" }, ["data.customer", "data.latest_invoice"]),
    slist("invoices", { "created[gte]": since }, ["data.payments"]).catch(() => slist("invoices", { "created[gte]": since }, []).catch(() => [])),
  ]);
  const lookup = rawInvoices.length ? subscriptionTagLookup(rawSubs, rawInvoices) : null;
  const mine = (x) => players.some((p) => p.org === x.org && samePlayer(p.player, x.player));
  const stripeCharges = chargesFromStripe(rawCharges, lookup);
  const charges = [...stripeCharges, ...manualCharges(FEES)].filter(mine); // manual = checks recorded in fees.mjs
  const pending = new Map(); // bank payments that haven't cleared yet
  for (const c of chargesFromStripe(rawCharges.filter((x) => x.status === "pending").map((x) => ({ ...x, paid: true, status: "succeeded" })), lookup).filter(mine)) {
    pending.set(keyOf(c.org, c.player), (pending.get(keyOf(c.org, c.player)) || 0) + c.gross);
  }
  const subs = subsFromStripe(rawSubs).filter(mine);
  // Registered players with no payments yet still appear (so they can pay), under the name on the sheet.
  const roster = players.filter((p) => !charges.some((c) => c.org === p.org && samePlayer(c.player, p.player)) && !subs.some((s) => s.org === p.org && samePlayer(s.player, p.player)));
  const { rows } = buildLedger(charges, subs, { ...FEES, roster }, today);
  return { rows, subs, pending, unlinked: 0, today };
}

/** What this player's family can do right now. Amounts depend on how they pay (bank vs card) when the plan has two. */
export function quote(row, activeSub, today) {
  const pi = row.pay_info;
  const none = { pay: [], plan: null };
  if (!pi || row.free || row.status === "Paid in full" || !pi.amounts.length) return none;
  const remaining = pi.installments - row.inst;
  const missingDown = row.down_ok ? 0 : pi.downpayment;
  if (activeSub) { // monthly payments already set up: installments are handled by the subscription, but a missing down payment still has to be paid
    if (!(missingDown > 0)) return none;
    return { pay: [{ id: "down", label: "Down payment", down: missingDown, count: 0, amounts: { ach: missingDown, card: missingDown }, max: { ach: missingDown, card: missingDown }, min: Math.min(25, missingDown) }], plan: null, multi: false };
  }
  const overdue = Math.min(Math.max(0, pi.n_past - row.inst), remaining);
  const pay = [];
  if (missingDown > 0 || overdue > 0) {
    pay.push({ id: "due", label: [missingDown > 0 && "Down payment", overdue > 0 && `${overdue} past-due installment${overdue > 1 ? "s" : ""}`].filter(Boolean).join(" + "), down: missingDown, count: overdue });
  } else if (remaining > 0 && !activeSub) { // with a subscription running, the next charge is already handled
    const thisMonth = row.this_month && row.this_month.startsWith("Due");
    pay.push({ id: "next", label: thisMonth ? "This month's installment" : "Nothing is past due. Next installment (paying ahead)", down: 0, count: 1 });
  }
  const tot = (o, m) => o.down + o.count * amountFor(pi.amounts, m);
  // A family may pay any amount from a small minimum up to everything still owed on the season (paying ahead is fine).
  const maxFor = (m) => missingDown + remaining * amountFor(pi.amounts, m);
  const out = { pay: pay.map((o) => ({ ...o, amounts: { ach: tot(o, "ach"), card: tot(o, "card") }, max: { ach: maxFor("ach"), card: maxFor("card") }, min: Math.min(25, tot(o, "ach")) })), plan: null, multi: differs(pi.amounts) };

  // Monthly payments: only what is already past due (missing down payment + installments whose month has ended) is
  // charged today. Every other installment, including this month's, becomes a monthly payment starting on the date the
  // family picks. A family that is caught up pays nothing today.
  const n = remaining - overdue;
  if (!activeSub && !pi.has_skips && n > 0) {
    const o = { down: missingDown, count: overdue };
    let first = addMonths(today.slice(0, 7) + "-01", 1); // default: the 1st of next month
    const earliest = addDays(today, 3);
    if (first < earliest) first = addMonths(first, 1);
    out.plan = {
      months: n, now_count: overdue, down: missingDown, total_payments: n + overdue, first, earliest, latest: addDays(first, 60),
      monthly: { ach: amountFor(pi.amounts, "ach"), card: amountFor(pi.amounts, "card") },
      now: { ach: tot(o, "ach"), card: tot(o, "card") },
      payoff: { ach: tot(o, "ach") + n * amountFor(pi.amounts, "ach"), card: tot(o, "card") + n * amountFor(pi.amounts, "card") }, // everything still owed on the season
    };
  }
  return out;
}

export function accountView(fam, email) {
  const players = fam.rows.map((r) => {
    const sub = fam.subs.find((s) => keyOf(s.org, s.player) === keyOf(r.org, r.player) && ACTIVE.has(s.status));
    const q = quote(r, sub, fam.today);
    return {
      key: keyOf(r.org, r.player), org: r.org, team: r.team, player: r.player,
      status: r.status, free: r.free, paid: r.paid, plan_total: r.plan_total, remaining: r.remaining, owed_now: r.owed_now,
      this_month: r.this_month, schedule: r.schedule,
      history: r.history.map((h) => ({ date: h.date, amount: h.gross, refunded: h.refunded, kind: KIND(h.kind) })),
      pending: fam.pending.get(keyOf(r.org, r.player)) || 0,
      subscription: sub ? { status: sub.status, amount: sub.amount, last_amount: sub.last_amount, last_paid: sub.last_paid, can_update: !!sub.customer_id } : null,
      pay: q.pay, plan: q.plan, multi: !!q.multi || (q.plan ? q.plan.monthly.ach !== q.plan.monthly.card : false),
    };
  });
  return { email, today: fam.today, players, unlinked: fam.unlinked };
}

// ------------------------------------------------------------------ checkout
const METHODS = { ach: ["us_bank_account"], card: ["card"], any: ["us_bank_account", "card"] };

export function paymentSession({ customer, email, row, opt, method, amount, site }) {
  const meta = tags(row, customer);
  const label = payDesc(row, !opt.custom && opt.down > 0 && !opt.count ? "down" : "payment") // one-time payments are never called "Monthly": that name is only for a subscription;
  return {
    mode: "payment", ...who(customer, email), ...(customer ? {} : { customer_creation: "always" }), payment_method_types: METHODS[method],
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents(amount), product_data: { name: label } } }],
    payment_intent_data: { metadata: meta, description: label },
    metadata: { ...meta, kind: "balance" },
    success_url: site + "/?status=thanks", cancel_url: site + "/?status=canceled",
  };
}

// Stripe descriptions are kept uniform: "Summit Down Payment", "Voltage Monthly", "Summit Payment" ...
export const payDesc = (row, kind) => `${String(row.org).charAt(0).toUpperCase()}${String(row.org).slice(1).toLowerCase()} ${kind === "down" ? "Down Payment" : kind === "monthly" ? "Monthly" : "Payment"}`;
const who = (customer, email) => (customer ? { customer: customer.id } : { customer_email: email }); // no Stripe customer yet: Checkout makes one
const tags = (row, customer) => ({ org: row.org, team: row.team, player: row.player, payer_name: row.payer || (customer && customer.name) || "" });
const noonUtc = (iso) => Math.floor(Date.parse(iso + "T12:00:00Z") / 1000);

export function planSession({ customer, email, row, plan, method, site, nowTs, start: startDate, nowAmount }) {
  startDate = startDate || plan.first;
  const monthly = method === "ach" ? plan.monthly.ach : method === "card" ? plan.monthly.card : plan.monthly.ach;
  const owedNow = method === "card" ? plan.now.card : plan.now.ach;
  const now = nowAmount === undefined ? owedNow : nowAmount; // a family with catch-up payments may pay any amount of it today
  const meta = { ...tags(row, customer), kind: "plan", installments_left: String(plan.months), first_charge: startDate, catchup: plan.down > 0 ? "down" : "payment" };
  const cancelAt = noonUtc(addDays(addMonths(startDate, plan.months - 1), 15)); // two weeks after the final charge, before the next cycle
  const start = noonUtc(startDate);
  const items = [];
  if (now > 0) items.push({ quantity: 1, price_data: { currency: "usd", unit_amount: cents(now), product_data: { name: payDesc(row, plan.down > 0 ? "down" : "payment") } } });
  items.push({ quantity: 1, price_data: { currency: "usd", unit_amount: cents(monthly), recurring: { interval: "month" }, product_data: { name: payDesc(row, "monthly") } } });
  // Hold the first recurring charge with trial_end (one-time items are still charged today). A billing anchor can't be
  // used here: Stripe would prorate the first period, and proration_behavior "none" is rejected with one-time items.
  // Stripe wants the trial to end at least 48 hours out, so very late in a month the first charge moves to ~2 days from now.
  const trialEnd = Math.max(start, nowTs + 50 * 3600);
  return {
    mode: "subscription", ...who(customer, email), payment_method_types: METHODS[method], line_items: items,
    subscription_data: { metadata: { ...meta, cancel_at: String(cancelAt) }, description: payDesc(row, "monthly"), trial_end: trialEnd },
    metadata: { ...meta, cancel_at: String(cancelAt) },
    success_url: site + "/?status=plan", cancel_url: site + "/?status=canceled",
  };
}

// ------------------------------------------------------------------ request handlers (called by the functions)
const FAIL = { error: "We couldn't find an account with that email and phone number. Check both and try again, or contact your team manager." };

async function authenticate(body, ip, delayMs) {
  const email = String(body.email || "").trim().toLowerCase();
  const keys = ["ip:" + ip, "em:" + email];
  if (lockedOut(keys)) return { res: { status: 429, json: { error: "Too many attempts. Please wait 15 minutes and try again." } } };
  const ok = await verify(email, body.last4, body.dob);
  if (!ok) { noteFail(keys); await sleep(delayMs); return { res: { status: 401, json: FAIL } }; }
  for (const k of keys) FAILS.delete(k);
  return { ok };
}

export async function handleAccount(body, { ip = "?", today = laToday(), delayMs = 600 } = {}) {
  const a = await authenticate(body || {}, ip, delayMs);
  if (a.res) return a.res;
  const fam = await loadFamily(a.ok, today);
  return { status: 200, json: accountView(fam, a.ok.email) };
}

export async function handleCheckout(body, { ip = "?", today = laToday(), delayMs = 600, site, nowTs = Math.floor(Date.now() / 1000) } = {}) {
  const a = await authenticate(body || {}, ip, delayMs);
  if (a.res) return a.res;
  const fam = await loadFamily(a.ok, today);
  const view = accountView(fam, a.ok.email);
  const row = fam.rows.find((r) => keyOf(r.org, r.player) === body.key);
  const p = view.players.find((x) => x.key === body.key);
  if (!row || !p) return { status: 404, json: { error: "That player wasn't found on this account." } };
  if (body.kind === "card") { // update the payment method on monthly payments that are already set up (Stripe's customer portal)
    const sub = fam.subs.find((x) => keyOf(x.org, x.player) === body.key && ACTIVE.has(x.status) && x.customer_id);
    if (!sub) return { status: 409, json: { error: "There are no monthly payments to update for this player." } };
    try {
      const sess = await spost("billing_portal/sessions", { customer: sub.customer_id, return_url: site + "/?status=card" });
      return { status: 200, json: { url: sess.url } };
    } catch (e) {
      console.error("portal failed:", e instanceof StripeError ? e.message : e);
      return { status: 502, json: { error: "We couldn't open the payment method page. Please contact your team manager." } };
    }
  }
  const method = p.multi ? body.method : "any";
  if (!METHODS[method] || (method === "any" && p.multi)) return { status: 400, json: { error: "Choose how you'd like to pay (bank account or card)." } };
  const customer = a.ok.customer, email = a.ok.email;
  let params;
  if (body.kind === "balance") {
    let opt = p.pay.find((o) => o.id === body.option);
    if (!opt) return { status: 409, json: { error: "That balance has changed. Please refresh and try again." } };
    const key = method === "any" ? "ach" : method;
    let amount = opt.amounts[key];
    if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
      amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < opt.min || amount > opt.max[key])
        return { status: 400, json: { error: `Please enter an amount between $${opt.min} and $${opt.max[key]}.` } };
      if (Math.abs(amount - opt.amounts[key]) > 0.005) opt = { ...opt, custom: true };
    }
    if (!(amount > 0)) return { status: 409, json: { error: "Nothing is due." } };
    params = paymentSession({ customer, email, row, opt, method, amount, site });
  } else if (body.kind === "plan") {
    if (!p.plan) return { status: 409, json: { error: "Monthly payments can't be set up for this player online. Please contact your team manager." } };
    const start = body.start ? String(body.start) : p.plan.first;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number(start.slice(8)) > 28 || start < p.plan.earliest || start > p.plan.latest)
      return { status: 400, json: { error: "Please choose a start date between " + p.plan.earliest + " and " + p.plan.latest + " (day 1 to 28 of a month)." } };
    let nowAmount;
    if (body.now_amount !== undefined && body.now_amount !== null && body.now_amount !== "") {
      const owed = p.plan.now[method === "any" ? "ach" : method];
      nowAmount = Math.round(Number(body.now_amount) * 100) / 100;
      const minPay = Math.min(25, owed);
      if (!(owed > 0) || !Number.isFinite(nowAmount) || nowAmount < 0 || nowAmount > owed || (nowAmount > 0 && nowAmount < minPay))
        return { status: 400, json: { error: `Please enter $0 or an amount between $${minPay} and $${owed} to pay today.` } };
    }
    params = planSession({ customer, email, row, plan: p.plan, method, site, nowTs, start, nowAmount });
  } else return { status: 400, json: { error: "Unknown request." } };
  try {
    const s = await spost("checkout/sessions", params);
    return { status: 200, json: { url: s.url } };
  } catch (e) {
    console.error("checkout failed:", e instanceof StripeError ? e.message : e);
    return { status: 502, json: { error: "We couldn't start the payment. Please try again, or contact your team manager." } };
  }
}

export { money };
