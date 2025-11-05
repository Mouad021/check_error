import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 4600;
const ALLOWED_ORIGINS = []; // اسمح للجميع

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("MILANO check server up"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

const rooms = new Map();               // origin -> Set(ws)
const pendingAggregations = new Map(); // checkId -> { room, deadline, results[] }

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
      const timeoutMs = Math.min(Math.max(+msg.timeoutMs || 900, 300), 5000); // أقصر لتسريع الإعلان

      pendingAggregations.set(checkId, { room, deadline: now() + timeoutMs, results: [] });

      broadcast(room, {
        type: "run_checks",
        checkId,
        url: msg.url || null,
        deadline: now() + timeoutMs
      });

      setTimeout(() => {
        const agg = pendingAggregations.get(checkId);
        if (!agg) return;

        let ok = 0, err = 0;
        for (const r of agg.results) {
          if (r.status === "IGNORE") continue;
          if (r.status === "OK") ok++;
          else if (r.status === "ERROR") err++;
        }
        const total = ok + err;
        const majority = (ok >= err) ? "TRUE" : "FALSE";

        broadcast(agg.room, {
          type: "check_result",
          checkId,
          majority,
          tally: { ok, err, total }
        });

        pendingAggregations.delete(checkId);
      }, timeoutMs + 10);

      return;
    }

    // وصول جزء نتيجة من عميل ما -> أبثّ تقدم لحظي
    if (msg.type === "check_result_part" && msg.checkId) {
      const agg = pendingAggregations.get(msg.checkId);
      if (!agg) return;
      agg.results.push({
        from: msg.from || "unknown",
        status: msg.status, // "OK" | "ERROR" | "IGNORE"
        detail: msg.detail || {}
      });

      // بث فوري للتقدّم (majority لحظي)
      let ok = 0, err = 0;
      for (const r of agg.results) {
        if (r.status === "IGNORE") continue;
        if (r.status === "OK") ok++;
        else if (r.status === "ERROR") err++;
      }
      const total = ok + err;
      if (total >= 1) {
        const majority = (ok >= err) ? "TRUE" : "FALSE";
        broadcast(agg.room, {
          type: "check_progress",
          checkId: msg.checkId,
          majority,
          tally: { ok, err, total }
        });
      }
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

/* Ping/Pong كل 5 ثوانٍ */
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
