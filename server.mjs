import express from "express";
import { Pool } from "pg";

const app = express();
app.disable("x-powered-by");

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres (SSL pour hébergeurs type Railway/Render) ---
const useSSL =
  DATABASE_URL !== "" &&
  !DATABASE_URL.includes("localhost") &&
  !DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// --- DB init ---
await pool.query(`
  CREATE TABLE IF NOT EXISTS scores (
    user_id     TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    world_id     TEXT,
    total_ms     BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_scores_world ON scores(world_id);
`);

// --- utils ---
function pad(n, w){ n=String(n); return n.length>=w?n:"0".repeat(w-n.length)+n; }
function msToStr(totalMs){
  if (!Number.isFinite(totalMs) || totalMs < 0) totalMs = 0;
  totalMs = Math.floor(totalMs);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function cleanName(s){
  if (!s) return "Player";
  s = String(s);
  s = s.replace(/[\r\n\t]/g, " ");      // pas de contrôles
  s = s.replace(/\s+/g, " ").trim();    // espaces propres
  if (s.length > 24) s = s.slice(0,24); // limite raisonnable
  return s;
}
function clampMs(x){
  let n = Number(x);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 1e12) n = 1e12;               // ~11 jours en ms plafond large
  return Math.floor(n);
}

// --- 1) Mise à jour simple par GET (compatible VRChat) ---
// Exemple d'appel :
//   GET /update?uid=ABCD1234&name=MonPseudo&ms=123456&world=TheLoadingScreen&mode=max
//
// - uid : identifiant stable côté client (ex: hash du displayName)
// - name : pseudo (24 chars max côté serveur)
// - ms : temps total en millisecondes (entier >= 0)
// - world : (optionnel) tag de monde
// - mode : "max" (défaut) ou "set"
app.get("/update", async (req, res) => {
  const uid   = String(req.query.uid || "").slice(0, 64);
  const name  = cleanName(req.query.name);
  const ms    = clampMs(req.query.ms);
  const world = (req.query.world ? String(req.query.world) : "").slice(0, 64);
  const mode  = String(req.query.mode || "max").toLowerCase(); // max = ne baisse jamais

  if (!uid) return res.status(400).type("text/plain").send("missing uid\n");

  try {
    if (mode === "max") {
      await pool.query(`
        INSERT INTO scores(user_id, display_name, world_id, total_ms, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          world_id     = COALESCE(NULLIF(EXCLUDED.world_id,''), scores.world_id),
          total_ms     = GREATEST(scores.total_ms, EXCLUDED.total_ms),
          updated_at   = NOW()
      `, [uid, name, world, ms]);
    } else { // "set"
      await pool.query(`
        INSERT INTO scores(user_id, display_name, world_id, total_ms, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          world_id     = COALESCE(NULLIF(EXCLUDED.world_id,''), scores.world_id),
          total_ms     = EXCLUDED.total_ms,
          updated_at   = NOW()
      `, [uid, name, world, ms]);
    }
    res.set("Cache-Control", "no-store");
    res.json({ ok:true, uid, name, saved_ms: ms });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"db error" });
  }
});

// --- 2) Leaderboards ---
app.get("/leaderboard.json", async (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit || "50",10), 2000);
  const world = req.query.world || null;
  try{
    const args = [];
    let sql = `SELECT display_name, total_ms FROM scores`;
    if (world){ sql += ` WHERE world_id=$1`; args.push(world); }
    sql += ` ORDER BY total_ms DESC LIMIT ${limit}`;
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
    let sql = `SELECT display_name, total_ms FROM scores`;
    if (world){ sql += ` WHERE world_id=$1`; args.push(world); }
    sql += ` ORDER BY total_ms DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    const lines = rows.map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))}`);
    res.set("Content-Type","text/plain; charset=utf-8");
    res.set("Cache-Control","no-store");
    res.send(lines.join("\n")+"\n");
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("error\n");
  }
});

app.get("/healthz", async (_req,res)=>{
  try { await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }
  catch { res.status(500).type("text/plain").send("db\n"); }
});

app.get("/", (_req,res)=>res.type("text/plain").send("ok\n"));
app.listen(PORT, ()=> console.log("Server listening on", PORT, "SSL:", !!useSSL));
