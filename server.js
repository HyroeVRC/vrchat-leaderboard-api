import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// --- ENV ---
const PORT = process.env.PORT || 8080;
// Railway te donne DATABASE_URL automatiquement quand tu ajoutes Postgres
const DATABASE_URL = process.env.DATABASE_URL;
const API_SECRET = process.env.API_SECRET || "change-me"; // pour signer/valider les updates

// --- DB ---
const pool = new Pool({ connectionString: DATABASE_URL });

// création table au démarrage
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

// --- sécurité (HMAC SHA256 de body brut) ---
function isValidSignature(bodyObj, signature) {
  if (!API_SECRET) return false;
  try {
    const body = JSON.stringify(bodyObj);
    const hmac = crypto.createHmac("sha256", API_SECRET).update(body).digest("hex");
    return signature && signature.toLowerCase() === hmac;
  } catch { return false; }
}

// --- POST /api/submit ---
// Reçoit un update pour un joueur.
// body: { user_id_hash, display_name, world_id, mode, total_ms, delta_ms }
// header: x-signature = HMAC_SHA256(JSON.stringify(body), API_SECRET)
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
  display_name = String(display_name).slice(0, 32); // petite limite soft

  // Upsert
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // fetch existant
      const { rows } = await client.query(
        "SELECT total_ms FROM scores WHERE user_id_hash=$1",
        [user_id_hash]
      );
      let newTotal = 0;

      if (mode === "increment") {
        const inc = Math.max(0, Number(delta_ms || 0));
        const base = rows.length ? Number(rows[0].total_ms || 0) : 0;
        newTotal = base + inc;
      } else {
        // mode "absolute" (par défaut) : prend le max(total actuel, total_ms reçu)
        const incoming = Math.max(0, Number(total_ms || 0));
        const base = rows.length ? Number(rows[0].total_ms || 0) : 0;
        newTotal = Math.max(base, incoming);
      }

      await client.query(`
        INSERT INTO scores(user_id_hash, display_name, world_id, total_ms, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id_hash) DO UPDATE
          SET display_name=EXCLUDED.display_name,
              world_id=EXCLUDED.world_id,
              total_ms=EXCLUDED.total_ms,
              updated_at=NOW()
      `, [user_id_hash, display_name, world_id || null, newTotal]);

      await client.query("COMMIT");
      res.json({ ok: true, total_ms: newTotal });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      res.status(500).json({ ok: false, error: "db error" });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "pool error" });
  }
});

// --- GET /leaderboard.json?limit=50&world_id=xxxx ---
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

// --- GET /leaderboard.txt?limit=50&world_id=xxxx ---
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
  console.log("Server listening on", PORT);
});
