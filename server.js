import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 4600;
const ALLOWED_ORIGINS = [];                 // اتركها فارغة للسماح للجميع
const ADMIN_SECRET = process.env.ADMIN_SECRET || "2006";
const TOKENS_ENV = process.env.TOKENS || ""; // مثال: alpha|Team A,beta|Team B

/* ====== تخزين التوكنات في الذاكرة ====== */
const tokens = new Map(); // value -> { label, enabled, createdAt }
seedTokensFromEnv();

function seedTokensFromEnv() {
  if (!TOKENS_ENV) return;
  const parts = TOKENS_ENV.split(",").map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const [valueRaw, labelRaw] = p.split("|").map(s => (s || "").trim());
    const value = valueRaw;
    const label = labelRaw || valueRaw;
    if (value) tokens.set(value, { label, enabled: true, createdAt: Date.now() });
  }
}

/* ====== تطبيق HTTP ====== */
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("MILANO check server up"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return next();
  const header = req.header("x-admin-secret") || "";
  if (header === ADMIN_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* ====== واجهة إدارة بسيطة على /admin ====== */
app.get("/admin", (_req, res) => {
  const html = `<!doctype html>
<meta charset="utf-8"><title>MILANO Check – Token Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1320;color:#e5e7eb;margin:0;padding:24px;}
  .wrap{max-width:880px;margin:0 auto}
  h1{margin:0 0 16px;font-size:22px}
  .card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
  input,button{font-size:14px}
  input[type=text]{background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:10px;padding:10px 12px;min-width:200px}
  button{border:0;border-radius:10px;padding:10px 14px;cursor:pointer;color:#fff;background:#2563eb}
  button.danger{background:#dc2626}
  button.gray{background:#6b7280}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border-bottom:1px solid #1f2937;padding:10px;text-align:left;font-size:13px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .ok{background:#065f46}
  .off{background:#7c2d12}
  .hint{color:#9ca3af;font-size:12px;margin-top:10px}
  .secret{margin-left:auto}
</style>
<div class="wrap">
  <h1>MILANO Check – Token Admin</h1>
  <div class="card">
    <div class="row">
      <input id="secret" type="text" placeholder="Admin secret (optional)" class="secret">
      <button id="refresh">Refresh</button>
    </div>
    <div class="row">
      <input id="token_value" type="text" placeholder="token value (e.g. alpha123)">
      <input id="token_label" type="text" placeholder="label (optional)">
      <button id="add">Add Token</button>
    </div>
    <div class="hint">كل سكربت يجب أن يرسل هذا التوكن ليُسمح له بالانضمام. حذف التوكن يُغلق الاتصالات فورًا.</div>
    <table id="tbl">
      <thead><tr><th>Token</th><th>Label</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>
<script>
  const $ = (s)=>document.querySelector(s);
  const secret = localStorage.getItem("ADMIN_SECRET") || "";
  $("#secret").value = secret;

  function hdrs(){
    const h = {"Content-Type":"application/json"};
    const sec = $("#secret").value.trim();
    if (sec) h["x-admin-secret"] = sec;
    localStorage.setItem("ADMIN_SECRET", sec);
    return h;
  }

  async function load(){
    const r = await fetch("/api/tokens", {headers: hdrs()});
    const j = await r.json();
    const tbody = $("#tbl tbody");
    tbody.innerHTML = "";
    (j.tokens||[]).forEach(t=>{
      const tr = document.createElement("tr");
      tr.innerHTML = \`
        <td><code>\${t.value}</code></td>
        <td>\${t.label||""}</td>
        <td>\${t.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge off">disabled</span>'}</td>
        <td>\${new Date(t.createdAt).toLocaleString()}</td>
        <td>
          <button class="gray" data-act="toggle" data-v="\${t.value}">\${t.enabled?'Disable':'Enable'}</button>
          <button class="danger" data-act="del" data-v="\${t.value}">Delete</button>
        </td>\`;
      tbody.appendChild(tr);
    });
  }

  $("#refresh").onclick = load;
  $("#add").onclick = async ()=>{
    const value = $("#token_value").value.trim();
    const label = $("#token_label").value.trim();
    if(!value){ alert("token value required"); return; }
    await fetch("/api/tokens", {method:"POST", headers: hdrs(), body: JSON.stringify({value, label})});
    $("#token_value").value = ""; $("#token_label").value = "";
    load();
  };
  $("#tbl").onclick = async (e)=>{
    const btn = e.target.closest("button");
    if(!btn) return;
    const val = btn.getAttribute("data-v");
    const act = btn.getAttribute("data-act");
    if(act==="del"){
      if(!confirm("Delete token "+val+" ?")) return;
      await fetch("/api/tokens/"+encodeURIComponent(val), {method:"DELETE", headers: hdrs()});
      load();
    } else if (act==="toggle"){
      await fetch("/api/tokens/"+encodeURIComponent(val), {method:"PATCH", headers: hdrs(), body: JSON.stringify({toggle:true})});
      load();
    }
  };

  load();
</script>`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(html);
});

/* ====== REST API للتوكنات ====== */
app.get("/api/tokens", requireAdmin, (_req, res) => {
  const list = [...tokens.entries()].map(([value, meta]) => ({
    value, label: meta.label, enabled: !!meta.enabled, createdAt: meta.createdAt
  }));
  res.json({ ok: true, tokens: list });
});
app.post("/api/tokens", requireAdmin, (req, res) => {
  const { value, label } = req.body || {};
  if (!value || typeof value !== "string") return res.status(400).json({ ok:false, error:"value required" });
  tokens.set(value, { label: label || value, enabled: true, createdAt: Date.now() });
  res.json({ ok: true });
});
app.patch("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const t = tokens.get(value);
  if (!t) return res.status(404).json({ ok:false, error:"not found" });
  if (req.body && req.body.toggle) {
    t.enabled = !t.enabled;
    // أغلق جلسات هذا التوكن عند التعطيل
    if (!t.enabled) {
      for (const ws of wss.clients) {
        if (ws.__token === value) { try { ws.close(); } catch {} }
      }
    }
    return res.json({ ok:true, enabled: t.enabled });
  }
  return res.json({ ok:true });
});
app.delete("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const exists = tokens.has(value);
  tokens.delete(value);
  // أغلق جميع الاتصالات الحاملة لهذا التوكن
  for (const ws of wss.clients) {
    if (ws.__token === value) { try { ws.close(); } catch {} }
  }
  res.json({ ok:true, deleted: !!exists });
});

