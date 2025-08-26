/* eslint-disable no-console */
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
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

// --- DB init ---
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_id_hash TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      world_id     TEXT NOT NULL,
      total_ms     BIGINT NOT NULL DEFAULT 0,
      beans        BIGINT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scores_world ON scores(world_id);
    CREATE INDEX IF NOT EXISTS idx_scores_world_name ON scores(world_id, display_name);
  `);
  console.log("DB ready");
})().catch((e) => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// --- utils ---
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const aIndex = (c) => {
  const i = ALPHABET.indexOf(c);
  return i < 0 ? -1 : i;
};
const pad = (n, w) => {
  n = String(n);
  return n.length >= w ? n : "0".repeat(w - n.length) + n;
};
const msToStr = (totalMs) => {
  if (!Number.isFinite(totalMs) || totalMs < 0) totalMs = 0;
  totalMs = Math.floor(totalMs);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(ms, 3)}`;
};
const decode64ToNumber = (sym, maxLen) => {
  if (!sym || !sym.length) return 0;
  if (maxLen && sym.length > maxLen) sym = sym.slice(0, maxLen);
  let v = 0;
  for (let i = 0; i < sym.length; i++) {
    const k = aIndex(sym[i]);
    if (k < 0) return null;
    v = v * 64 + k;
    if (!Number.isFinite(v) || v > 1e16) return null;
  }
  if (v > 1e13) v = 1e13;
  return Math.floor(v);
};

// Le client envoie des symboles issus d'ALPHABET → gardons ça tel quel.
const sanitizeNameFromAlphabet = (s) => {
  if (!s) return "Player";
  s = String(s).trim();
  if (s.length > 24) s = s.slice(0, 24);
  return s;
};
const normalizeIp = (ip) => (ip && ip.startsWith("::ffff:") ? ip.slice(7) : ip || "");
const clientIp = (req) => {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const raw = fwd ? fwd.split(",")[0].trim() : (req.socket?.remoteAddress || "");
  return normalizeIp(raw);
};
const nocache = (res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
};

// --- Sessions mémoire (par IP) ---
// s = {
//   fpBuf(≤8), nameBuf(≤24), timeBuf(≤32), beansBuf(≤16),
//   timeArmed, beansArmed,
//   lastCommittedMs, lastCommittedBeans,
//   worldId,              // <--- mémorisé depuis /commit
//   activeUserIdHash,     // <--- "wn_<worldId>_<display_name>" fixé à /ncommit
//   lastSeen
// }
const SESSIONS = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS.entries())
    if (now - v.lastSeen > SESSION_TTL_MS) SESSIONS.delete(k);
}, 30000);

function ensureSess(ip) {
  const now = Date.now();
  let s = SESSIONS.get(ip);
  if (!s)
    s = {
      fpBuf: "",
      nameBuf: "",
      timeBuf: "",
      beansBuf: "",
      timeArmed: false,
      beansArmed: false,
      lastCommittedMs: null,
      lastCommittedBeans: null,
      worldId: null,
      activeUserIdHash: null,
      lastSeen: now,
    };
  s.lastSeen = now;
  SESSIONS.set(ip, s);
  return s;
}

// --- sécurité minimale & no-cache ---
app.use((req, res, next) => {
  res.type("text/plain; charset=utf-8");
  nocache(res);
  next();
});

// --- Debug & reset ---
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.send("ok\n");
  } catch {
    res.status(500).send("db\n");
  }
});

app.get("/start", (req, res) => {
  SESSIONS.delete(clientIp(req));
  res.send("ok\n");
});

app.get("/reset", (req, res) => {
  const s = ensureSess(clientIp(req));
  s.fpBuf = s.nameBuf = s.timeBuf = s.beansBuf = "";
  s.timeArmed = s.beansArmed = false;
  s.activeUserIdHash = null;
  res.send("ok\n");
});

// --- 1) Handshake: /b/:k (8 symboles) ---
app.get("/b/:k", (req, res) => {
  const k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < 64)) return res.status(400).send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.fpBuf.length < 8) s.fpBuf += ALPHABET[k];
  res.send("ok\n");
});

