// server.js
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // derrière un LB

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres ---
const useSSL =
  DATABASE_URL &&
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

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
})().catch((e) => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function idxToChar(i){ return ALPHABET[i] || "_"; }
function charToIdx(c){ return ALPHABET.indexOf(c); }

function decodeBase64AlphabetNum(s){
  let v = 0n;
  for (const ch of s) {
    const i = BigInt(charToIdx(ch));
    if (i < 0n) continue;
    v = v * 64n + i;
  }
  const n = Number(v);
  return Math.max(0, Math.min(n, 1e13));
}
function cleanName(s) {
  if (!s) return "Player";
  s = String(s).replace(/[^\w \-\_]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = "Player";
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}
// Normalisation spécifique au protocole beacon
function normalizeBeaconName(raw) {
  if (!raw) return null;
  let s = String(raw);
  // en-tête style "_1__" ou "-1__"
  s = s.replace(/^[-_][A-Za-z0-9]__/, "");
  // underscores → espaces
  s = s.replace(/_/g, " ");
  s = cleanName(s);
  return s || null;
}
function msToStr(totalMs) {
  totalMs = Math.max(0, Math.min(parseInt(totalMs||0,10), 1e13));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function ok(res){ res.type("text/plain").send("ok\n"); }

// --- sessions mémoire (clé: IP) ---
const SESS = new Map(); // ip -> { last, fpBuf, world, helloAt, nBuf, tBuf, cBuf }
const SESS_TTL_MS = 10 * 60 * 1000;
const FRESH_MAX_AGE_MS = 5 * 60 * 1000; // 5 min

setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of SESS.entries()) {
    if (now - (s.last||0) > SESS_TTL_MS) SESS.delete(ip);
  }
}, 30000);

function touch(ip){
  let s = SESS.get(ip);
  if (!s) { s = {}; SESS.set(ip, s); }
  s.last = Date.now();
  return s;
}
function handshakeFresh(s){
  return s && s.helloAt && (Date.now() - s.helloAt) <= FRESH_MAX_AGE_MS;
}
function uidFromSession(s, ip){
  // uid = fingerprint (8 chars). Si absent, fallback IP hash.
  if (s && s.fpBuf && s.fpBuf.length > 0) return s.fpBuf;
  return "ip-" + crypto.createHash("sha1").update(ip).digest("hex").slice(0,8);
}

async function ensureRow(uid, world, displayName){
  const name = cleanName(displayName || `Player-${uid}`);
  const w = (world || "default").slice(0,64);
  await pool.query(`
    INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
    VALUES ($1,$2,$3,0,0,NOW())
    ON CONFLICT (user_id_hash) DO UPDATE
      SET world_id = EXCLUDED.world_id,
          updated_at = NOW()
  `, [uid, name, w]);
}

// --- health ---
app.get("/healthz", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }
  catch { res.status(500).type("text/plain").send("db\n"); }
});

// ------- Protocole 'BEACONS' -------

// Reset (tests éditeur)
app.get("/reset", (req,res)=>{
  SESS.clear();
  ok(res);
});

// Handshake /b/0..63  (8 appels), puis /commit?world=...
app.get("/b/:k(\\d+)", (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  const ch = idxToChar(k);
  if (!s.fpBuf || s.fpBuf.length >= 8) s.fpBuf = "";
  s.fpBuf += ch; // 8 symboles
  ok(res);
});

app.get("/commit", (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  s.world = String(req.query.world || "default").slice(0,64);
  s.helloAt = Date.now(); // démarre fenêtre "frais"
  ok(res);
});

