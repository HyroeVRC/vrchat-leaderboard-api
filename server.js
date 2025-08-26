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
function cleanName(s) {
  if (!s) return "Player";
  s = String(s)
    .replace(/[^\w \-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "Player";
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}
function msFromHMSms(hmsms) {
  // expected "HH:MM:SS:ms"
  if (!hmsms || typeof hmsms !== "string") return 0;
  const parts = hmsms.split(":"); // [HH, MM, SS, ms]
  if (parts.length !== 4) return 0;
  const [HH, MM, SS, MS] = parts.map((p) => parseInt(p, 10) || 0);
  const ms =
    Math.max(0, HH) * 3600000 +
    Math.max(0, Math.min(MM, 59)) * 60000 +
    Math.max(0, Math.min(SS, 59)) * 1000 +
    Math.max(0, Math.min(MS, 999));
  return Math.min(ms, 1e13);
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
function ok(res) {
  res.type("text/plain").send("ok\n");
}
async function ensureRow(uid, world, displayName) {
  const name = cleanName(displayName || `Player-${uid}`);
  const w = (world || "default").slice(0, 64);
  await pool.query(
    `
    INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
    VALUES ($1,$2,$3,0,0,NOW())
    ON CONFLICT (user_id_hash) DO UPDATE
      SET world_id = EXCLUDED.world_id,
          updated_at = NOW()
  `,
    [uid, name, w]
  );
}

// --- health / reset (dev) ---
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.type("text/plain").send("ok\n");
  } catch {
    res.status(500).type("text/plain").send("db\n");
  }
});
app.get("/reset", async (_req, res) => {
  // dev only
  try {
    await pool.query("TRUNCATE scores");
  } catch (e) {
    console.error(e);
  }
  ok(res);
});

// ----------------- NOUVEAU ENDPOINT -----------------
// GET /line?world=MyWorld&v=<url-encoded 'Name#HH:MM:SS:ms#beans'>
//
// Exemple : /line?world=TheLoadingScreen&v=HipsterFoxx%2300%3A21%3A30%3A970%230
app.get("/line", async (req, res) => {
  const world = (req.query.world || "default").toString().slice(0, 64);
  const raw = (req.query.v || "").toString(); // doit être URL-encodé côté client
  if (!raw) return res.status(400).type("text/plain").send("bad\n");

  // Split en 3 parties
  const parts = raw.split("#");
  if (parts.length !== 3)
    return res.status(400).type("text/plain").send("bad\n");

  let [nameRaw, timeStr, beansStr] = parts;
  const name = cleanName(nameRaw);
  const totalMs = msFromHMSms(timeStr);
  const beans = Math.max(0, Math.min(parseInt(beansStr || "0", 10) || 0, 1e13));

  // uid = hash(world + "|" + name) pour rester stable et éviter la collision inter-mondes
  const uid = crypto
    .createHash("sha1")
    .update(`${world}|${name}`)
    .digest("hex")
    .slice(0, 16);

  try {
    await ensureRow(uid, world, name);
    await pool.query(
      `
      UPDATE scores
      SET display_name=$2,
          total_ms = GREATEST(total_ms, $3),
          beans    = $4,
          world_id = $5,
          updated_at = NOW()
      WHERE user_id_hash=$1
    `,
      [uid, name, totalMs, beans, world]
    );
    ok(res);
  } catch (e) {
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
    if (world) {
      sql += ` WHERE world_id=$1`;
      args.push(String(world));
    }
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
    if (world) {
      sql += ` WHERE world_id=$1`;
      args.push(String(world));
    }
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
app.listen(PORT, () =>
  console.log("Server listening on", PORT, "SSL:", !!useSSL)
);
