/* eslint-disable no-console */
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres (SSL auto pour Railway/Render, etc.) ---
const useSSL =
  DATABASE_URL !== "" &&
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

// --- DB init ---
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores_simple (
      display_name TEXT PRIMARY KEY,
      total_ms     BIGINT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("DB ready (scores_simple)");
})().catch((e) => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_#";
if (ALPHABET.length !== 65) {
  // NOTE: 64 standards + on a ajouté '#' → 65. On utilisera k in [0..64].
  // Si vous voulez strictement 64, retirez un symbole que vous n'utilisez pas.
  // Par défaut on garde 65 pour simplifier côté Udon si vous voulez aussi '#'.
  console.warn("ALPHABET length is", ALPHABET.length, "(expected 65 with '#').");
}
const aIndex = (c) => {
  const i = ALPHABET.indexOf(c);
  return i < 0 ? -1 : i;
};

const pad = (n, w) => {
  n = String(n);
  return n.length >= w ? n : "0".repeat(w - n.length) + n;
};

const msToStr = (totalMs) => {
  if (!Number.isFinite(totalMs) || totalMs < 0) totalMs = 0;
  totalMs = Math.floor(totalMs);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(ms, 3)}`;
};

const cleanName = (s) => {
  if (!s) return "Player";
  s = String(s).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > 24) s = s.slice(0, 24);
  return s;
};

const normalizeIp = (ip) => (ip && ip.startsWith("::ffff:") ? ip.slice(7) : ip || "");
const clientIp = (req) => {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const raw = fwd ? fwd.split(",")[0].trim() : (req.socket?.remoteAddress || "");
  return normalizeIp(raw);
};
const nocache = (res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
};

// --- Sessions mémoire (par IP) ---
// s = { packBuf: string, lastSeen: number }
const SESSIONS = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS.entries())
    if (now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
}, 30000);

function ensureSess(ip) {
  const now = Date.now();
  let s = SESSIONS.get(ip);
  if (!s) s = { packBuf: "", lastSeen: now };
  s.lastSeen = now;
  SESSIONS.set(ip, s);
  return s;
}

// --- sécurité minimale & no-cache ---
app.use((req, res, next) => {
  res.type("text/plain; charset=utf-8");
  nocache(res);
  next();
});

// --- Health ---
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.send("ok\n");
  } catch {
    res.status(500).send("db\n");
  }
});

// --- Pack simple ---
// /preset -> reset le buffer
// /p/:k  -> ajoute un caractère ALPHABET[k]
// /pcommit -> parse "<NAME>#<MS>" et écrase en DB

app.get("/preset", (req, res) => {
  const s = ensureSess(clientIp(req));
  s.packBuf = "";
  res.send("ok\n");
});

app.get("/p/:k", (req, res) => {
  let k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < ALPHABET.length)) return res.status(400).send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.packBuf.length < 64 + 1 + 16) {
    // 64 nom max (on recoupera), '#' (1), 16 chiffres pour ms (large)
    s.packBuf += ALPHABET[k];
  }
  res.send("ok\n");
});

app.get("/pcommit", async (req, res) => {
  const ip = clientIp(req);
  const s = SESSIONS.get(ip);
  if (!s || !s.packBuf) return res.status(400).send("nopack\n");

  const raw = s.packBuf;
  s.packBuf = "";

  const idx = raw.indexOf("#");
  if (idx < 0) return res.status(400).send("badpack\n");

  let name = cleanName(raw.slice(0, idx));
  let msStr = raw.slice(idx + 1).replace(/[^0-9]/g, "");
  if (!msStr) msStr = "0";
  let total_ms = Number(msStr);
  if (!Number.isFinite(total_ms) || total_ms < 0) total_ms = 0;

  try {
    await pool.query(
      `
      INSERT INTO scores_simple(display_name, total_ms, updated_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (display_name) DO UPDATE
        SET total_ms = EXCLUDED.total_ms,
            updated_at = NOW()
    `,
      [name, total_ms]
    );
    res.send("ok\n");
  } catch (e) {
    console.error("pcommit db error:", e);
    res.status(500).send("db\n");
  }
});

// --- Leaderboards (simple) ---
app.get("/leaderboard.json", async (_req, res) => {
  res.type("application/json; charset=utf-8");
  try {
    const { rows } = await pool.query(
      `SELECT display_name, total_ms FROM scores_simple ORDER BY total_ms DESC LIMIT 2000`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db error" });
  }
});

app.get("/leaderboard.txt", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT display_name, total_ms FROM scores_simple ORDER BY total_ms DESC LIMIT 2000`
    );
    const lines = rows.map(
      (r) => `[${r.display_name}] : ${msToStr(Number(r.total_ms || 0))}`
    );
    res.send(lines.join("\n") + "\n");
  } catch (e) {
    console.error(e);
    res.status(500).send("error\n");
  }
});

app.get("/", (_req, res) => res.send("ok\n"));

const server = app.listen(PORT, () =>
  console.log("Server listening on", PORT, "SSL:", !!useSSL)
);
function shutdown() {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