// Nom
app.get("/nreset", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  s.nBuf = "";
  ok(res);
});
app.get("/n/:k(\\d+)", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  const ch = idxToChar(k);
  s.nBuf = (s.nBuf||"") + ch;
  ok(res);
});
app.get("/ncommit", async (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");

  const uid = uidFromSession(s, ip);
  const name = normalizeBeaconName(s.nBuf || "") || `Player-${uid}`;

  try{
    await ensureRow(uid, s.world, name);
    await pool.query(
      `UPDATE scores SET display_name=$2, world_id=$3, updated_at=NOW() WHERE user_id_hash=$1`,
      [uid, name, (s.world||"default").slice(0,64)]
    );
    ok(res);
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

// Temps total (ms) encodé base64-alphabet
app.get("/treset", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  s.tBuf = "";
  ok(res);
});
app.get("/t/:k(\\d+)", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  s.tBuf = (s.tBuf||"") + idxToChar(k);
  ok(res);
});
app.get("/tcommit", async (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const uid = uidFromSession(s, ip);
  const ms = decodeBase64AlphabetNum(s.tBuf||"");
  try{
    await ensureRow(uid, s.world, null);
    await pool.query(`
      UPDATE scores
      SET total_ms = GREATEST(total_ms, $2), world_id=$3, updated_at=NOW()
      WHERE user_id_hash=$1
    `,[uid, ms, (s.world||"default").slice(0,64)]);
    ok(res);
  }catch(e){ console.error(e); res.status(500).type("text/plain").send("db\n"); }
});

// Beans (entier) encodé base64-alphabet
app.get("/creset", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  s.cBuf = "";
  ok(res);
});
app.get("/c/:k(\\d+)", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  s.cBuf = (s.cBuf||"") + idxToChar(k);
  ok(res);
});
app.get("/ccommit", async (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const uid = uidFromSession(s, ip);
  const beans = decodeBase64AlphabetNum(s.cBuf||"");
  try{
    await ensureRow(uid, s.world, null);
    await pool.query(`
      UPDATE scores
      SET beans=$2, world_id=$3, updated_at=NOW()
      WHERE user_id_hash=$1
    `,[uid, beans, (s.world||"default").slice(0,64)]);
    ok(res);
  }catch(e){ console.error(e); res.status(500).type("text/plain").send("db\n"); }
});

// ------- Compat /hello + /u -------
const MAX_NAME = 24;
function clampInt(x, lo, hi) {
  x = Number.parseInt(x, 10);
  if (!Number.isFinite(x)) x = 0;
  return Math.max(lo, Math.min(x, hi));
}
function okKV(res, kv = {}) {
  const parts = ["ok"];
  for (const [k, v] of Object.entries(kv)) parts.push(`${k}=${v}`);
  res.type("text/plain").send(parts.join(":") + "\n");
}
const SESS2 = new Map(); // sid -> { uid, world, last }
function sessionNew(uid, world) {
  const sid = crypto.randomBytes(6).toString("base64url");
  SESS2.set(sid, { uid, world, last: Date.now() });
  return sid;
}
function sessionTouch(sid) {
  const s = SESS2.get(sid);
  if (s) s.last = Date.now();
  return s;
}

app.get("/hello", async (req, res) => {
  const uid = (req.query.uid || "").toString().slice(0, 32);
  const world = (req.query.world || "default").toString().slice(0, 64);
  const tx = (req.query.tx || "").toString();
  if (!uid || !tx) return res.status(400).type("text/plain").send("bad\n");
  const sid = sessionNew(uid, world);
  try {
    await ensureRow(uid, world, `Player-${uid}`);
  } catch (e) {
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }
  okKV(res, { sid, tx });
});

app.get("/u", async (req, res) => {
  const sid = (req.query.sid || "").toString();
  const tx = (req.query.tx || "").toString();
  const f  = clampInt(req.query.f || "0", 0, 7);
  if (!sid || !tx) return res.status(400).type("text/plain").send("bad\n");
  const s = sessionTouch(sid);
  if (!s) return res.status(401).type("text/plain").send("nosid\n");
  const uid = s.uid;
  const wantName  = (f & 1) !== 0;
  const wantTime  = (f & 2) !== 0;
  const wantBeans = (f & 4) !== 0;
  const name  = wantName  ? cleanName(req.query.n || "") : null;
  let ms      = wantTime  ? clampInt(req.query.t || "0", 0, 1e13) : null;
  let beans   = wantBeans ? clampInt(req.query.b || "0", 0, 1e13) : null;
  try {
    if (wantName) {
      await ensureRow(uid, s.world, name);
      await pool.query(
        `UPDATE scores SET display_name=$2, updated_at=NOW() WHERE user_id_hash=$1`,
        [uid, name]
      );
    }
    if (wantTime) {
      await ensureRow(uid, s.world, null);
      await pool.query(
        `UPDATE scores SET total_ms=GREATEST(total_ms,$2), updated_at=NOW() WHERE user_id_hash=$1`,
        [uid, ms]
      );
    }
    if (wantBeans) {
      await ensureRow(uid, s.world, null);
      await pool.query(
        `UPDATE scores SET beans=$2, updated_at=NOW() WHERE user_id_hash=$1`,
        [uid, beans]
      );
    }
  } catch (e) {
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }
  okKV(res, { tx });
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
    console.error(e);
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
    console.error(e);
    res.status(500).type("text/plain").send("error\n");
  }
});

app.get("/", (_req, res) => res.type("text/plain").send("ok\n"));
app.listen(PORT, () => console.log("Server listening on", PORT, "SSL:", !!useSSL));
