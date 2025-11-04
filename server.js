// ========================================================
// MILANO Check-All (WS broadcast trigger + majority result)
// - /ws : WebSocket. Messages:
//   * client->server: {"type":"trigger","roomId":"milano","ttlMs":4000}
//   * client->server: {"type":"report","roomId":"milano","runId":"...","ok":true,"pageUrl":"..."}
//   * server->clients: {"type":"check","roomId":"milano","runId":"...","deadlineTs":...}
//   * server->clients: {"type":"result","roomId":"milano","runId":"...","decision":true,"counts":{"ok":N,"fail":M,"total":T}}
// ========================================================
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const DEFAULT_TTL = 4000; // نافذة التجميع (ms)

const app = express();
app.use(cors({ origin: true }));
app.get('/', (_req, res) => res.send('MILANO Check-All WS running ✅'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// rooms: Map<roomId, Set<ws>>
const rooms = new Map();
// runs: Map<runId, { roomId, deadline, reports: Array<{ok, pageUrl}>, timer }>
const runs = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}
function rid() { return 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

function broadcastToRoom(roomId, obj) {
  const msg = JSON.stringify(obj);
  const set = rooms.get(roomId);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function closeRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  clearTimeout(run.timer);
  runs.delete(runId);
}

function finalizeRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  const total = run.reports.length;
  const ok = run.reports.filter(r => r.ok === true).length;
  const fail = total - ok;
  const decision = total > 0 ? (ok > total / 2) : false; // أغلبية بسيطة
  const payload = {
    type: 'result',
    roomId: run.roomId,
    runId,
    decision,
    counts: { ok, fail, total }
  };
  broadcastToRoom(run.roomId, payload);
  closeRun(runId);
}

function startRun(roomId, ttlMs = DEFAULT_TTL) {
  const runId = rid();
  const deadline = Date.now() + ttlMs;
  const timer = setTimeout(() => finalizeRun(runId), ttlMs);
  runs.set(runId, { roomId, deadline, timer, reports: [] });
  broadcastToRoom(roomId, { type: 'check', roomId, runId, deadlineTs: deadline });
  return runId;
}

wss.on('connection', (ws, req) => {
  // room via query ?room=milano
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'milano';
  const room = getRoom(roomId);
  room.add(ws);

  // hello
  ws.send(JSON.stringify({ type: 'hello', roomId, ttlDefault: DEFAULT_TTL }));

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'trigger') {
      const roomId = msg.roomId || roomId || 'milano';
      const ttlMs = Math.max(1500, Math.min(10000, Number(msg.ttlMs) || DEFAULT_TTL));
      startRun(roomId, ttlMs);
      return;
    }

    if (msg.type === 'report') {
      const run = runs.get(msg.runId);
      if (!run) return;
      // تجاهل تقارير خارج الغرفة أو بعد الموعد
      if (run.roomId !== (msg.roomId || roomId)) return;
      if (Date.now() > run.deadline) return;
      run.reports.push({ ok: !!msg.ok, pageUrl: String(msg.pageUrl || '') });
      return;
    }
  });

  ws.on('close', () => {
    const set = rooms.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ WS server listening on ${PORT}`);
  console.log(`🔌 WS endpoint: ws://localhost:${PORT}/ws`);
});