// Mémorise seulement le world en session
app.get("/commit", async (req, res) => {
  const ip = clientIp(req);
  const s = ensureSess(ip);
  if (!s || s.fpBuf.length < 8) return res.status(400).send("noid\n");

  s.worldId = (req.query.world || "default").toString().slice(0, 64);

  // On ne crée pas la row ici car on attend le nametag pour forger l'ID.
  res.send("ok\n");
});

// --- 2) Name ---
app.get("/nreset", (req, res) => {
  const s = ensureSess(clientIp(req));
  s.nameBuf = "";
  res.send("ok\n");
});

app.get("/n/:k", (req, res) => {
  const k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < 64)) return res.status(400).send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.nameBuf.length < 24) s.nameBuf += ALPHABET[k];
  res.send("ok\n");
});

app.get("/ncommit", async (req, res) => {
  const ip = clientIp(req);
  const s = SESSIONS.get(ip);
  if (!s || s.fpBuf.length < 8 || !s.nameBuf.length) return res.status(400).send("noid\n");

  const world_id = (s.worldId || "default").toString().slice(0, 64);
  const display_name = sanitizeNameFromAlphabet(s.nameBuf);
  // clé = world + name → on “pointe” explicitement cette entrée
  const user_id_hash = `wn_${world_id}_${display_name}`.slice(0, 160);

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1,$2,$3,0,0,NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            world_id = EXCLUDED.world_id,
            updated_at = NOW()
    `,
      [user_id_hash, display_name, world_id]
    );
    s.nameBuf = "";
    s.activeUserIdHash = user_id_hash; // important: utilisé par /tcommit et /ccommit
    res.send("ok\n");
  } catch (e) {
    console.error("ncommit db error:", e);
    res.status(500).send("db\n");
  }
});

// --- 3) Time (ms) ---
app.get("/treset", (req, res) => {
  const s = ensureSess(clientIp(req));
  s.timeBuf = "";
  s.timeArmed = false;
  res.send("ok\n");
});

app.get("/t/:k", (req, res) => {
  const k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < 64)) return res.status(400).send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.timeBuf.length < 32) s.timeBuf += ALPHABET[k];
  s.timeArmed = true;
  res.send("ok\n");
});

app.get("/tcommit", async (req, res) => {
  const ip = clientIp(req);
  const s = SESSIONS.get(ip);
  if (!s || !s.activeUserIdHash) return res.status(400).send("noname\n"); // exige d'avoir /ncommit avant

  if (!s.timeArmed || !s.timeBuf.length) {
    s.timeBuf = "";
    s.timeArmed = false;
    return res.send("noop\n");
  }

  const user_id_hash = s.activeUserIdHash;
  const total_ms = decode64ToNumber(s.timeBuf, 32);
  if (total_ms == null) return res.status(400).send("bad\n");

  if (s.lastCommittedMs !== null && Number(s.lastCommittedMs) === Number(total_ms)) {
    s.timeBuf = "";
    s.timeArmed = false;
    return res.send("noop\n");
  }

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES (
        $1,
        split_part($1, '_', 3),              -- display_name depuis la clé "wn_<world>_<name>"
        split_part($1, '_', 2),              -- world depuis la clé
        $2, 0, NOW()
      )
      ON CONFLICT (user_id_hash) DO UPDATE
        SET total_ms = EXCLUDED.total_ms,    -- OVERWRITE (écrase l’ancienne valeur)
            updated_at = NOW()
    `,
      [user_id_hash, total_ms]
    );
    s.lastCommittedMs = total_ms;
    s.timeBuf = "";
    s.timeArmed = false;
    res.send("ok\n");
  } catch (e) {
    console.error("tcommit db error:", e);
    res.status(500).send("db\n");
  }
});

// --- 4) Beans ---
app.get("/creset", (req, res) => {
  const s = ensureSess(clientIp(req));
  s.beansBuf = "";
  s.beansArmed = false;
  res.send("ok\n");
});

app.get("/c/:k", (req, res) => {
  const k = Number.parseInt(req.params.k, 10);
  if (!(k >= 0 && k < 64)) return res.status(400).send("bad\n");
  const s = ensureSess(clientIp(req));
  if (s.beansBuf.length < 16) s.beansBuf += ALPHABET[k];
  s.beansArmed = true;
  res.send("ok\n");
});

