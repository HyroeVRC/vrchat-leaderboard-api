// server.js
"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const pino = require("pino");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

const log = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

// --- ENV ---
const PORT = parseInt(process.env.PORT || "8080", 10);
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres ---
const useSSL = DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});
pool.on("error", (err) => log.error({ err }, "pg pool error"));

// --- DB init ---
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_id_hash TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      world_id     TEXT,
      total_ms     BIGINT NOT NULL DEFAULT 0,
      beans        BIGINT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scores_world ON scores(world_id);
  `);
  log.info("DB init ok");
})().catch((e) => {
  log.error({ err: e }, "DB init failed");
  process.exit(1);
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function idxToChar(i) { return ALPHABET[i] || "_"; }
function charToIdx(c) { return ALPHABET.indexOf(c); }

function decodeBase64AlphabetNum(s) {
  let v = 0n;
  for (const ch of String(s || "")) {
    const i = BigInt(charToIdx(ch));
    if (i < 0n) continue;
    v = v * 64n + i;
  }
  const n = Number(v);
  return Math.max(0, Math.min(n, 1e13));
}

function cleanName(s) {
  if (!s) return "Player";
  s = String(s)
    .replace(/-/g, "_")
    .replace(/[^\w _]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "Player";
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

function msToStr(totalMs) {
  totalMs = Math.max(0, Math.min(parseInt(totalMs || 0, 10), 1e13));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(ms, 3)}`;
}

function okPlain(res, txt = "ok\n") {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(txt);
}

// --- Sessions mémoire (clé = sid plutôt que IP) ---
const SESS = new Map(); // sid -> { last, fpBuf, world, helloAt, lBuf, ip }
const SESS_TTL_MS = 10 * 60 * 1000;
// IMPORTANT: aligne avec le client (voir AutoBeacon) ~ 5 min
const FRESH_MAX_AGE_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of SESS.entries()) {
    if (now - (s.last || 0) > SESS_TTL_MS) SESS.delete(sid);
  }
}, 30000);

function getSid(req) {
  const raw = String(req.query.sid || "").trim();
  if (!raw) return "ip-" + crypto.createHash("sha1").update(req.ip || "").digest("hex").slice(0, 12);
  // limite taille & alphabet permissif
  return raw.slice(0, 32);
}

function touchSid(req) {
  const sid = getSid(req);
  let s = SESS.get(sid);
  if (!s) {
    s = { ip: req.ip };
    SESS.set(sid, s);
  }
  s.last = Date.now();
  return { s, sid };
}

function handshakeFresh(s) {
  return s && s.helloAt && (Date.now() - s.helloAt) <= FRESH_MAX_AGE_MS;
}

function uidFromSession(s, ip, sid) {
  if (s && s.fpBuf && s.fpBuf.length > 0) return s.fpBuf; // fingerprint si présent
  if (sid) return "sid-" + sid;
  return "ip-" + crypto.createHash("sha1").update(ip || "").digest("hex").slice(0, 8);
}

// --- Rate limit (GET only, VRChat friendly) ---
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 60, // 60 req/10s/sid+ip
  keyGenerator: (req) => `${getSid(req)}|${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- health ---
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    okPlain(res);
  } catch {
    res.status(500);
    okPlain(res, "db\n");
  }
});

// ------- Handshake /b + /commit -------
app.get("/reset", (req, res) => {
  const { sid } = touchSid(req);
  // uniquement pour débug local — en prod, préférez ne pas exposer
  SESS.delete(sid);
  okPlain(res);
});

app.get("/b/:k(\\d+)", (req, res) => {
  const { s } = touchSid(req);
  const k = Math.max(0, Math.min(parseInt(req.params.k, 10), 63));
  const ch = idxToChar(k);
  if (!s.fpBuf || s.fpBuf.length >= 8) s.fpBuf = "";
  s.fpBuf += ch;
  okPlain(res);
});

app.get("/commit", (req, res) => {
  const { s } = touchSid(req);
  s.world = String(req.query.world || "default").slice(0, 64);
  s.helloAt = Date.now();
  okPlain(res);
});

// ------- NOUVEAU : endpoint one-shot /lone -------
// GET /lone?sid=<sid>&s=<name>-<t64>-<c64>
app.get("/lone", async (req, res) => {
  const { s, sid } = touchSid(req);
  if (!handshakeFresh(s)) {
    res.status(400);
    return okPlain(res, "old\n");
  }

  const payload = String(req.query.s || "");
  if (!payload || payload.length > 512) {
    res.status(400);
    return okPlain(res, "bad\n");
  }

  const a = payload.split("-");
  if (a.length < 3) {
    res.status(400);
    return okPlain(res, "bad\n");
  }

  const name = cleanName(a.slice(0, a.length - 2).join("_"));
  const ms = decodeBase64AlphabetNum(a[a.length - 2]);
  const beans = decodeBase64AlphabetNum(a[a.length - 1]);

  const uid = uidFromSession(s, req.ip, sid);
  const world = (s.world || "default").slice(0, 64);

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            total_ms     = GREATEST(scores.total_ms, EXCLUDED.total_ms),
            beans        = GREATEST(scores.beans,     EXCLUDED.beans),
            world_id     = EXCLUDED.world_id,
            updated_at   = NOW()
    `,
      [uid, name, world, ms, beans]
    );

    res.set("Cache-Control", "no-store");
    res.json({ ok: true, uid, world, ms, beans });
  } catch (e) {
    log.error({ err: e }, "db upsert error");
    res.status(500).type("text/plain").send("db\n");
  }
});