/* ====== WebSocket ====== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

// roomKey = origin + "||" + token
const rooms = new Map();               // roomKey -> Set(ws)
const pendingAggregations = new Map(); // checkId -> { roomKey, deadline, results[] }

function joinRoom(ws, origin, token) {
  const meta = tokens.get(token);
  if (!meta || !meta.enabled) {
    try { ws.send(JSON.stringify({ type:"error", reason:"token_denied" })); } catch {}
    try { ws.close(); } catch {}
    return;
  }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    try { ws.send(JSON.stringify({ type:"error", reason:"origin_not_allowed" })); } catch {}
    try { ws.close(); } catch {}
    return;
  }
  const key = origin + "||" + token;
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
  ws.__roomKey = key;
  ws.__token = token;
  ws.__origin = origin;
}

function leaveRoom(ws) {
  const key = ws.__roomKey;
  if (!key) return;
  const s = rooms.get(key);
  if (!s) return;
  s.delete(ws);
  if (!s.size) rooms.delete(key);
}

function broadcast(roomKey, obj) {
  const s = rooms.get(roomKey);
  if (!s) return;
  const msg = JSON.stringify(obj);
  for (const ws of s) {
    if (ws.readyState === ws.OPEN) { try { ws.send(msg); } catch {} }
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // {type:"hello", room:"https://www.blsspainmorocco.net", token:"alpha123"}
    if (msg.type === "hello" && typeof msg.room === "string" && typeof msg.token === "string") {
      joinRoom(ws, msg.room, msg.token);
      if (ws.__roomKey) {
        try { ws.send(JSON.stringify({ type: "hello_ack", room: ws.__roomKey })); } catch {}
      }
      return;
    }

    // {type:"check_request", timeoutMs?}
    if (msg.type === "check_request" && ws.__roomKey) {
      const roomKey = ws.__roomKey;
      const checkId = msg.checkId || Math.random().toString(36).slice(2) + Date.now();
      const timeoutMs = Math.min(Math.max(+msg.timeoutMs || 900, 300), 5000);

      pendingAggregations.set(checkId, { roomKey, deadline: Date.now() + timeoutMs, results: [] });

      broadcast(roomKey, {
        type: "run_checks",
        checkId,
        url: msg.url || null,
        deadline: Date.now() + timeoutMs
      });

      setTimeout(() => {
        const agg = pendingAggregations.get(checkId);
        if (!agg) return;

        let ok = 0, err = 0;
        for (const r of agg.results) {
          if (r.status === "IGNORE") continue;
          if (r.status === "OK") ok++; else if (r.status === "ERROR") err++;
        }
        const total = ok + err;
        const majority = (ok >= err) ? "TRUE" : "FALSE";

        broadcast(agg.roomKey, {
          type: "check_result",
          checkId,
          majority,
          tally: { ok, err, total }
        });

        pendingAggregations.delete(checkId);
      }, timeoutMs + 10);

      return;
    }

    // {type:"check_result_part", checkId, status}
    if (msg.type === "check_result_part" && msg.checkId) {
      const agg = pendingAggregations.get(msg.checkId);
      if (!agg) return;
      agg.results.push({
        from: msg.from || "unknown",
        status: msg.status, // "OK" | "ERROR" | "IGNORE"
        detail: msg.detail || {}
      });

      // تقدم لحظي
      let ok = 0, err = 0;
      for (const r of agg.results) {
        if (r.status === "IGNORE") continue;
        if (r.status === "OK") ok++; else if (r.status === "ERROR") err++;
      }
      const total = ok + err;
      if (total >= 1) {
        const majority = (ok >= err) ? "TRUE" : "FALSE";
        broadcast(agg.roomKey, {
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