app.get("/ccommit", async (req, res) => {
  const ip = clientIp(req);
  const s = SESSIONS.get(ip);
  if (!s || !s.activeUserIdHash) return res.status(400).send("noname\n");

  if (!s.beansArmed || !s.beansBuf.length) {
    s.beansBuf = "";
    s.beansArmed = false;
    return res.send("noop\n");
  }

  const user_id_hash = s.activeUserIdHash;
  const beans = decode64ToNumber(s.beansBuf, 16);
  if (beans == null) return res.status(400).send("bad\n");

  if (s.lastCommittedBeans !== null && Number(s.lastCommittedBeans) === Number(beans)) {
    s.beansBuf = "";
    s.beansArmed = false;
    return res.send("noop\n");
  }

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES (
        $1,
        split_part($1, '_', 3),
        split_part($1, '_', 2),
        0, $2, NOW()
      )
      ON CONFLICT (user_id_hash) DO UPDATE
        SET beans = EXCLUDED.beans,
            updated_at = NOW()
    `,
      [user_id_hash, beans]
    );
    s.lastCommittedBeans = beans;
    s.beansBuf = "";
    s.beansArmed = false;
    res.send("ok\n");
  } catch (e) {
    console.error("ccommit db error:", e);
    res.status(500).send("db\n");
  }
});

// --- 5) Fast-path (optionnel) : tout en 1 requête ---
app.get("/tfull/:sym", async (req, res) => {
  const ip = clientIp(req);
  const s = ensureSess(ip);
  if (!s || !s.activeUserIdHash) return res.status(400).send("noname\n");
  const user_id_hash = s.activeUserIdHash;
  const total_ms = decode64ToNumber(req.params.sym, 32);
  if (total_ms == null) return res.status(400).send("bad\n");

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1, split_part($1,'_',3), split_part($1,'_',2), $2, 0, NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET total_ms = EXCLUDED.total_ms,    -- OVERWRITE
            updated_at = NOW()
      `,
      [user_id_hash, total_ms]
    );
    s.lastCommittedMs = total_ms;
    res.send("ok\n");
  } catch (e) {
    console.error("tfull db error:", e);
    res.status(500).send("db\n");
  }
});

app.get("/cfull/:sym", async (req, res) => {
  const ip = clientIp(req);
  const s = ensureSess(ip);
  if (!s || !s.activeUserIdHash) return res.status(400).send("noname\n");
  const user_id_hash = s.activeUserIdHash;
  const beans = decode64ToNumber(req.params.sym, 16);
  if (beans == null) return res.status(400).send("bad\n");

  try {
    await pool.query(
      `
      INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, beans, updated_at)
      VALUES ($1, split_part($1,'_',3), split_part($1,'_',2), 0, $2, NOW())
      ON CONFLICT (user_id_hash) DO UPDATE
        SET beans = EXCLUDED.beans,
            updated_at = NOW()
      `,
      [user_id_hash, beans]
    );
    s.lastCommittedBeans = beans;
    res.send("ok\n");
  } catch (e) {
    console.error("cfull db error:", e);
    res.status(500).send("db\n");
  }
});

// --- Leaderboards ---
app.get("/leaderboard.json", async (req, res) => {
  res.type("application/json; charset=utf-8");
  nocache(res);
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 2000);
  const world = req.query.world || null;
  try {
    const args = [];
    let sql = `SELECT display_name, total_ms, beans FROM scores`;
    if (world) {
      sql += ` WHERE world_id=$1`;
      args.push(world);
    }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    res.json(rows);
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
      args.push(world);
    }
    sql += ` ORDER BY total_ms DESC, beans DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    const lines = rows.map(
      (r) => `[${r.display_name}] : ${msToStr(Number(r.total_ms || 0))} | ${Number(r.beans || 0)}`
    );
    res.send(lines.join("\n") + "\n");
  } catch (e) {
    console.error(e);
    res.status(500).send("error\n");
  }
});

app.get("/", (_req, res) => res.send("ok\n"));

const server = app.listen(PORT, () => console.log("Server listening on", PORT, "SSL:", !!useSSL));
function shutdown() {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
