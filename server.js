// MILANO Check-All (low-latency quorum + WS + BC-friendly)
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const DEFAULT_TTL = 1200; // نافذة التجميع القصيرة (ms)

const app = express();
app.use(cors({ origin: true }));
app.get('/', (_, res) => res.send('MILANO Check-All (quorum) ✅'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// rooms: Map<roomId, Set<ws>>
const rooms = new Map();
// runs: Map<runId, { roomId, expected, ok, fail, deadline, timer }>
const runs = new Map();

const rid = () => 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);

const getRoom = (roomId) => {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
};

const broadcastRoom = (roomId, obj) => {
  const msg = JSON.stringify(obj);
  const set = rooms.get(roomId);
  if (!set) return;
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
};

function finalize(runId) {
  const r = runs.get(runId);
  if (!r) return;
  clearTimeout(r.timer);
  const total = r.ok + r.fail;
  const decision = total > 0 ? (r.ok > r.fail) : false; // أغلبية بسيطة
  broadcastRoom(r.roomId, {
    type: 'result',
    roomId: r.roomId,
    runId,
    decision,
    counts: { ok: r.ok, fail: r.fail, total, expected: r.expected }
  });
  runs.delete(runId);
}

function tryEarlyQuorum(r) {
  const need = Math.floor(r.expected / 2) + 1;
  if (r.ok >= need || r.fail >= need) finalize(r.runId);
}

function startRun(roomId, ttlMs = DEFAULT_TTL) {
  const runId = rid();
  const expected = getRoom(roomId).size; // عدد المتصلين لحظة الإطلاق
  const timer = setTimeout(() => finalize(runId), ttlMs);
  const run = { runId, roomId, expected, ok: 0, fail: 0, deadline: Date.now()+ttlMs, timer };
  runs.set(runId, run);
  broadcastRoom(roomId, { type: 'check', roomId, runId, deadlineTs: run.deadline, expected });
}

wss.on('connection', (ws, req) => {
  try { ws._socket.setNoDelay(true); } catch {}
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'milano-room-1';
  const set = getRoom(roomId);
  set.add(ws);

  ws.send(JSON.stringify({ type: 'hello', roomId, ttlDefault: DEFAULT_TTL, connected: set.size }));

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    if (!msg || msg.roomId !== roomId) return;

    if (msg.type === 'trigger') {
      const ttlMs = Math.max(500, Math.min(5000, Number(msg.ttlMs) || DEFAULT_TTL));
      startRun(roomId, ttlMs);
      return;
    }

    if (msg.type === 'report') {
      const r = runs.get(msg.runId);
      if (!r || r.roomId !== roomId || Date.now() > r.deadline) return;
      if (msg.ok) r.ok++; else r.fail++;
      tryEarlyQuorum(r);
      return;
    }
  });

  ws.on('close', () => {
    const s = rooms.get(roomId);
    if (s) {
      s.delete(ws);
      if (s.size === 0) rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ WS on :${PORT}/ws`);
});
