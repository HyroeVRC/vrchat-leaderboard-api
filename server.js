/* eslint-disable no-console */
"use strict";

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres (SSL auto Railway/Render) ---
const useSSL =
  DATABASE_URL !== "" &&
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
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
  // Index utile pour les tris par score
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scores_simple_total
      ON scores_simple (total_ms DESC);
  `);
  console.log("DB ready (scores_simple)");
})().catch((e) => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_#"; // 65 (64 + '#')

const pad = (n, w) => {
  n = String(n);
  return n.length >= w ? n : "0".repeat(w - n.length) + n;
};

const msToStr = (totalMs) => {
  if (!Number.isFinite(totalMs) || totalMs < 0) totalMs = 0;
  totalMs = Math.floor(totalMs);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(ms, 3)}`;
};

const cleanName = (s) => {
  if (!s) return "Player";
  s = String(s).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > 24) s = s.slice(0, 24); // cohérent avec le client
  // On garde tel quel pour l'affichage; la clé DB est le nom exact (après nettoyage).
  return s;
};

const clampMs = (x) => {
  let n = Number(String(x).replace(/[^0-9]/g, ""));
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 1e13) n = 1e13; // plafond large
  return Math.floor(n);
};

const normalizeIp = (ip) =>
  ip && ip.startsWith("::ffff:") ? ip.slice(7) : ip || "";

const clientIp = (req) => {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const raw = fwd ? fwd.split(",")[0].trim() : req.socket?.remoteAddress || "";
  return normalizeIp(raw);
};

const nocache = (res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
};

// --- petites limites anti-spam ---
const RATE = new Map(); // ip -> { t:number, c:number }
function rateLimit(ip, windowMs = 3000, max = 60) {
  const now = Date.now();
  let r = RATE.get(ip);
  if (!r || now - r.t > windowMs) r = { t: now, c: 0 };
  r.c++;
  RATE.set(ip, r);
  return r.c <= max;
}

// --- Sessions mémoire (par IP) ---
const SESSIONS = new Map(); // ip -> { packBuf: string, lastSeen: number }
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS.entries()) {
    if (now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
  }
}, 30_000);

function ensureSess(ip) {
  const now = Date.now();
  let s = SESSIONS.get(ip);
  if (!s) s = { packBuf: "", lastSeen: now };
  s.lastSeen = now;
  SESSIONS.set(ip, s);
  return s;
}

// --- middlewares ---
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

// ------------------------------------------------------------------------------------
// 1) FAST PATH DIRECT : /commit?data=Name#123456 (écrase total_ms pour ce display_name)
// ------------------------------------------------------------------------------------
app.get("/commit", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(ip)) return res.status(429).send("rate\n");

  const data = (req.query.data || "").toString();
  if (!data || !data.includes("#")) return res.status(400).send("bad\n");

  const idx = data.indexOf("#");
  const name = cleanName(data.slice(0, idx));
  const total_ms = clampMs(data.slice(idx + 1));

  try {
    await pool.query(
      `
      INSERT INTO scores_simple (display_name, total_ms, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (display_name) DO UPDATE
        SET total_ms = EXCLUDED.total_ms,
            updated_at = NOW()
      `,
      [name, total_ms]
    );
    res.send("ok\n");
  } catch (e) {
    console.error("commit error:", e);
    res.status(500).send("db\n");
  }
});

// ------------------------------------------------------------------------------------
// 2) PACK MODE (symbole par symbole) : /preset -> /p/:k -> /pcommit
//    payload concaténé = "<NAME>#<MS>"
//    ALPHABET: 64 symboles + '#' (index 64)
// ------------------------------------------------------------------------------------
app.get("/preset", (req, res) => {
  const ip = clientIp(req);
  const s = ensureSess(ip);
  s.packBuf = "";
  res.send("ok\n");
});

app.get("/p/:k", (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(ip)) return res.status(429).send("rate\n");

  const k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < ALPHABET.length)) return res.status(400).send("bad\n");

  const s = ensureSess(ip);

  // On borne la longueur: 64 (nom max) + 1 ('#') + 16 (ms max ~ 10^16)
  if (s.packBuf.length < 64 + 1 + 16) s.packBuf += ALPHABET[k];

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

  const name = cleanName(raw.slice(0, idx));
  const total_ms = clampMs(raw.slice(idx + 1));

  try {
    await pool.query(
      `
      INSERT INTO scores_simple (display_name, total_ms, updated_at)
      VALUES ($1, $2, NOW())
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

// ------------------------------------------------------------------------------------
// 3) PACK FAST PATH : /pfull/:payload  (payload = "<NAME>#<MS>")
// ------------------------------------------------------------------------------------
app.get("/pfull/:payload", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(ip)) return res.status(429).send("rate\n");

  const raw = (req.params.payload || "").toString();
  const idx = raw.indexOf("#");
  if (idx < 0) return res.status(400).send("badpack\n");

  const name = cleanName(raw.slice(0, idx));
  const total_ms = clampMs(raw.slice(idx + 1));

  try {
    await pool.query(
      `
      INSERT INTO scores_simple (display_name, total_ms, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (display_name) DO UPDATE
        SET total_ms = EXCLUDED.total_ms,
            updated_at = NOW()
      `,
      [name, total_ms]
    );
    res.send("ok\n");
  } catch (e) {
    console.error("pfull db error:", e);
    res.status(500).send("db\n");
  }
});

// --- Leaderboards ---
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

// --- boot/shutdown ---
const server = app.listen(PORT, () =>
  console.log("Server listening on", PORT, "SSL:", !!useSSL)
);

function shutdown() {
  console.log("Shutting down...");
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Pour éviter de crasher silencieusement
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
