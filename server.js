// server.js
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

// Node 18+ : fetch global
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";

// URL source à recopier vers GitHub Pages
const SOURCE_LEADERBOARD_URL =
  process.env.SOURCE_LEADERBOARD_URL ||
  "https://vrchat-leaderboard-api-theloadngscreen.up.railway.app/leaderboard.txt";

// GitHub publish env
const GH_TOKEN  = process.env.GITHUB_TOKEN || "";                 // PAT avec droits "Contents: Read & write"
const GH_OWNER  = process.env.GITHUB_OWNER  || "HyroeVRC";
const GH_REPO   = process.env.GITHUB_REPO   || "TheLoadingScreen";
const GH_PATH   = process.env.GITHUB_PATH   || "leaderboard.txt"; // chemin dans le dépôt
// ⚠️ Mets ici la branche qui sert GitHub Pages pour ce dépôt (souvent "gh-pages" ; parfois "main")
const GH_BRANCH = process.env.GITHUB_BRANCH || "gh-pages";

// Fréquence de publication (10 min par défaut)
const PUBLISH_INTERVAL_MS = parseInt(process.env.PUBLISH_INTERVAL_MS || "600000", 10);

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

// ------- Handshake /b + /commit -------
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

// ------- protocole "LIGNE" -------
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

  const a = buf.split("-");
  if (a.length < 3) return res.status(400).type("text/plain").send("bad\n");

  const namePart = a.slice(0, a.length - 2).join("_");
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

// --- helpers leaderboard build (DB → JSON/TXT locaux) ---
async function queryTopRows(limit, world) {
  const args = [];
  let sql = `SELECT display_name, total_ms, beans FROM scores`;
  if (world) { sql += ` WHERE world_id=$1`; args.push(String(world)); }
  sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, args);
  return rows;
}
function rowsToTxt(rows) {
  return rows
    .map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))} | ${Number(r.beans||0)}`)
    .join("\n") + "\n";
}

// --- Endpoints locaux (toujours utiles pour Unity direct) ---
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

// ---------- GitHub Publisher (cron) ----------

// Récupère { sha, text } du fichier sur GitHub (ou null s'il n'existe pas)
async function getGitHubFileInfo(owner, repo, path, branch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "User-Agent": "vrchat-leaderboard-publisher",
      "Accept": "application/vnd.github+json"
    }
  });
  if (r.status === 404) return { sha: null, text: null };
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  const j = await r.json();
  let text = null;
  if (j && j.content && j.encoding === "base64") {
    try { text = Buffer.from(j.content, "base64").toString("utf8"); } catch {}
  }
  return { sha: j.sha || null, text };
}

async function putGitHubFile(owner, repo, path, branch, contentUtf8, shaOrNull) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: "auto: update leaderboard.txt",
    content: Buffer.from(contentUtf8, "utf8").toString("base64"),
    branch: branch
  };
  if (shaOrNull) body.sha = shaOrNull;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "User-Agent": "vrchat-leaderboard-publisher",
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub PUT failed: ${r.status} ${txt}`);
  }
  return true;
}

// Récupère la source (Railway public) telle quelle
async function fetchSourceLeaderboardTxt() {
  const r = await fetch(SOURCE_LEADERBOARD_URL, {
    headers: {
      "Accept": "text/plain",
      "Cache-Control": "no-cache"
    }
  });
  if (!r.ok) throw new Error(`Source GET failed: ${r.status}`);
  const text = await r.text();
  if (!text || !text.trim()) throw new Error("Source empty");
  return text;
}

// Ajoute ceci à server.js
app.get("/push", async (req, res) => {
  const s = (req.ip && req.ip.toString()) || "";
  const uid = "ip-" + require("crypto").createHash("sha1").update(s).digest("hex").slice(0, 8);

  const name  = cleanName(req.query.name);
  const ms    = Math.max(0, Math.min(parseInt(req.query.ms || "0", 10), 1e13));
  const beans = Math.max(0, Math.min(parseInt(req.query.beans || "0", 10), 1e13));
  const world = (req.query.world || "default").toString().slice(0, 64);

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
    `, [uid, name, world, ms, beans]);
    res.type("text/plain").send("ok\n");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

async function publishToGitHub() {
  if (!GH_TOKEN) { console.log("[publish] skipped: no token"); return; }

  try {
    // 1) lire la source (ton endpoint Railway public)
    const newText = await fetchSourceLeaderboardTxt();

    // 2) lire la version actuelle sur GitHub
    const { sha, text: currentText } =
      await getGitHubFileInfo(GH_OWNER, GH_REPO, GH_PATH, GH_BRANCH);

    // 3) si inchangé → skip
    if (currentText !== null && currentText === newText) {
      console.log("[publish] no changes, skip.");
      return;
    }

    // 4) push sur GitHub (création si sha null, sinon update)
    await putGitHubFile(GH_OWNER, GH_REPO, GH_PATH, GH_BRANCH, newText, sha);
    console.log(`[publish] ${GH_OWNER}/${GH_REPO}@${GH_BRANCH}:${GH_PATH} updated.`);
  } catch (e) {
    console.error("[publish] failed:", e.message || e);
  }
}

// manual trigger
app.post("/publish-now", async (_req, res) => {
  try { await publishToGitHub(); res.type("text/plain").send("ok\n"); }
  catch(e){ res.status(500).type("text/plain").send("error\n"); }
});

// schedule
if (PUBLISH_INTERVAL_MS > 0) {
  setInterval(publishToGitHub, PUBLISH_INTERVAL_MS);
  console.log("[publish] scheduler on every", Math.round(PUBLISH_INTERVAL_MS/1000), "seconds");
}

app.listen(PORT, () => console.log("Server listening on", PORT, "SSL:", !!useSSL));
