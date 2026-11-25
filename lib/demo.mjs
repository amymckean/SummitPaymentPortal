// A tiny fake Stripe for trying the portal without credentials (DEMO=1) and for the tests.
// Try it with  demo@example.com  and phone digits  1234.
const ts = (d) => Math.floor(Date.parse(d + "T12:00:00Z") / 1000);
const CUS = { id: "cus_demo1", object: "customer", email: "demo@example.com", name: "Demo Family", phone: "(425) 555-1234", metadata: {} };

const CUS2 = { id: "cus_demo2", object: "customer", email: "billing@other.example", name: "Other Billing", metadata: {} }; // a customer whose email isn't on the contacts sheet
const charge = (id, d, dollars, org, team, player, extra = {}) => ({
  id, object: "charge", paid: true, status: "succeeded", created: ts(d), amount: Math.round(dollars * 100), amount_refunded: 0,
  customer: CUS, metadata: {}, billing_details: { name: "Demo Family" },
  payment_intent: { id: "pi_" + id, metadata: { org, team, player, payer_name: "Demo Family" } }, ...extra,
});

// Fake contacts tab: Ava and Zoe share a parent, and the other parent has a different email and phone.
export const DEMO_CONTACTS = [
  ["summit", "12U", "Ava Demo", "Demo Family", "demo@example.com", "425-555-1234", "2013-03-04"],
  ["summit", "12U", "Ava Demo", "Pat Demo", "pat@example.com", "425-555-9999", "2013-03-04"],
  ["summit", "12U", "Zoe Demo", "Demo Family", "demo@example.com", "425-555-1234", "2014-05-06"],
  ["summit", "12U", "Zoe Demo", "Pat Demo", "pat@example.com", "425-555-9999", "2014-05-06"],
  ["voltage", "10U Gold", "Mason Demo", "Demo Family", "demo@example.com", "425-555-1234", "2016-07-08"],
  ["voltage", "10U Gold", "Mason Demo", "Pat Demo", "pat@example.com", "425-555-9999", "2016-07-08"],
  ["voltage", "10U Gold", "Quinn Demo", "Sam Other", "sam@example.com", "206-555-0000", "2016-01-02"],
  ["voltage", "10U Gold", "Remy Demo", "Sam Other", "sam@example.com", "206-555-0000", "2015-02-03"], // paid under a different Stripe email
].map(([org, team, player, name, email, ph, dob]) => ({ org, team, player, name, email, last4: ph.slice(-4), dob }));

let overrides = null;
export const setDemoGet = (o) => { overrides = o; }; // tests can script individual GET responses

export const DEMO_CONTACTS_EXTRA = [["voltage", "10U Gold", "Remy Demo", "Sam Other", "sam@example.com", "206-555-0000", "2015-02-03"]];
export const DEMO_STATE = { posts: [] }; // the tests read what the portal sent to Stripe

export const FIXTURE = () => ({
  customers: [CUS, CUS2],
  charges: [
    charge("ch_1", "2026-08-15", 250, "voltage", "10U Gold", "Mason Demo"),
    charge("ch_2", "2026-09-05", 162, "voltage", "10U Gold", "Mason Demo"),
    charge("ch_3", "2026-08-15", 500, "summit", "12U", "Ava Demo"),
    charge("ch_4", "2026-09-05", 235, "summit", "12U", "Ava Demo"),
    charge("ch_5", "2026-10-05", 235, "summit", "12U", "Ava Demo"),
    charge("ch_6", "2026-08-20", 500, "summit", "12U", "Zoe Demo"),
    charge("ch_7", "2026-08-01", 250, "voltage", "10U Gold", "Remy Demo", { customer: CUS2 }),
    charge("ch_8", "2026-09-05", 162, "voltage", "10U Gold", "Remy Demo", { customer: CUS2 }),
  ],
  subscriptions: [{
    id: "sub_demo1", status: "active", customer: CUS, metadata: { org: "summit", team: "12U", player: "Ava Demo", payer_name: "Demo Family" },
    items: { data: [{ price: { unit_amount: 23500 }, quantity: 1 }] }, latest_invoice: { status: "paid", status_transitions: { paid_at: ts("2026-10-05") } },
  }],
});

export async function demoFetch(url, init = {}) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v1\//, "");
  const q = u.searchParams;
  const F = FIXTURE();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (init.method === "POST") {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    DEMO_STATE.posts.push({ path, body });
    if (path === "billing_portal/sessions") return reply({ id: "bps_demo", url: (body.return_url || "/") + "&demo=1" });
    if (path === "checkout/sessions") return reply({ id: "cs_demo", url: (body.success_url || "/") + "&demo=1" });
    return reply({ id: path.split("/").pop() });
  }
  if (overrides && overrides[path]) return reply(overrides[path]);
  const page = (list) => reply({ data: list, has_more: false });
  if (path === "customers") return page(F.customers.filter((c) => !q.get("email") || c.email === q.get("email")));
  if (path === "payment_intents/search") { // find payments by tag, like Stripe's search
    const m = /metadata\['player'\]:'([^']*)'/.exec(q.get("query") || "");
    return page(m ? F.charges.map((c) => c.payment_intent).filter((pi) => pi.metadata.player === m[1]).map((pi) => ({ id: pi.id, customer: F.charges.find((c) => c.payment_intent === pi).customer.id, metadata: pi.metadata })) : []);
  }
  if (path.endsWith("/search") && !(path === "customers/search" && /email:/.test(q.get("query") || ""))) return page([]);
  if (path === "customers/search") return page(F.customers.filter((c) => (q.get("query") || "").includes(c.email)));
  if (path === "charges") return page(F.charges.filter((c) => !q.get("customer") || c.customer.id === q.get("customer")));
  if (path === "subscriptions") return page(F.subscriptions.filter((s) => !q.get("customer") || s.customer.id === q.get("customer")));
  if (path === "invoices") return page([]);
  if (path.startsWith("subscriptions/")) return reply({ id: path.split("/")[1], metadata: {} });
  return reply({ error: { message: "demo: unsupported " + path } }, 404);
}
