import assert from "node:assert/strict";
process.env.DEMO = "1";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
const { handleAccount, handleCheckout, resetLockouts, quote } = await import("./lib/portal.mjs");
const { DEMO_STATE } = await import("./lib/demo.mjs");
const { form } = await import("./lib/stripe.mjs");
const { signatureOk, handleEvent } = await import("./lib/webhook.mjs");
const { createHmac } = await import("node:crypto");

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const TODAY = "2026-11-02";
const opts = { today: TODAY, delayMs: 0, site: "https://pay.example.org", nowTs: Math.floor(Date.parse("2026-11-02T12:00:00Z") / 1000) };
const good = { email: "Demo@Example.com ", last4: "1234", dob: "2013-03-04" };

await t("form encoding", () => {
  assert.equal(form({ a: { b: 1 }, c: [1, 2] }).toString(), "a%5Bb%5D=1&c%5B0%5D=1&c%5B1%5D=2");
});
await t("contacts: any parent's email works with either parent's phone", async () => {
  const { authorize, parseContacts } = await import("./lib/contacts.mjs");
  const rows = parseContacts([["org", "team", "player", "name", "relationship", "email", "phone", "birthdate"],
    ["summit", "", "Jo Smith", "Mom", "", "Mom@X.com", "(425) 555-1111", "2012-09-09"], ["summit", "", "Jo Smith", "Dad", "", "dad@x.com", "+1 206-555-2222", "9/9/2012"],
    ["summit", "", "Al Smith", "Mom", "", "mom@x.com", "425-555-1111", "04-Jan-2015"], ["voltage", "", "Other Kid", "Zed", "", "zed@x.com", "999-999-9999", "2014-01-01"]]);
  for (const [e, l] of [["mom@x.com", "1111"], ["mom@x.com", "2222"], ["DAD@x.com", "1111"], ["dad@x.com", "2222"]]) assert.ok(authorize(rows, e, l, "2012-09-09"), e + l);
  assert.ok(authorize(rows, "mom@x.com", "1111", "2015-01-04")); // the sibling's birth date also works
  assert.equal(authorize(rows, "mom@x.com", "1111", "2014-01-01"), null); // another family's child
  assert.equal(authorize(rows, "mom@x.com", "9999", "2012-09-09"), null);   // another family's phone
  assert.equal(authorize(rows, "nobody@x.com", "1111", "2012-09-09"), null);
  assert.deepEqual(authorize(rows, "mom@x.com", "2222", "2012-09-09").players.map((p) => p.player), ["Jo Smith", "Al Smith"]); // both kids, same email
  assert.deepEqual(authorize(rows, "dad@x.com", "1111", "2012-09-09").emails.sort(), ["dad@x.com", "mom@x.com"]);
});
await t("player names match loosely (middle names)", async () => {
  const { samePlayer } = await import("./lib/contacts.mjs");
  assert.ok(samePlayer("Greyson Darrin Hipol", "greyson hipol")); assert.ok(!samePlayer("Ava Demo", "Zoe Demo"));
});
await t("login works with the other parent's email and phone, and sees the same kids", async () => {
  const names = (r) => r.json.players.map((p) => p.player).sort();
  const r = await handleAccount({ email: "pat@example.com", last4: "1234", dob: "2013-03-04" }, opts);
  assert.equal(r.status, 200); assert.deepEqual(names(r), ["Ava Demo", "Mason Demo", "Zoe Demo"]);
  const r2 = await handleAccount({ email: "demo@example.com", last4: "9999", dob: "2013-03-04" }, opts);
  assert.equal(r2.status, 200); assert.deepEqual(names(r2), ["Ava Demo", "Mason Demo", "Zoe Demo"]);
  resetLockouts();
});
await t("another family's phone fails; their own login shows only their kid, with no payments yet", async () => {
  assert.equal((await handleAccount({ email: "sam@example.com", last4: "1234", dob: "2016-01-02" }, opts)).status, 401);
  const r = await handleAccount({ email: "sam@example.com", last4: "0000", dob: "2016-01-02" }, opts);
  assert.equal(r.status, 200); assert.deepEqual(r.json.players.map((p) => p.player).sort(), ["Quinn Demo", "Remy Demo"]);
  const quinn = r.json.players.find((p) => p.player === "Quinn Demo");
  assert.equal(quinn.paid, 0); assert.equal(quinn.pay[0].id, "due"); // owes the down payment
  resetLockouts();
});
await t("payments made under a different Stripe email are found through the player tag", async () => {
  const r = await handleAccount({ email: "sam@example.com", last4: "0000", dob: "2016-01-02" }, opts);
  const remy = r.json.players.find((p) => p.player === "Remy Demo");
  assert.equal(remy.paid, 412); assert.equal(remy.history.length, 2); assert.equal(remy.team, "10U Gold");
  resetLockouts();
});
await t("a family with no Stripe customer checks out by email, creating the customer", async () => {
  DEMO_STATE.posts.length = 0;
  const r = await handleCheckout({ email: "sam@example.com", last4: "0000", dob: "2016-01-02", key: "voltage|quinn demo", kind: "balance", option: "due", method: "ach" }, opts);
  assert.equal(r.status, 200);
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s.customer_email, "sam@example.com"); assert.equal(s.customer_creation, "always"); assert.equal(s.customer, undefined);
  assert.equal(s["line_items[0][price_data][unit_amount]"], "57400"); // $250 down + 2 past-due installments by bank ($162 each)
  resetLockouts();
});
await t("the birth date must match one of the family's players", async () => {
  const base = { email: "demo@example.com", last4: "1234" };
  assert.equal((await handleAccount({ ...base, dob: "2013-03-05" }, opts)).status, 401); // off by a day
  assert.equal((await handleAccount({ ...base, dob: "" }, opts)).status, 401);
  assert.equal((await handleAccount({ ...base, dob: "2016-01-02" }, opts)).status, 401); // another family's child
  for (const ok of ["2014-05-06", "5/6/2014", "May 6, 2014"]) assert.equal((await handleAccount({ ...base, dob: ok }, opts)).status, 200, ok); // any of their kids, any style
  resetLockouts();
});
await t("wrong last 4, unknown email and bad input all fail the same way", async () => {
  const a = await handleAccount({ email: "demo@example.com", last4: "0000", dob: "2013-03-04" }, opts);
  const b = await handleAccount({ email: "nobody@example.com", last4: "1234", dob: "2013-03-04" }, opts);
  const c = await handleAccount({ email: "nonsense", last4: "12" }, opts);
  assert.equal(a.status, 401); assert.deepEqual(a.json, b.json); assert.deepEqual(b.json, c.json);
  resetLockouts();
});
await t("lockout after repeated failures, cleared by success", async () => {
  resetLockouts();
  for (let i = 0; i < 5; i++) await handleAccount({ email: "demo@example.com", last4: "999" + i }, { ...opts, ip: "1.1.1.1" });
  assert.equal((await handleAccount(good, { ...opts, ip: "1.1.1.1" })).status, 429);
  resetLockouts();
  assert.equal((await handleAccount(good, { ...opts, ip: "1.1.1.1" })).status, 200);
});
let view;
await t("account view lists the family's players, with no charge ids", async () => {
  const r = await handleAccount(good, opts);
  assert.equal(r.status, 200);
  view = r.json;
  assert.deepEqual(view.players.map((p) => p.player).sort(), ["Ava Demo", "Mason Demo", "Zoe Demo"]);
  assert.ok(!JSON.stringify(view).includes("ch_"));
  assert.ok(!JSON.stringify(view).includes("cus_"));
});
const P = (name) => view.players.find((p) => p.player === name);
await t("Mason: one past-due installment, bank vs card amounts differ", () => {
  const m = P("Mason Demo");
  assert.equal(m.pay.length, 1); assert.equal(m.pay[0].id, "due");
  assert.deepEqual(m.pay[0].amounts, { ach: 162, card: 167 });
  assert.equal(m.multi, true);
  assert.equal(m.history.length, 2);
});
await t("Ava: active subscription, so no new plan", () => {
  const a = P("Ava Demo");
  assert.equal(a.plan, null); assert.deepEqual(a.pay, []); assert.ok(a.subscription); assert.equal(a.status, "Up to date");
});
await t("Zoe: can start monthly payments; only the past-due part is charged today", () => {
  const z = P("Zoe Demo");
  assert.equal(z.plan.months, 8); assert.equal(z.plan.first, "2026-12-01"); assert.equal(z.plan.now.ach, 470); // Sept + Oct
  assert.equal(z.plan.monthly.ach, 235);
  assert.equal(z.plan.total_payments, 10); assert.equal(z.plan.payoff.ach, z.remaining); // every installment still owed is covered
});
await t("balance checkout is computed on the server and tagged", async () => {
  DEMO_STATE.posts.length = 0;
  const r = await handleCheckout({ ...good, key: "voltage|mason demo", kind: "balance", option: "due", method: "card" }, opts); // no amount sent: the server uses what is due
  assert.equal(r.status, 200); assert.ok(r.json.url.startsWith("https://pay.example.org/?status=thanks"));
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s.mode, "payment");
  assert.equal(s["line_items[0][price_data][unit_amount]"], "16700"); // client "amount" is ignored
  assert.equal(s["payment_intent_data[metadata][player]"], "Mason Demo");
  assert.equal(s["payment_intent_data[metadata][org]"], "voltage");
  assert.equal(s["payment_method_types[0]"], "card");
  assert.equal(s.customer, "cus_demo1");
});
await t("bank choice charges the lower amount; missing method is refused", async () => {
  DEMO_STATE.posts.length = 0;
  await handleCheckout({ ...good, key: "voltage|mason demo", kind: "balance", option: "due", method: "ach" }, opts);
  assert.equal(DEMO_STATE.posts.at(-1).body["line_items[0][price_data][unit_amount]"], "16200");
  const bad = await handleCheckout({ ...good, key: "voltage|mason demo", kind: "balance", option: "due" }, opts);
  assert.equal(bad.status, 400);
});
await t("same-price plans offer both methods in one checkout", async () => {
  DEMO_STATE.posts.length = 0;
  await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan" }, opts);
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s["payment_method_types[0]"], "us_bank_account"); assert.equal(s["payment_method_types[1]"], "card");
});
await t("monthly plan: one-time catch-up, recurring price, end date, anchor", async () => {
  DEMO_STATE.posts.length = 0;
  const r = await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan" }, opts);
  assert.equal(r.status, 200);
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s.mode, "subscription");
  assert.equal(s["line_items[0][price_data][unit_amount]"], "47000");
  assert.equal(s["line_items[1][price_data][unit_amount]"], "23500");
  assert.equal(s["line_items[1][price_data][recurring][interval]"], "month");
  assert.equal(s["subscription_data[trial_end]"], String(Math.floor(Date.parse("2026-12-01T12:00:00Z") / 1000)));
  assert.equal(s["subscription_data[proration_behavior]"], undefined); // Stripe rejects it alongside one-time items
  assert.equal(s["subscription_data[billing_cycle_anchor]"], undefined);
  assert.equal(s["subscription_data[metadata][cancel_at]"], String(Math.floor(Date.parse("2027-07-16T12:00:00Z") / 1000)));
  assert.equal(s["subscription_data[metadata][installments_left]"], "8");
  assert.equal(s["subscription_data[metadata][player]"], "Zoe Demo");
});
await t("families can choose the start date within limits", async () => {
  DEMO_STATE.posts.length = 0;
  const r = await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan", start: "2026-12-15" }, opts);
  assert.equal(r.status, 200);
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s["subscription_data[trial_end]"], String(Math.floor(Date.parse("2026-12-15T12:00:00Z") / 1000)));
  assert.equal(s["subscription_data[metadata][cancel_at]"], String(Math.floor(Date.parse("2027-07-30T12:00:00Z") / 1000))); // last charge Jul 15 + 15 days
  assert.equal(s["subscription_data[metadata][first_charge]"], "2026-12-15");
  for (const bad of ["2026-11-03", "2027-03-01", "2026-12-31", "tomorrow"]) assert.equal((await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan", start: bad }, opts)).status, 400, bad);
  assert.equal((await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan", start: "2026-11-05" }, opts)).status, 200); // earliest: 3 days out
  resetLockouts();
});
await t("a first charge less than 48 hours away is pushed out", async () => {
  DEMO_STATE.posts.length = 0;
  const now = Math.floor(Date.parse("2026-11-30T20:00:00Z") / 1000);
  await handleCheckout({ ...good, key: "summit|zoe demo", kind: "plan" }, { ...opts, nowTs: now });
  assert.equal(Number(DEMO_STATE.posts.at(-1).body["subscription_data[trial_end]"]), now + 50 * 3600);
});
await t("players with a subscription can't start another; unknown players 404", async () => {
  assert.equal((await handleCheckout({ ...good, key: "summit|ava demo", kind: "plan" }, opts)).status, 409);
  assert.equal((await handleCheckout({ ...good, key: "summit|someone else", kind: "plan" }, opts)).status, 404);
});
await t("a caught-up family pays nothing today and all remaining installments are monthly", () => {
  const dues = ["2026-09-30","2026-10-31","2026-11-30","2026-12-31","2027-01-31","2027-02-28","2027-03-31","2027-04-30","2027-05-31","2027-06-30"];
  const row = { pay_info: { downpayment: 500, amounts: [235], installments: 10, n_past: 2, dues, has_skips: false }, inst: 2, down_ok: true, free: false, status: "Up to date", this_month: "Due by 2026-11-30" };
  const q = quote(row, null, TODAY);
  assert.equal(q.plan.now.ach, 0); assert.equal(q.plan.months, 8); assert.equal(q.plan.total_payments, 8); assert.equal(q.plan.payoff.ach, 8 * 235);
});
await t("a player with monthly payments set up gets no payment options, only a payment-method update", async () => {
  const dues = ["2026-09-30","2026-10-31","2026-11-30","2026-12-31","2027-01-31","2027-02-28","2027-03-31","2027-04-30","2027-05-31","2027-06-30"];
  const behind = { pay_info: { downpayment: 500, amounts: [235], installments: 10, n_past: 2, dues, has_skips: false }, inst: 0, down_ok: false, free: false, status: "Behind", this_month: "" };
  const q = quote(behind, { status: "Past due" }, TODAY);
  assert.equal(q.plan, null); assert.equal(q.pay.length, 1); assert.equal(q.pay[0].id, "down"); assert.equal(q.pay[0].amounts.ach, 500); // the missing down payment is the only thing to pay
  const caughtUp = quote({ ...behind, down_ok: true, inst: 2, status: "Up to date" }, { status: "Current" }, TODAY);
  assert.deepEqual(caughtUp.pay, []); assert.equal(caughtUp.plan, null);
  DEMO_STATE.posts.length = 0;
  const r = await handleCheckout({ ...good, key: "summit|ava demo", kind: "card" }, opts);
  assert.equal(r.status, 200); assert.ok(r.json.url.startsWith("https://pay.example.org/?status=card"));
  const post = DEMO_STATE.posts.at(-1);
  assert.equal(post.path, "billing_portal/sessions"); assert.equal(post.body.customer, "cus_demo1");
  assert.equal((await handleCheckout({ ...good, key: "summit|zoe demo", kind: "card" }, opts)).status, 409); // no subscription
  assert.equal(P("Ava Demo").subscription.can_update, true); assert.ok(!JSON.stringify(view).includes("sub_"));
});
await t("nothing due on a pay-ahead player still quotes one installment", () => {
  const row = { pay_info: { downpayment: 500, amounts: [235], installments: 10, n_past: 2, dues: ["2026-09-30","2026-10-31","2026-11-30","2026-12-31","2027-01-31","2027-02-28","2027-03-31","2027-04-30","2027-05-31","2027-06-30"], has_skips: false },
    inst: 2, down_ok: true, free: false, status: "Up to date", this_month: "Paid" };
  const q = quote(row, null, TODAY);
  assert.equal(q.pay[0].id, "next"); assert.equal(q.pay[0].amounts.ach, 235);
});
const sign = (body, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
await t("webhook signature checks", () => {
  const body = '{"a":1}';
  assert.ok(signatureOk(body, sign(body, "whsec_test"), "whsec_test"));
  assert.ok(!signatureOk(body, sign(body, "other"), "whsec_test"));
  assert.ok(!signatureOk(body + " ", sign(body, "whsec_test"), "whsec_test"));
  assert.ok(!signatureOk(body, sign(body, "whsec_test", 1000), "whsec_test"));
  assert.ok(!signatureOk(body, "", "whsec_test"));
});
await t("webhook sets the end date on a new plan, ignores everything else", async () => {
  DEMO_STATE.posts.length = 0;
  const ev = { type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_new", metadata: { cancel_at: "1782820800" } } } };
  await handleEvent(ev);
  assert.deepEqual(DEMO_STATE.posts.at(-1), { path: "subscriptions/sub_new", body: { cancel_at: "1782820800" } });
  DEMO_STATE.posts.length = 0;
  await handleEvent({ type: "invoice.paid", data: { object: {} } });
  await handleEvent({ type: "checkout.session.completed", data: { object: { mode: "payment" } } });
  assert.equal(DEMO_STATE.posts.length, 0);
});
await t("a family can choose how much to pay now, within limits", async () => {
  DEMO_STATE.posts.length = 0;
  const base = { ...good, key: "voltage|mason demo", kind: "balance", option: "due", method: "ach" };
  const r = await handleCheckout({ ...base, amount: "100.50" }, opts);
  assert.equal(r.status, 200);
  const s = DEMO_STATE.posts.at(-1).body;
  assert.equal(s["line_items[0][price_data][unit_amount]"], "10050");
  assert.equal(s["payment_intent_data[metadata][player]"], "Mason Demo");
  assert.match(s["line_items[0][price_data][product_data][name]"], /^Voltage Payment$/);
  const view = (await handleAccount(good, opts)).json.players.find((p) => p.player === "Mason Demo").pay[0];
  assert.equal(view.max.ach, 1296); assert.equal(view.min, 25); // $1,296 = 8 installments left
  for (const bad of ["5", "1297", "abc", "-20"]) assert.equal((await handleCheckout({ ...base, amount: bad }, opts)).status, 400, bad);
  assert.equal((await handleCheckout({ ...base, amount: "1296" }, opts)).status, 200); // pay the whole season
  DEMO_STATE.posts.length = 0;
  await handleCheckout({ ...base, amount: "162" }, opts);
  assert.equal(DEMO_STATE.posts.at(-1).body["line_items[0][price_data][product_data][name]"], "Voltage Payment"); // a one-time installment payment is not "Monthly" (no subscription)
  resetLockouts();
});
await t("webhook copies the subscription's tags onto each plan payment", async () => {
  DEMO_STATE.posts.length = 0;
  const { setDemoGet } = await import("./lib/demo.mjs");
  setDemoGet({ "invoices/in_1": { id: "in_1", payment_intent: "pi_77" }, "subscriptions/sub_9": { metadata: { org: "summit", team: "12U", player: "Zoe Demo", payer_name: "Demo Family", cancel_at: "1", kind: "plan" } } });
  const r = await handleEvent({ type: "invoice.payment_succeeded", data: { object: { id: "in_1", subscription: "sub_9" } } });
  assert.equal(r.note, "payment tagged");
  const post = DEMO_STATE.posts.at(-1);
  assert.equal(post.path, "payment_intents/pi_77");
  assert.deepEqual(post.body, { description: "Summit Monthly", "metadata[org]": "summit", "metadata[team]": "12U", "metadata[player]": "Zoe Demo", "metadata[payer_name]": "Demo Family", "metadata[kind]": "plan" }); // a recurring charge
  // the first invoice of a plan is the catch-up payment, not a monthly one
  setDemoGet({ "invoices/in_3": { id: "in_3", payment_intent: "pi_78", billing_reason: "subscription_create" }, "subscriptions/sub_9": { metadata: { org: "summit", team: "12U", player: "Zoe Demo", payer_name: "Demo Family", catchup: "payment" } } });
  await handleEvent({ type: "invoice.payment_succeeded", data: { object: { id: "in_3", subscription: "sub_9", billing_reason: "subscription_create" } } });
  assert.equal(DEMO_STATE.posts.at(-1).body.description, "Summit Payment");
  setDemoGet({ "invoices/in_4": { id: "in_4", payment_intent: "pi_79" }, "subscriptions/sub_9": { metadata: { org: "summit", player: "Zoe Demo", catchup: "down" } } });
  await handleEvent({ type: "invoice.payment_succeeded", data: { object: { id: "in_4", subscription: "sub_9", billing_reason: "subscription_create" } } });
  assert.equal(DEMO_STATE.posts.at(-1).body.description, "Summit Down Payment");
  setDemoGet({ "invoices/in_1": { id: "in_1", payment_intent: "pi_77" }, "subscriptions/sub_9": { metadata: { org: "summit", team: "12U", player: "Zoe Demo", payer_name: "Demo Family", cancel_at: "1", kind: "plan" } } });
  assert.equal((await handleEvent({ type: "invoice.paid", data: { object: { id: "in_2" } } })).note, "not a subscription invoice");
  setDemoGet(null);
});
await t("monthly payments with catch-up: family picks how much of the catch-up to pay today", async () => {
  resetLockouts();
  const base = { ...good, key: "summit|zoe demo", kind: "plan" };
  DEMO_STATE.posts.length = 0;
  assert.equal((await handleCheckout({ ...base, now_amount: "50" }, opts)).status, 200);
  const b = DEMO_STATE.posts.at(-1).body;
  assert.equal(b["line_items[0][price_data][unit_amount]"], "5000");
  assert.match(b["line_items[0][price_data][product_data][name]"], /^Summit (Down Payment|Payment)$/);
  DEMO_STATE.posts.length = 0;
  assert.equal((await handleCheckout({ ...base, now_amount: "0" }, opts)).status, 200);
  assert.equal(DEMO_STATE.posts.at(-1).body["line_items[0][price_data][recurring][interval]"], "month"); // only the monthly item
  for (const bad of ["5", "-1", "99999", "abc"]) assert.equal((await handleCheckout({ ...base, now_amount: bad }, opts)).status, 400, bad);
  resetLockouts();
});
console.log(`\nall ${n} tests passed`);