// ------- (optionnel) protocole LIGNE legacy (conservé pour compat) -------
app.get("/lreset", (req, res) => {
  const { s } = touchSid(req);
  if (!handshakeFresh(s)) {
    res.status(400);
    return okPlain(res, "old\n");
  }
  s.lBuf = "";
  okPlain(res);
});

app.get("/l/:k(\\d+)", (req, res) => {
  const { s } = touchSid(req);
  if (!handshakeFresh(s)) {
    res.status(400);
    return okPlain(res, "old\n");
  }
  const k = Math.max(0, Math.min(parseInt(req.params.k, 10), 63));
  s.lBuf = (s.lBuf || "") + idxToChar(k);
  okPlain(res);
});

app.get("/lcommit", async (req, res) => {
  const { s, sid } = touchSid(req);
  if (!handshakeFresh(s)) {
    res.status(400);
    return okPlain(res, "old\n");
  }

  const uid = uidFromSession(s, req.ip, sid);
  const world = (s.world || "default").slice(0, 64);
  const buf = String(s.lBuf || "");

  const a = buf.split("-");
  if (a.length < 3) {
    res.status(400);
    return okPlain(res, "bad\n");
  }

  const name = cleanName(a.slice(0, a.length - 2).join("_"));
  const ms = decodeBase64AlphabetNum(a[a.length - 2]);
  const beans = decodeBase64AlphabetNum(a[a.length - 1]);

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            total_ms     = GREATEST(scores.total_ms, EXCLUDED.total_ms),
            beans        = GREATEST(scores.beans,     EXCLUDED.beans),
            world_id     = EXCLUDED.world_id,
            updated_at   = NOW()
    `,
      [uid, name, world, ms, beans]
    );
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, uid, world, ms, beans });
  } catch (e) {
    log.error({ err: e }, "db upsert error");
    res.status(500).type("text/plain").send("db\n");
  }
});

// --- Leaderboards ---
app.get("/leaderboard.json", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world = req.query.world || null;
  try {
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world) { sql += ` WHERE world_id=$1`; args.push(String(world)); }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    res.set("Cache-Control", "no-store").json(rows);
  } catch (e) {
    log.error({ err: e }, "leaderboard.json error");
    res.status(500).json({ ok: false, error: "db error" });
  }
});

app.get("/leaderboard.txt", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world = req.query.world || null;
  try {
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world) { sql += ` WHERE world_id=$1`; args.push(String(world)); }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    const lines = rows.map(
      (r) => `[${r.display_name}] : ${msToStr(Number(r.total_ms || 0))} | ${Number(r.beans || 0)}`
    );
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(lines.join("\n") + "\n");
  } catch (e) {
    log.error({ err: e }, "leaderboard.txt error");
    res.status(500).type("text/plain").send("error\n");
  }
});

// --- v2 paginée (JSON) ---
app.get("/leaderboard/v2", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  const world = req.query.world || null;

  try {
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world) { sql += ` WHERE world_id=$1`; args.push(String(world)); }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit} OFFSET ${offset}`;

    const { rows } = await pool.query(sql, args);
    res.set("Cache-Control", "no-store").json({ ok: true, rows, limit, offset });
  } catch (e) {
    log.error({ err: e }, "leaderboard v2 error");
    res.status(500).json({ ok: false, error: "db error" });
  }
});

app.get("/", (_req, res) => okPlain(res, "ok\n"));

app.listen(PORT, () => log.info({ port: PORT, ssl: !!useSSL }, "Server listening"));
