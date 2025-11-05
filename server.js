import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 4600;

// اسمح لجميع الأورجينات (يمكنك تخصيصها لاحقاً)
const ALLOWED_ORIGINS = [];

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("MILANO check server up"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false
});

const rooms = new Map();                  
const pendingAggregations = new Map();    

function now(){ return Date.now(); }

function joinRoom(ws, room) {
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(room)) {
    try { ws.send(JSON.stringify({ type: "error", reason: "origin_not_allowed" })); } catch {}
    try { ws.close(); } catch {}
    return;
  }
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.__room = room;
}

function leaveRoom(ws) {
  const r = ws.__room;
  if (!r) return;
  const s = rooms.get(r);
  if (!s) return;
  s.delete(ws);
  if (!s.size) rooms.delete(r);
}

function broadcast(room, obj) {
  const s = rooms.get(room);
  if (!s) return;
  const msg = JSON.stringify(obj);
  for (const ws of s) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "hello" && typeof msg.room === "string") {
      joinRoom(ws, msg.room);
      if (ws.__room) {
        try { ws.send(JSON.stringify({ type: "hello_ack", room: ws.__room })); } catch {}
      }
      return;
    }

    if (msg.type === "check_request" && ws.__room) {
      const room = ws.__room;
      const checkId = msg.checkId || Math.random().toString(36).slice(2) + now();
      const timeoutMs = Math.min(Math.max(+msg.timeoutMs || 2000, 1000), 8000);

      pendingAggregations.set(checkId, {
        room,
        deadline: now() + timeoutMs,
        results: []
      });

      broadcast(room, {
        type: "run_checks",
        checkId,
        url: msg.url || null,
        deadline: now() + timeoutMs
      });

      setTimeout(() => {
        const agg = pendingAggregations.get(checkId);
        if (!agg) return;
        const results = agg.results;

        let ok = 0, fail = 0, err = 0;
        for (const r of results) {
          if (r.status === "OK") ok++;
          else if (r.status === "FAIL") fail++;
          else err++;
        }

        let majority = "ERROR";
        if (ok >= fail && ok >= err) majority = "TRUE";
        else if (fail > ok && fail >= err) majority = "FALSE";

        broadcast(agg.room, {
          type: "check_result",
          checkId,
          majority,
          tally: { ok, fail, err, total: ok + fail + err },
          received: results
        });

        pendingAggregations.delete(checkId);
      }, timeoutMs + 50);

      return;
    }

    if (msg.type === "check_result_part" && msg.checkId) {
      const agg = pendingAggregations.get(msg.checkId);
      if (!agg) return;
      agg.results.push({
        from: msg.from || "unknown",
        status: msg.status,
        detail: msg.detail || {}
      });
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

/* ===========================
   ✅ PING / PONG كل 5 ثواني
   =========================== */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 5000);

server.listen(PORT, () => {
  console.log("MILANO check server listening on :" + PORT);
});
