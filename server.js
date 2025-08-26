const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // important derrière un LB

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
const MAX_NAME = 24;
function cleanName(s) {
  if (!s) return "Player";
  s = String(s).replace(/[^\w \-\_]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = "Player";
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME);
  return s;
}
function clampInt(x, lo, hi) {
  x = Number.parseInt(x, 10);
  if (!Number.isFinite(x)) x = 0;
  if (x < lo) x = lo;
  if (x > hi) x = hi;
  return x;
}
function msToStr(totalMs) {
  totalMs = clampInt(totalMs, 0, 1e13);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}:${pad(ms,3)}`;
}
function ok(res, kv = {}) {
  // format "ok:tx=123;sid=abcd;..."
  const parts = ["ok"];
  for (const [k, v] of Object.entries(kv)) parts.push(`${k}=${v}`);
  res.type("text/plain").send(parts.join(":") + "\n");
}
const SESS = new Map(); // sid -> { uid, world, last }
const SESS_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of SESS.entries()) if (now - s.last > SESS_TTL_MS) SESS.delete(sid);
}, 30000);

function sessionNew(uid, world) {
  const sid = crypto.randomBytes(6).toString("base64url"); // 8-9 chars
  SESS.set(sid, { uid, world, last: Date.now() });
  return sid;
}
function sessionTouch(sid) {
  const s = SESS.get(sid);
  if (s) s.last = Date.now();
  return s;
}

// --- health ---
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.type("text/plain").send("ok\n");
  } catch {
    res.status(500).type("text/plain").send("db\n");
  }
});

// --- HELLO -> crée/rafraîchit une session et un squelette de score ---
app.get("/hello", async (req, res) => {
  const uid = (req.query.uid || "").toString().slice(0, 32);
  const world = (req.query.world || "default").toString().slice(0, 64);
  const tx = (req.query.tx || "").toString();

  if (!uid || !tx) return res.status(400).type("text/plain").send("bad\n");

  const sid = sessionNew(uid, world);

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,0,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET world_id = EXCLUDED.world_id,
            updated_at = NOW()
    `,
      [uid, `Player-${uid}`, world]
    );
  } catch (e) {
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }

  ok(res, { sid, tx });
});

// --- UPDATE compact ---
//  /u?sid&f&[n=...][t=...][b=...]&tx
//  f bitmask: 1=name, 2=time(ms, MAX), 4=beans(SET)
//  always answers "ok:tx=..."
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

  const name = wantName ? cleanName(req.query.n || "") : null;
  let ms    = wantTime ? clampInt(req.query.t || "0", 0, 1e13) : null;
  let beans = wantBeans ? clampInt(req.query.b || "0", 0, 1e13) : null;

  try {
    if (wantName) {
      await pool.query(
        `
        INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
        VALUES ($1,$2,0,0,NOW())
        ON CONFLICT (user_id_hash) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              updated_at = NOW()
      `,
        [uid, name]
      );
    }
    if (wantTime) {
      await pool.query(
        `
        INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
        VALUES ($1,$2,$3,0,NOW())
        ON CONFLICT (user_id_hash) DO UPDATE
          SET total_ms = GREATEST(scores.total_ms, EXCLUDED.total_ms),
              updated_at = NOW()
      `,
        [uid, `Player-${uid}`, ms]
      );
    }
    if (wantBeans) {
      await pool.query(
        `
        INSERT INTO scores(user_id_hash, display_name, total_ms, beans, updated_at)
        VALUES ($1,$2,0,$3,NOW())
        ON CONFLICT (user_id_hash) DO UPDATE
          SET beans = EXCLUDED.beans,
              updated_at = NOW()
      `,
        [uid, `Player-${uid}`, beans]
      );
    }
  } catch (e) {
    console.error(e);
    return res.status(500).type("text/plain").send("db\n");
  }

  ok(res, { tx });
});

// --- Leaderboards ---
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
app.listen(PORT, () => console.log("Server listening on", PORT, "SSL:", !!useSSL));
