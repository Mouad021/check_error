import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 4600;

const app = express();
app.use(cors());
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  // تعطيل الضغط لتقليل الحمل مع 150+ سوكِت
  perMessageDeflate: false
});

// room = origin (مثل https://www.blsspainmorocco.net)
const rooms = new Map(); // room -> Set(ws)
const pendingAggregations = new Map(); // checkId -> { room, deadline, results[] }

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.__room = room;
}

function leaveRoom(ws) {
  const r = ws.__room;
  if (r && rooms.has(r)) {
    rooms.get(r).delete(ws);
    if (rooms.get(r).size === 0) rooms.delete(r);
  }
}

function broadcast(room, dataObj) {
  const s = rooms.get(room);
  if (!s) return;
  const msg = JSON.stringify(dataObj);
  for (const ws of s) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
}

function now() { return Date.now(); }

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // {type:"hello", room:"https://www.blsspainmorocco.net"}
    if (msg.type === "hello" && typeof msg.room === "string") {
      joinRoom(ws, msg.room);
      ws.send(JSON.stringify({ type: "hello_ack", room: msg.room }));
      return;
    }

    // {type:"check_request", checkId, url, who:"clientId", timeoutMs?}
    if (msg.type === "check_request" && ws.__room) {
      const room = ws.__room;
      const checkId = msg.checkId || Math.random().toString(36).slice(2) + now();
      const timeoutMs = Math.min(Math.max(+msg.timeoutMs || 2000, 1000), 8000);

      // افتح تجميع جديد
      pendingAggregations.set(checkId, {
        room, deadline: now() + timeoutMs, results: []
      });

      // اطلب من جميع العملاء في الغرفة أن ينفذوا الفحص
      broadcast(room, {
        type: "run_checks",
        checkId,
        url: msg.url || null,
        deadline: now() + timeoutMs
      });

      // جدولة تجميع وإرجاع النتيجة
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
        const total = ok + fail + err;
        // حُكم الأغلبية
        let majority = "ERROR";
        if (ok >= fail && ok >= err) majority = "TRUE";
        else if (fail > ok && fail >= err) majority = "FALSE";
        else majority = "ERROR";

        // أعد إلى الغرفة (سيستلمه الذي ضغط الزر وكل الآخرين)
        broadcast(room, {
          type: "check_result",
          checkId,
          majority,
          tally: { ok, fail, err, total },
          received: results
        });

        pendingAggregations.delete(checkId);
      }, timeoutMs + 50);

      return;
    }

    // {type:"check_result_part", checkId, from, status, detail}
    if (msg.type === "check_result_part" && msg.checkId && ws.__room) {
      const agg = pendingAggregations.get(msg.checkId);
      if (!agg) return;
      agg.results.push({
        from: msg.from || "unknown",
        status: msg.status, // "OK" | "FAIL" | "ERROR"
        detail: msg.detail || {}
      });
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Ping للحفاظ على السوكِت حية
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`MILANO check server listening on :${PORT}`);
});
