import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";
const API_SECRET = process.env.API_SECRET || ""; // optionnel, pour /api/submit

// --- Postgres (SSL en cloud) ---
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
    user_id_hash TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    world_id TEXT,
    total_ms BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_scores_world ON scores(world_id);
`);

// --- util ---
function pad(n, w) {
  n = String(n);
  return n.length >= w ? n : "0".repeat(w - n.length) + n;
}
function msToStr(totalMs) {
  if (totalMs < 0) totalMs = 0;
  let ms = Math.floor(totalMs);
  const hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
  const mins  = Math.floor(ms / 60000);   ms -= mins  * 60000;
  const secs  = Math.floor(ms / 1000);    ms -= secs  * 1000;
  return `${pad(hours,2)}:${pad(mins,2)}:${pad(secs,2)}:${pad(ms,3)}`;
}
function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const ip = fwd ? fwd.split(",")[0].trim() : (req.socket.remoteAddress || "");
  return ip;
}

// --- SESSIONS (mémoire) ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SESSIONS = new Map(); // ip -> { buf:string(<=8), lastSeen:number, lastIncAt:number }
const NAMEBUF  = new Map(); // ip -> { name:string, lastSeen:number }

const SESSION_TTL_MS = 2 * 60 * 1000; // 2 min
const INC_RATE_MS    = 5 * 1000;      // 1 / 5s

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS.entries()) if (now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
  for (const [k, v] of NAMEBUF.entries())  if (now - v.lastSeen > SESSION_TTL_MS)  NAMEBUF.delete(k);
}, 30 * 1000);

// --- BEACONS fingerprint ---
// GET /b/:k
app.get("/b/:k", (req, res) => {
  const k = parseInt(req.params.k, 10);
  if (isNaN(k) || k < 0 || k >= 64) return res.status(400).type("text/plain").send("bad\n");
  const ip = clientIp(req);
  const now = Date.now();

  let s = SESSIONS.get(ip);
  if (!s) s = { buf: "", lastSeen: now, lastIncAt: 0 };
  if (s.buf.length < 8) s.buf += ALPHABET[k];
  s.lastSeen = now;
  SESSIONS.set(ip, s);
  res.type("text/plain").send("ok\n");
});

// DEBUG: reset / who
app.get("/start", (req, res) => {
  SESSIONS.set(clientIp(req), { buf: "", lastSeen: Date.now(), lastIncAt: 0 });
  NAMEBUF.delete(clientIp(req));
  res.type("text/plain").send("ok\n");
});
app.get("/who", (req, res) => {
  const s = SESSIONS.get(clientIp(req));
  const fp = s && s.buf ? s.buf.slice(0, 8) : "";
  res.type("text/plain").send(fp + "\n");
});

// --- BEACONS nom ---
// GET /n/:k
app.get("/n/:k", (req, res) => {
  const k = parseInt(req.params.k, 10);
  if (isNaN(k) || k < 0 || k >= 64) return res.status(400).type("text/plain").send("bad\n");
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.buf.length < 8) return res.status(400).type("text/plain").send("noid\n");

  const now = Date.now();
  let n = NAMEBUF.get(ip);
  if (!n) n = { name: "", lastSeen: now };
  if (n.name.length < 24) n.name += ALPHABET[k];
  n.lastSeen = now;
  NAMEBUF.set(ip, n);
  res.type("text/plain").send("ok\n");
});

// GET /ncommit  -> enregistre le display_name (depuis NAMEBUF)
app.get("/ncommit", async (req, res) => {
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  const n  = NAMEBUF.get(ip);
  if (!s || s.buf.length < 8 || !n) return res.status(400).type("text/plain").send("noid\n");

  const fingerprint   = s.buf.slice(0, 8);
  const user_id_hash  = "fp_" + fingerprint;
  const display_name  = n.name;

  try {
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, updated_at)
      VALUES ($1,$2,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name=EXCLUDED.display_name,
            updated_at=NOW()
    `, [user_id_hash, display_name]);
    NAMEBUF.delete(ip);
    res.type("text/plain").send("ok\n");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

