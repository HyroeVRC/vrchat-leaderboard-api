// server.js
import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.use(express.json());
app.set("trust proxy", 1);
app.disable("x-powered-by");

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";
const API_SECRET = process.env.API_SECRET || "";

const useSSL =
  DATABASE_URL !== "" &&
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// ---------- DB init / migrations ----------
await pool.query(`
  CREATE TABLE IF NOT EXISTS scores (
    user_id_hash TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    world_id     TEXT,
    total_ms     BIGINT NOT NULL DEFAULT 0,
    beans_count  BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_scores_world  ON scores(world_id);
  CREATE INDEX IF NOT EXISTS idx_scores_name   ON scores(display_name);
  CREATE INDEX IF NOT EXISTS idx_scores_update ON scores(updated_at);
`);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const pad = (n,w)=>{ n=String(n); return n.length>=w?n:"0".repeat(w-n.length)+n; };
function msToStr(totalMs){
  if(totalMs<0) totalMs=0;
  let ms=Math.floor(totalMs);
  const h=Math.floor(ms/3600000); ms-=h*3600000;
  const m=Math.floor(ms/60000);   ms-=m*60000;
  const s=Math.floor(ms/1000);    ms-=s*1000;
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function clientIp(req){
  const fwd=(req.headers["x-forwarded-for"]||"").toString();
  return fwd?fwd.split(",")[0].trim():(req.socket.remoteAddress||"");
}
const aIndex=c=>{const i=ALPHABET.indexOf(c); return i<0?-1:i;};
function decodeAlphaNum(sym, cap=1e12){
  if(!sym||!sym.length) return 0;
  let v=0;
  for(let i=0;i<sym.length;i++){
    const k=aIndex(sym[i]); if(k<0) return null;
    v=v*64+k; if(!Number.isFinite(v)) return null;
  }
  if(v>cap) v=cap;
  return Math.floor(v);
}

// ---------- sessions par IP ----------
/*
  SESSIONS[ip] = { fpBuf(≤8), nameBuf(≤24), timeBuf(≤32), beansBuf(≤32), lastSeen }
*/
const SESSIONS = new Map();
// TTL plus long pour éviter les “noid” en cadence 10s
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(()=>{
  const now=Date.now();
  for(const [k,v] of SESSIONS.entries()){
    if(now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
  }
}, 30_000);

function ensureSess(ip){
  const now=Date.now();
  let s = SESSIONS.get(ip);
  if(!s) s={ fpBuf:"", nameBuf:"", timeBuf:"", beansBuf:"", lastSeen:now };
  s.lastSeen=now;
  SESSIONS.set(ip,s);
  return s;
}

// ---------- debug / health ----------
app.get("/start",(req,res)=>{ SESSIONS.delete(clientIp(req)); res.type("text/plain").send("ok\n"); });
app.get("/healthz",async(_req,res)=>{ try{ await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }catch{ res.status(500).type("text/plain").send("db\n"); }});

// ---------- 1) fingerprint ----------
app.get("/b/:k",(req,res)=>{
  const k=parseInt(req.params.k,10);
  if(!(k>=0&&k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s=ensureSess(clientIp(req));
  if(s.fpBuf.length<8) s.fpBuf += ALPHABET[k];
  return res.type("text/plain").send("ok\n");
});

// ---------- 2) display name ----------
app.get("/n/:k",(req,res)=>{
  const k=parseInt(req.params.k,10);
  if(!(k>=0&&k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s=ensureSess(clientIp(req));
  if(s.fpBuf.length<8) return res.status(400).type("text/plain").send("noid\n");
  if(s.nameBuf.length<24) s.nameBuf+=ALPHABET[k];
  return res.type("text/plain").send("ok\n");
});
app.get("/nreset",(req,res)=>{ const s=ensureSess(clientIp(req)); s.nameBuf=""; res.type("text/plain").send("ok\n"); });

app.get("/ncommit", async (req,res)=>{
  const ip=clientIp(req);
  const s = SESSIONS.get(ip);
  if(!s || s.fpBuf.length<8 || !s.nameBuf.length) return res.status(400).type("text/plain").send("noid\n");

  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const display_name = s.nameBuf;

  try{
    // 1) supprime tout doublon du même pseudo mais autre id
    await pool.query(`DELETE FROM scores WHERE display_name=$1 AND user_id_hash<>$2`, [display_name, user_id_hash]);

    // 2) upsert pour ce user_id_hash
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, beans_count, updated_at)
      VALUES ($1,$2,0,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at   = NOW()
    `,[user_id_hash, display_name]);

    s.nameBuf="";
    s.lastSeen=Date.now();
    return res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }
});

// ---------- 3) playtime absolu ----------
app.get("/t/:k",(req,res)=>{
  const k=parseInt(req.params.k,10);
  if(!(k>=0&&k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s=ensureSess(clientIp(req));
  if(s.fpBuf.length<8) return res.status(400).type("text/plain").send("noid\n");
  if(s.timeBuf.length<32) s.timeBuf+=ALPHABET[k];
  return res.type("text/plain").send("ok\n");
});
app.get("/treset",(req,res)=>{ const s=ensureSess(clientIp(req)); s.timeBuf=""; res.type("text/plain").send("ok\n"); });

app.get("/tcommit", async (req,res)=>{
  const ip=clientIp(req);
  const s = SESSIONS.get(ip);
  if(!s || s.fpBuf.length<8 || !s.timeBuf.length) return res.status(400).type("text/plain").send("noid\n");

  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const total_ms = decodeAlphaNum(s.timeBuf, 1e13);
  if(total_ms==null) return res.status(400).type("text/plain").send("bad\n");

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET total_ms  = EXCLUDED.total_ms,
            updated_at= NOW()
    `,[user_id_hash, "Player-"+user_id_hash.slice(3), total_ms]);

    s.timeBuf="";
    s.lastSeen=Date.now();
    return res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }
});

// ---------- 4) beans absolu ----------
app.get("/g/:k",(req,res)=>{
  const k=parseInt(req.params.k,10);
  if(!(k>=0&&k<64)) return res.status(400).type("text/plain").send("bad\n");
  const s=ensureSess(clientIp(req));
  if(s.fpBuf.length<8) return res.status(400).type("text/plain").send("noid\n");
  if(s.beansBuf.length<32) s.beansBuf+=ALPHABET[k];
  return res.type("text/plain").send("ok\n");
});
app.get("/greset",(req,res)=>{ const s=ensureSess(clientIp(req)); s.beansBuf=""; res.type("text/plain").send("ok\n"); });

app.get("/gcommit", async (req,res)=>{
  const ip=clientIp(req);
  const s = SESSIONS.get(ip);
  if(!s || s.fpBuf.length<8 || !s.beansBuf.length) return res.status(400).type("text/plain").send("noid\n");

  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const beans_count  = decodeAlphaNum(s.beansBuf, 1e9);
  if(beans_count==null) return res.status(400).type("text/plain").send("bad\n");

  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, beans_count, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET beans_count = EXCLUDED.beans_count,
            updated_at  = NOW()
    `,[user_id_hash, "Player-"+user_id_hash.slice(3), beans_count]);

    s.beansBuf="";
    s.lastSeen=Date.now();
    return res.type("text/plain").send("ok\n");
  }catch(e){
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }
});

// ---------- tag monde (optionnel, ne change PAS le pseudo) ----------
app.get("/commit", async (req,res)=>{
  const s = SESSIONS.get(clientIp(req));
  if(!s || s.fpBuf.length<8) return res.status(400).type("text/plain").send("noid\n");
  const user_id_hash = "fp_" + s.fpBuf.slice(0,8);
  const world_id = (req.query.world || "default").toString().slice(0,64);
  try{
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, updated_at)
      VALUES ($1,$2,$3,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET world_id  = EXCLUDED.world_id,
            updated_at= NOW()
    `,[user_id_hash,"Player-"+user_id_hash.slice(3),world_id]);
    res.type("text/plain").send("ok\n");
  }catch(e){ console.error(e); res.status(500).type("text/plain").send("db\n"); }
});

// ---------- leaderboard ----------
app.get("/leaderboard.json", async (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit || "50",10), 2000);
  const world_id = req.query.world_id || null;
  try{
    let rows;
    if(world_id){
      ({rows}=await pool.query(
        `SELECT display_name, total_ms, beans_count FROM scores
         WHERE world_id=$1
         ORDER BY total_ms DESC, beans_count DESC
         LIMIT $2`,[world_id, limit]
      ));
    }else{
      ({rows}=await pool.query(
        `SELECT display_name, total_ms, beans_count FROM scores
         ORDER BY total_ms DESC, beans_count DESC
         LIMIT $1`,[limit]
      ));
    }
    res.set("Cache-Control","no-store");
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:"db error"}); }
});

app.get("/leaderboard.txt", async (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit || "50",10), 2000);
  const world_id = req.query.world_id || null;
  try{
    let rows;
    if(world_id){
      ({rows}=await pool.query(
        `SELECT display_name, total_ms, beans_count FROM scores
         WHERE world_id=$1
         ORDER BY total_ms DESC, beans_count DESC
         LIMIT $2`,[world_id, limit]
      ));
    }else{
      ({rows}=await pool.query(
        `SELECT display_name, total_ms, beans_count FROM scores
         ORDER BY total_ms DESC, beans_count DESC
         LIMIT $1`,[limit]
      ));
    }
    const lines = rows.map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))} | ${Number(r.beans_count||0)}`);
    res.set("Content-Type","text/plain; charset=utf-8");
    res.set("Cache-Control","no-store");
    res.send(lines.join("\n")+"\n");
  }catch(e){ console.error(e); res.status(500).type("text/plain").send("error\n"); }
});

app.get("/",(_req,res)=>res.type("text/plain").send("ok\n"));
app.listen(PORT,()=>console.log("Server listening on",PORT,"SSL:",!!useSSL));
