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
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function pad(n, w){ n=String(n); return n.length>=w?n:"0".repeat(w-n.length)+n; }
function msToStr(totalMs){
  if (!Number.isFinite(totalMs) || totalMs < 0) totalMs = 0;
  totalMs = Math.floor(totalMs);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,3).slice(1)}:${pad(ms,3)}`;
}
function aIndex(c){ const i = ALPHABET.indexOf(c); return i < 0 ? -1 : i; }
function decode64ToNumber(sym){
  if (!sym || !sym.length) return 0;
  let v = 0;
  for (let i = 0; i < sym.length; i++){
    const k = aIndex(sym[i]); if (k < 0) return null;
    v = v * 64 + k; if (!Number.isFinite(v)) return null;
  }
  if (v > 1e13) v = 1e13;
  return Math.floor(v);
}
function cleanName(s){
  if (!s) return "Player";
  s = String(s).replace(/[\r\n\t]/g," ").replace(/\s+/g," ").trim();
  if (s.length > 24) s = s.slice(0,24);
  return s;
}
function clientIp(req){
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  return fwd ? fwd.split(",")[0].trim() : (req.socket.remoteAddress || "");
}

// --- Sessions mémoire (par IP) ---
// s = { fpBuf(≤8), nameBuf(≤24), timeBuf(≤32), beansBuf(≤16), lastSeen }
const SESSIONS = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(()=>{
  const now = Date.now();
  for (const [k,v] of SESSIONS.entries())
    if (now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
}, 30000);

function ensureSess(ip){
  const now = Date.now();
  let s = SESSIONS.get(ip);
  if (!s) s = { fpBuf:"", nameBuf:"", timeBuf:"", beansBuf:"", lastSeen: now };
  s.lastSeen = now;
  SESSIONS.set(ip, s);
  return s;
}

// --- Routes communes ---
app.get("/healthz", async (_req,res)=>{
  try { await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }
  catch { res.status(500).type("text/plain").send("db\n"); }
});
app.get("/start", (req,res)=>{ SESSIONS.delete(clientIp(req)); res.type("text/plain").send("ok\n"); });

app.get("/reset", (req,res)=>{
  const s = ensureSess(clientIp(req));
  s.fpBuf=""; s.nameBuf=""; s.timeBuf=""; s.beansBuf="";
  res.type("text/plain").send("ok\n");
});

app.get("/b/:k", (req,res)=>{
  const k = parseInt(req.params.k,10);
  if (!(k>=0 && k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.fpBuf.length < 8) s.fpBuf += ALPHABET[k];
  res.type("text/plain").send("ok\n");
});

app.get("/commit", async (req,res)=>{
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.fpBuf.length < 8) return res.status(400).type("text/plain").send("noid\n");

  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const world_id = (req.query.world || "default").toString().slice(0,64);

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,0,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET world_id = EXCLUDED.world_id,
            updated_at = NOW()
    `,[user_id_hash, "Player-"+user_id_hash.slice(3), world_id]);
    res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

app.get("/nreset", (req,res)=>{
  const s = ensureSess(clientIp(req));
  s.nameBuf = "";
  res.type("text/plain").send("ok\n");
});
app.get("/n/:k", (req,res)=>{
  const k = parseInt(req.params.k,10);
  if (!(k>=0 && k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.nameBuf.length < 24) s.nameBuf += ALPHABET[k];
  res.type("text/plain").send("ok\n");
});
app.get("/ncommit", async (req,res)=>{
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.fpBuf.length < 8 || !s.nameBuf.length) return res.status(400).type("text/plain").send("noid\n");

  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const display_name = cleanName(s.nameBuf);

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
      VALUES ($1,$2,0,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at = NOW()
    `,[user_id_hash, display_name]);
    s.nameBuf = "";
    res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

app.get("/treset", (req,res)=>{
  const s = ensureSess(clientIp(req));
  s.timeBuf = "";
  res.type("text/plain").send("ok\n");
});
app.get("/t/:k", (req,res)=>{
  const k = parseInt(req.params.k,10);
  if (!(k>=0 && k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.timeBuf.length < 32) s.timeBuf += ALPHABET[k];
  res.type("text/plain").send("ok\n");
});
app.get("/tcommit", async (req,res)=>{
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.fpBuf.length < 8 || !s.timeBuf.length) return res.status(400).type("text/plain").send("noid\n");
  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);

  const total_ms = decode64ToNumber(s.timeBuf);
  if (total_ms == null) return res.status(400).type("text/plain").send("bad\n");

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET total_ms = GREATEST(scores.total_ms, EXCLUDED.total_ms),
            updated_at = NOW()
    `,[user_id_hash, "Player-"+user_id_hash.slice(3), total_ms]);
    s.timeBuf = "";
    res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

app.get("/creset", (req,res)=>{
  const s = ensureSess(clientIp(req));
  s.beansBuf = "";
  res.type("text/plain").send("ok\n");
});
app.get("/c/:k", (req,res)=>{
  const k = parseInt(req.params.k,10);
  if (!(k>=0 && k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.beansBuf.length < 16) s.beansBuf += ALPHABET[k];
  res.type("text/plain").send("ok\n");
});
app.get("/ccommit", async (req,res)=>{
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.fpBuf.length < 8 || !s.beansBuf.length) return res.status(400).type("text/plain").send("noid\n");
  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);

  const beans = decode64ToNumber(s.beansBuf);
  if (beans == null) return res.status(400).type("text/plain").send("bad\n");

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
      VALUES ($1,$2,0,$3,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET beans = EXCLUDED.beans,
            updated_at = NOW()
    `,[user_id_hash, "Player-"+user_id_hash.slice(3), beans]);
    s.beansBuf = "";
    res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

app.get("/leaderboard.json", async (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit || "50",10), 2000);
  const world = req.query.world || null;
  try{
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world){ sql += ` WHERE world_id=$1`; args.push(world); }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    res.set("Cache-Control","no-store").json(rows);
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:"db error" });
  }
});

app.get("/leaderboard.txt", async (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit || "50",10), 2000);
  const world = req.query.world || null;
  try{
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world){ sql += ` WHERE world_id=$1`; args.push(world); }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    const lines = rows.map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))} | ${Number(r.beans||0)}`);
    res.set("Content-Type","text/plain; charset=utf-8");
    res.set("Cache-Control","no-store");
    res.send(lines.join("\n")+"\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("error\n");
  }
});

app.get("/", (_req,res)=>res.type("text/plain").send("ok\n"));

// --- Démarrage (init DB + listen) ---
async function start(){
  try{
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
    app.listen(PORT, ()=> console.log("Server listening on", PORT, "SSL:", !!useSSL));
  }catch(e){
    console.error("DB init error:", e);
    process.exit(1);
  }
}
start();