// (optionnel) /commit?name=...
app.get("/commit", async (req, res) => {
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.buf.length < 8) return res.status(400).type("text/plain").send("noid\n");

  const fingerprint   = s.buf.slice(0, 8);
  const user_id_hash  = "fp_" + fingerprint;
  const display_name  = (req.query.name || ("Player-" + fingerprint)).toString().slice(0,32);

  try {
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, updated_at)
      VALUES ($1,$2,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name=EXCLUDED.display_name,
            updated_at=NOW()
    `, [user_id_hash, display_name]);
    res.type("text/plain").send("ok\n");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

// GET /i10  (+10s) – conserve le display_name existant s’il y en a un
app.get("/i10", async (req, res) => {
  const ip = clientIp(req);
  const s  = SESSIONS.get(ip);
  if (!s || s.buf.length < 8) return res.status(400).type("text/plain").send("noid\n");

  const now = Date.now();
  if (now - s.lastIncAt < 5000) return res.status(429).type("text/plain").send("slowdown\n");
  s.lastIncAt = now;
  s.lastSeen  = now;
  SESSIONS.set(ip, s);

  const user_id_hash = "fp_" + s.buf.slice(0, 8);

  try {
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, total_ms, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET total_ms = scores.total_ms + EXCLUDED.total_ms,
            updated_at = NOW()
    `, [user_id_hash, "Player-" + user_id_hash.slice(3), 10_000]);
    // ^^^ le display_name n’est utilisé que pour l’INSERT initial.
    // En cas de conflit, on N’UPDATE PAS display_name (il reste celui inscrit par /ncommit).
    res.type("text/plain").send("ok\n");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("db\n");
  }
});

// --- (optionnel) POST /api/submit (HMAC) ---
function isValidSignature(bodyObj, signature) {
  if (!API_SECRET) return false;
  try {
    const body = JSON.stringify(bodyObj);
    const hmac = crypto.createHmac("sha256", API_SECRET).update(body).digest("hex");
    return !!signature && signature.toLowerCase() === hmac;
  } catch { return false; }
}
app.post("/api/submit", async (req, res) => {
  const sig = req.headers["x-signature"];
  const body = req.body || {};
  if (!isValidSignature(body, sig)) {
    return res.status(401).json({ ok: false, error: "bad signature" });
  }
  let { user_id_hash, display_name, world_id, mode, total_ms, delta_ms } = body;
  if (!user_id_hash || !display_name) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }
  display_name = String(display_name).slice(0, 32);
  try {
    const { rows } = await pool.query("SELECT total_ms FROM scores WHERE user_id_hash=$1", [user_id_hash]);
    let newTotal = 0;
    if (mode === "increment") {
      const inc = Math.max(0, Number(delta_ms || 0));
      const base = rows.length ? Number(rows[0].total_ms || 0) : 0;
      newTotal = base + inc;
    } else {
      const incoming = Math.max(0, Number(total_ms || 0));
      const base = rows.length ? Number(rows[0].total_ms || 0) : 0;
      newTotal = Math.max(base, incoming);
    }
    await pool.query(`
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name=EXCLUDED.display_name,
            world_id=EXCLUDED.world_id,
            total_ms=EXCLUDED.total_ms,
            updated_at=NOW()
    `, [user_id_hash, display_name, world_id || null, newTotal]);
    res.json({ ok: true, total_ms: newTotal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db error" });
  }
});

// --- Leaderboards ---
app.get("/leaderboard.json", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world_id = req.query.world_id || null;
  try {
    let rows;
    if (world_id) {
      ({ rows } = await pool.query(
        `SELECT display_name, total_ms FROM scores
         WHERE world_id=$1
         ORDER BY total_ms DESC
         LIMIT $2`, [world_id, limit]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT display_name, total_ms FROM scores
         ORDER BY total_ms DESC
         LIMIT $1`, [limit]
      ));
    }
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db error" });
  }
});
app.get("/leaderboard.txt", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world_id = req.query.world_id || null;
  try {
    let rows;
    if (world_id) {
      ({ rows } = await pool.query(
        `SELECT display_name, total_ms FROM scores
         WHERE world_id=$1
         ORDER BY total_ms DESC
         LIMIT $2`, [world_id, limit]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT display_name, total_ms FROM scores
         ORDER BY total_ms DESC
         LIMIT $1`, [limit]
      ));
    }
    const lines = rows.map(r => `[${r.display_name}] : ${msToStr(Number(r.total_ms||0))}`);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(lines.join("\n") + "\n");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("error\n");
  }
});

app.get("/", (_, res) => res.type("text/plain").send("ok\n"));

app.listen(PORT, () => {
  console.log("Server listening on", PORT, "SSL:", !!useSSL);
});
