// ==================================================
// MILANO Majority Error Aggregator (WS + /ingest)
// - Rooms with recent state window
// - smartJudge(features) -> score [0..1] and majorityError
// - Broadcast aggregate to all clients in room
// ==================================================
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const FRESH_WINDOW_MS = 8000;

// ---------------------- Smart Judge ----------------------
function smartJudge(features = {}) {
  // features:
  // - status (number) [optional]
  // - locationHasErr (bool): /Home/Error? or /account/login?err=
  // - hasErrorText (bool)
  // - domMissing (bool)
  // - stallMs (number)
  // - htmlLen (number)
  // - signalFromClientScore (number in 0..1)
  let s = 0;

  if (features.locationHasErr) s = Math.max(s, 1.0);
  if (features.hasErrorText)  s = Math.max(s, 1.0);

  // هيوريستكس إضافية
  if (features.domMissing)    s = Math.max(s, 0.6);
  if (typeof features.stallMs === 'number' && features.stallMs >= 6000) s = Math.max(s, 0.4);
  if (typeof features.htmlLen === 'number' && features.htmlLen > 0 && features.htmlLen < 500) s = Math.max(s, 0.6);

  if (typeof features.signalFromClientScore === 'number') {
    s = Math.max(s, Math.max(0, Math.min(1, features.signalFromClientScore)));
  }
  return Math.max(0, Math.min(1, s));
}

// ---------------------- HTTP (Express) ----------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '500kb' }));

app.get('/', (_req, res) => {
  res.send('MILANO Majority Error Aggregator running ✅');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// rooms: Map<roomId, Map<clientId, { ws, last: {ts, error, score, pageUrl, ua} }>>
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function broadcastAggregate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const cutoff = Date.now() - FRESH_WINDOW_MS;

  let total = 0, errCount = 0, scoreSum = 0;

  for (const [, info] of room) {
    const st = info.last;
    if (!st || st.ts < cutoff) continue;
    total++;
    if (st.error) errCount++;
    scoreSum += (typeof st.score === 'number' ? st.score : (st.error ? 1 : 0));
  }

  const avgScore = total ? (scoreSum / total) : 0;
  const majorityError = total > 0 ? (errCount > total / 2 || avgScore >= 0.6) : false;

  const payload = {
    type: 'aggregate',
    roomId,
    totalRecent: total,
    errorRecent: errCount,
    majorityError,
    avgScore,
    ts: new Date().toISOString()
  };

  const msg = JSON.stringify(payload);
  for (const [, info] of room) {
    if (info.ws.readyState === WebSocket.OPEN) info.ws.send(msg);
  }
}

// استلام تقارير من المتصفح (أو أي عميل) وتحويلها إلى بث أغلبية
app.post('/ingest', (req, res) => {
  try {
    const r = req.body || {};
    const roomId = r.roomId || 'milano-room-1';

    const judgedScore = smartJudge({
      status: r.status,
      locationHasErr: !!(r.location && (/\/Home\/Error\?/i.test(r.location) || /\/account\/login\?err=/i.test(r.location))),
      hasErrorText: !!r.hasErrorText,
      domMissing: !!r.domMissing,
      stallMs: Number(r.stallMs || 0),
      htmlLen: Number(r.htmlLen || 0),
      signalFromClientScore: typeof r.score === 'number' ? r.score : undefined
    });

    const majorityError = judgedScore >= 0.6;

    // ابث فوراً للجميع (الرسالة aggregate موحَّدة)
    const payload = {
      type: 'aggregate',
      roomId,
      totalRecent: 1,
      errorRecent: majorityError ? 1 : 0,
      majorityError,
      avgScore: judgedScore,
      ts: new Date().toISOString()
    };

    if (wss) {
      const msg = JSON.stringify(payload);
      for (const c of wss.clients) {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
      }
    }

    return res.json({ ok: true, judgedScore, majorityError });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------------------- WS ----------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const clientId = url.searchParams.get('client') || Math.random().toString(36).slice(2);

  const room = getRoom(roomId);
  room.set(clientId, { ws, last: null });

  // تحية
  ws.send(JSON.stringify({ type: 'hello', roomId, clientId, freshWindowMs: FRESH_WINDOW_MS }));

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'status') {
      const entry = room.get(clientId);
      if (!entry) return;
      const score = typeof msg.score === 'number' ? msg.score : (msg.error ? 1 : 0);
      entry.last = {
        ts: Date.now(),
        error: !!msg.error,
        score,
        pageUrl: msg.pageUrl || '',
        ua: msg.userAgent || ''
      };
      broadcastAggregate(roomId);
    }
  });

  ws.on('close', () => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.delete(clientId);
    if (r.size === 0) rooms.delete(roomId);
    else broadcastAggregate(roomId);
  });

  // إرسال تجميعة أولية
  setTimeout(() => broadcastAggregate(roomId), 200);
});

// بث دوري لتحديث المتأخّرين
setInterval(() => {
  for (const roomId of rooms.keys()) broadcastAggregate(roomId);
}, 1000);

// ---------------------- Start ----------------------
server.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`🔌 WS: ws://localhost:${PORT}/ws`);
});
