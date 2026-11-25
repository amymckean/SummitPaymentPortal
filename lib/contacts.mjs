// Who belongs to which player: read from a Google Sheet tab (one row per parent/guardian), cached briefly.
import { createSign } from "node:crypto";
import { DEMO_CONTACTS } from "./demo.mjs";

export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Same player if the names match, or first and last words match ("Greyson Hipol" = "Greyson Darrin Hipol"). */
export function samePlayer(a, b) {
  const x = norm(a).split(" "), y = norm(b).split(" ");
  return norm(a) === norm(b) || (x.length > 1 && y.length > 1 && x[0] === y[0] && x[x.length - 1] === y[y.length - 1]);
}
/** Any common date style -> YYYY-MM-DD ("2012-09-09", "9/9/2012", "09-Sep-2012", "Sep 9, 2012"), or "". */
export function parseDob(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return iso(+m[3], +m[1], +m[2]);
  const d = new Date(t + " UTC");
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
const iso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "");

export const digits4 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length >= 4 ? d.slice(-4) : ""; };

/** Rows of the sheet (first row = headers: org, team, player, name, relationship, email, phone). */
export function parseContacts(values) {
  if (!values || values.length < 2) return [];
  const h = values[0].map((x) => norm(x));
  const col = (...names) => h.findIndex((x) => names.includes(x));
  const [o, t, p, n, e, ph, bd] = [col("org"), col("team"), col("player", "player name"), col("name", "parent name", "parent"), col("email", "email address"), col("phone", "phone number"), col("birthdate", "birth date", "date of birth", "dob")];
  if (p < 0 || e < 0 && ph < 0) throw new Error("The contacts tab needs columns: org, team, player, name, relationship, email, phone.");
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
  return values.slice(1).filter((r) => g(r, p)).map((r) => ({
    org: g(r, o).toLowerCase(), team: g(r, t), player: g(r, p), name: g(r, n), email: g(r, e).toLowerCase(), last4: digits4(g(r, ph)), dob: parseDob(g(r, bd)),
  }));
}

/**
 * Login check. The email may be any email listed for a player; the last 4 digits may match ANY phone listed for
 * any of that email's players (either parent). Returns the family's players and every email listed for them, or null.
 */
export function authorize(contacts, email, last4, dob) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !/^\d{4}$/.test(String(last4 || ""))) return null;
  const mine = contacts.filter((c) => c.email === email);
  if (!mine.length) return null;
  const same = (c, m) => c.org === m.org && samePlayer(c.player, m.player);
  const kin = contacts.filter((c) => mine.some((m) => same(c, m)));
  if (!kin.some((c) => c.last4 && c.last4 === String(last4))) return null;
  const born = parseDob(dob);
  if (!born || !kin.some((c) => c.dob && c.dob === born)) return null; // the birth date of any player on this account
  const players = [];
  for (const c of kin) if (!players.some((p) => p.org === c.org && samePlayer(p.player, c.player))) players.push({ org: c.org, team: c.team, player: c.player, payer: (mine.find((m) => same(c, m)) || c).name });
  return { email, players, emails: [...new Set(kin.map((c) => c.email).filter(Boolean))] };
}

// ------------------------------------------------------------ Google Sheets (read-only service account)
const b64url = (x) => Buffer.from(x).toString("base64url");
async function googleToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set.");
  const sa = JSON.parse(raw), now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }) });
  const body = await res.json();
  if (!res.ok) throw new Error("Google auth failed: " + (body.error_description || body.error));
  return body.access_token;
}

let cache = null; // { at, rows } kept while the function instance is warm
export async function getContacts() {
  if (process.env.DEMO === "1") return DEMO_CONTACTS;
  if (cache && Date.now() - cache.at < 60000) return cache.rows;
  const id = process.env.CONTACTS_SHEET_ID;
  if (!id) throw new Error("CONTACTS_SHEET_ID is not set.");
  const token = await googleToken();
  const range = process.env.CONTACTS_RANGE || "Contacts!A:Z";
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error("Google Sheets error: " + (body?.error?.message || res.status));
  cache = { at: Date.now(), rows: parseContacts(body.values || []) };
  return cache.rows;
}
export const clearContactsCache = () => { cache = null; };
