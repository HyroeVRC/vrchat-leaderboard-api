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
const SOURCE_LEADERBOARD_URL =
  process.env.SOURCE_LEADERBOARD_URL ||
  "https://vrchat-leaderboard-api-theloadngscreen.up.railway.app/leaderboard.txt";

// GitHub publish env
const GH_TOKEN  = process.env.GITHUB_TOKEN || "";
const GH_OWNER  = process.env.GITHUB_OWNER  || "HyroeVRC";
const GH_REPO   = process.env.GITHUB_REPO   || "TheLoadingScreen";
const GH_PATH   = process.env.GITHUB_PATH   || "leaderboard.txt";
const GH_BRANCH = process.env.GITHUB_BRANCH || "gh-pages";
const PUBLISH_INTERVAL_MS = parseInt(process.env.PUBLISH_INTERVAL_MS || "600000", 10);

// --- Postgres ---
const useSSL = DATABASE_URL && !/localhost|127\.0\.0/.test(DATABASE_URL);
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
  totalMs = Math.max(0, Math.min(parseInt(totalMs||0,10), 1e13));
  const h  = Math.floor(totalMs / 3600000);
  const m  = Math.floor((totalMs % 3600000) / 60000);
  const s  = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function ok(res){ res.type("text/plain").send("ok\n"); }
function uidFromIp(ip){
  return "ip-" + crypto.createHash("sha1").update(ip||"").digest("hex").slice(0,8);
}

// --- health ---
app.get("/healthz", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.type("text/plain").send("ok\n"); }
  catch { res.status(500).type("text/plain").send("db\n"); }
});

// --- PUSH endpoints ---
// Format query string: /push?name=...&ms=...&beans=...&world=...
app.get("/push", async (req, res) => {
  await handlePush(req, res, {
    name:  req.query.name,
    ms:    req.query.ms,
    beans: req.query.beans,
    world: req.query.world,
  });
});

// Format path params: /push/:name/:ms/:beans/:world
app.get("/push/:name/:ms/:beans/:world", async (req, res) => {
  await handlePush(req, res, {
    name:  req.params.name,
    ms:    req.params.ms,
    beans: req.params.beans,
    world: req.params.world,
  });
});

async function handlePush(req, res, { name, ms, beans, world }) {
  const uid = uidFromIp(req.ip);

  const displayName = cleanName(name);
  const totalMs     = Math.max(0, Math.min(parseInt(ms || "0", 10), 1e13));
  const totalBeans  = Math.max(0, Math.min(parseInt(beans || "0", 10), 1e13));
  const worldId     = (world || "default").toString().slice(0, 64);

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
    `, [uid, displayName, worldId, totalMs, totalBeans]);
    ok(res);
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
}

// --- Leaderboard endpoints ---
async function queryTopRows(limit, world) {
  const args = [];
  let sql = `SELECT display_name, total_ms, beans FROM scores`;
  if (world) { sql += ` WHERE world_id=$1`; args.push(String(world)); }
  sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, args);
  return rows;
}
function rowsToTxt(rows) {
  return rows.map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))} | ${Number(r.beans||0)}`).join("\n") + "\n";
}
app.get("/leaderboard.json", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world = req.query.world || null;
  try {
    const rows = await queryTopRows(limit, world);
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
    const rows = await queryTopRows(limit, world);
    const body = rowsToTxt(rows);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(body);
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("error\n");
  }
});

app.get("/", (_req, res) => res.type("text/plain").send("ok\n"));

// --- GitHub Publisher (identique à ton script original) ---
// ... (tu gardes ton code publishToGitHub, getGitHubFileInfo, etc. inchangé)

app.listen(PORT, () => console.log("Server listening on", PORT, "SSL:", !!useSSL));
