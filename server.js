// server.js
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres ---
const useSSL = DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
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
  s = String(s)
    .replace(/-/g, "_")                 // '-' réservé comme séparateur
    .replace(/[^\w _]/g, " ")           // autorise lettres/chiffres/_/espace
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "Player";
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

function msToStr(totalMs) {
  totalMs = Math.max(0, Math.min(parseInt(totalMs||0,10), 1e13));
  const h  = Math.floor(totalMs / 3600000);
  const m  = Math.floor((totalMs % 3600000) / 60000);
  const s  = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function ok(res){ res.type("text/plain").send("ok\n"); }

function uidFromSession(s, ip){
  if (s && s.fpBuf && s.fpBuf.length > 0) return s.fpBuf;
  return "ip-" + crypto.createHash("sha1").update(ip||"").digest("hex").slice(0,8);
}

// --- sessions mémoire (clé: IP) ---
const SESS = new Map(); // ip -> { last, fpBuf, world, helloAt, lBuf }
const SESS_TTL_MS = 10*60*1000;
const FRESH_MAX_AGE_MS = 5*60*1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of SESS.entries()) {
    if (now - (s.last||0) > SESS_TTL_MS) SESS.delete(ip);
  }
}, 30000);

function touch(ip){
  let s = SESS.get(ip);
  if (!s){ s = {}; SESS.set(ip, s); }
  s.last = Date.now();
  return s;
}
function handshakeFresh(s){
  return s && s.helloAt && (Date.now() - s.helloAt) <= FRESH_MAX_AGE_MS;
}

// --- health ---
app.get("/healthz", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }
  catch { res.status(500).type("text/plain").send("db\n"); }
});

// ------- Handshake /b + /commit (on garde, simple & robuste) -------
app.get("/reset", (_req,res)=>{ SESS.clear(); ok(res); });

app.get("/b/:k(\\d+)", (req,res)=>{
  const s = touch(req.ip);
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  const ch = idxToChar(k);
  if (!s.fpBuf || s.fpBuf.length >= 8) s.fpBuf = "";
  s.fpBuf += ch;
  ok(res);
});
app.get("/commit", (req,res)=>{
  const s = touch(req.ip);
  s.world = String(req.query.world || "default").slice(0,64);
  s.helloAt = Date.now();
  ok(res);
});

// ------- NOUVEAU PROTOCOLE "LIGNE" -------
// /lreset -> clear buffer
// /l/<0..63> -> append one symbol (alphabet-64)
// /lcommit -> parse "<nameClean>-<time64>-<beans64>" then save row
app.get("/lreset", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  s.lBuf = "";
  ok(res);
});
app.get("/l/:k(\\d+)", (req,res)=>{
  const s = touch(req.ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");
  const k = Math.max(0, Math.min(parseInt(req.params.k,10), 63));
  s.lBuf = (s.lBuf||"") + idxToChar(k);
  ok(res);
});
app.get("/lcommit", async (req,res)=>{
  const ip = req.ip;
  const s = touch(ip);
  if (!handshakeFresh(s)) return res.status(400).type("text/plain").send("old\n");

  const uid   = uidFromSession(s, ip);
  const world = (s.world || "default").slice(0,64);
  const buf   = String(s.lBuf||"");

  // buf attendu: "<name>-<t64>-<c64>"  (name ne doit pas contenir '-')
  const a = buf.split("-");
  if (a.length < 3) return res.status(400).type("text/plain").send("bad\n");

  // Si le nom a contenu des '-' (devrait pas), on recolle tout sauf les 2 derniers en "name"
  const namePart = a.slice(0, a.length - 2).join("_"); // sécurise
  const t64 = a[a.length - 2];
  const c64 = a[a.length - 1];

  const name  = cleanName(namePart);
  const ms    = decodeBase64AlphabetNum(t64);
  const beans = decodeBase64AlphabetNum(c64);

  try {
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name=EXCLUDED.display_name,
            total_ms=GREATEST(scores.total_ms, EXCLUDED.total_ms),
            beans=EXCLUDED.beans,
            world_id=EXCLUDED.world_id,
            updated_at=NOW()
    `,[uid, name, world, ms, beans]);
    ok(res);
  } catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

// --- Leaderboards (inchangés) ---
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
