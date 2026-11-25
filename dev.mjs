// Zero-dependency local preview with fake data:  node dev.mjs   then open http://localhost:8888  (demo@example.com / 1234)
process.env.DEMO = "1";
const { createServer } = await import("node:http");
const { readFile } = await import("node:fs/promises");
const { handleAccount, handleCheckout } = await import("./lib/portal.mjs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:8888");
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const r = url.pathname === "/api/account" ? await handleAccount(body, { delayMs: 0 }) : await handleCheckout(body, { delayMs: 0, site: "http://localhost:8888" });
    res.writeHead(r.status, { "content-type": "application/json" }); return res.end(JSON.stringify(r.json));
  }
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  try { const b = await readFile(new URL("./public" + p, import.meta.url)); res.writeHead(200, { "content-type": TYPES[p.slice(p.lastIndexOf("."))] || "text/plain" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8888, () => console.log("Preview at http://localhost:8888  (demo@example.com / 1234)"));
