// Minimal Stripe REST client (form-encoded writes, paged reads). In DEMO=1 mode it talks to a fake Stripe instead.
import { demoFetch } from "./demo.mjs";

export class StripeError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

/** Stripe's bracket encoding: {a:{b:1}, c:[1,2]} -> a[b]=1&c[0]=1&c[1]=2 */
export function form(obj) {
  const out = new URLSearchParams();
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk("", obj);
  return out;
}

async function call(method, path, params) {
  const key = process.env.STRIPE_API_KEY;
  if (!key && process.env.DEMO !== "1") throw new StripeError("STRIPE_API_KEY is not set.", 500);
  const doFetch = process.env.DEMO === "1" ? demoFetch : fetch;
  const qs = form(params || {}).toString();
  const url = `https://api.stripe.com/v1/${path}` + (method === "GET" && qs ? "?" + qs : "");
  const res = await doFetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? qs : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new StripeError(body?.error?.message || `Stripe error ${res.status}`, res.status);
  return body;
}

export const sget = (path, params) => call("GET", path, params);
export const spost = (path, params) => call("POST", path, params);

export async function slist(path, params = {}, expand = []) {
  const all = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const body = await sget(path, { ...params, expand, limit: 100, ...(after ? { starting_after: after } : {}) });
    all.push(...body.data);
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return all;
}
