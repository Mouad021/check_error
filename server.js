// MILANO Check / Super Submit Hub  – ESM version
// Run locally:  NODE_OPTIONS=--experimental-modules  (if needed for older Node)
// Install:      npm i express ws cors
// Start:        node server.js
//
// Room model: roomKey = origin + "||" + token
// Client flow:
//   1) ws send: {type:"hello", room:"https://www.blsspainmorocco.net", token:"<TOKEN>"}
//   2) ws send: {type:"super_submit"}  → broadcast to same roomKey
// Optional HTTP trigger:
//   POST /super_submit  { origin, token }  → broadcast super_submit to that room

import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT          = process.env.PORT || 4600;
const ADMIN_SECRET  = process.env.ADMIN_SECRET || "2006";
// استخدم Persistent Disk على Render واضبط هذا المتغير:
const TOKENS_DB_PATH = process.env.TOKENS_DB_PATH || path.join(__dirname, "tokens.json");

/* ====== تخزين التوكنات مع حفظ دائم ====== */
const tokens = new Map(); // value -> { label, enabled, createdAt }

function loadTokensFromDisk() {
  try {
    if (!fs.existsSync(TOKENS_DB_PATH)) return;
    const raw = fs.readFileSync(TOKENS_DB_PATH, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (!t || !t.value) continue;
        tokens.set(t.value, {
          label: t.label || t.value,
          enabled: t.enabled !== false,
          createdAt: t.createdAt || Date.now()
        });
      }
      console.log("Loaded tokens:", tokens.size);
    }
  } catch (e) {
    console.error("Failed to load tokens:", e.message);
  }
}
function saveTokensToDisk() {
  try {
    const arr = [...tokens.entries()].map(([value, meta]) => ({
      value,
      label: meta.label || value,
      enabled: !!meta.enabled,
      createdAt: meta.createdAt || Date.now()
    }));
    fs.writeFileSync(TOKENS_DB_PATH, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save tokens:", e.message);
  }
}
loadTokensFromDisk();

/* ====== تطبيق HTTP ====== */
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("MILANO check server up"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

function requireAdmin(req, res, next) {
  const header = req.header("x-admin-secret") || "";
  if (header === ADMIN_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* ====== صفحة إدارة على /admin ====== */
// بدّل بلوك /admin الحالي كله بهذا:
app.get("/admin", (_req, res) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MILANO Control • Admin</title>

<style>
:root{
  --bg: #0a0b10;
  --card: #0f1324;
  --muted: #7b8aa3;
  --border: #1f2a44;
  --text: #dfe7ff;
  --primary: #6df4ff;
  --danger: #ff3769;
  --ok: #00f0a8;
  --warning:#ffd166;
  --shadow: 0 10px 40px rgba(0,0,0,.45);
  --radius: 14px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:radial-gradient(1200px 800px at 80% -20%, #182039 0%, transparent 50%),
  radial-gradient(900px 500px at 10% 120%, #132238 0%, transparent 50%), var(--bg);
  color:var(--text); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;
}

/* header */
.nav{
  position:sticky; top:0; z-index:10; backdrop-filter:saturate(1.2) blur(6px);
  background:linear-gradient(180deg, #0a0d18cc 0, #0a0d1800 100%); border-bottom:1px solid #111829;
}
.container{max-width:1100px;margin:0 auto;padding:20px}
.brand{display:flex;align-items:center;gap:12px}
.brand .logo{
  width:28px;height:28px; border-radius:9px;
  background:conic-gradient(from 220deg, #6df4ff, #00ffaa, #9a8cff, #6df4ff); box-shadow:0 0 24px #6df4ff44 inset, 0 0 18px #6df4ff55;
}
.brand h1{margin:0;font-size:18px;letter-spacing:.5px}

/* shell */
.grid{display:grid;grid-template-columns:1fr; gap:16px}
@media(min-width:840px){ .grid{grid-template-columns:330px 1fr} }

.card{
  background:linear-gradient(180deg, #0f1324cc, #0e1322cc);
  border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow);
}

/* forms */
.form{padding:16px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.input, .btn{
  border-radius:10px; padding:10px 12px; border:1px solid var(--border);
  background:#0b1222; color:var(--text); outline:none;
}
.input:focus{border-color:#3552ff66; box-shadow:0 0 0 3px #3552ff22}
.btn{cursor:pointer; border:1px solid #284ea9; background:linear-gradient(180deg,#1a3a88,#0e2e7a); color:#eaf4ff; font-weight:600}
.btn:hover{filter:brightness(1.05)}
.btn.secondary{background:#10192f;border-color:#22314f;color:#cfe3ff}
.btn.danger{background:linear-gradient(180deg,#b3123b,#7d0f2b); border-color:#5d0b21}
.btn.ghost{background:#0b1222;border-color:#1b2b48}
.btn:disabled{opacity:.6; cursor:not-allowed}

/* toolbar */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}

/* table */
.table{padding:12px}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 10px; border-bottom:1px solid #15223d; text-align:left}
th{color:#9fb3d9; font-weight:600}
tbody tr:hover{background:#0f1730}

/* pills */
.pill{padding:4px 10px;border-radius:999px;font-size:12px;display:inline-flex;align-items:center;gap:6px;border:1px solid #1d364f}
.pill.ok{color:#0cf6d1;background:#042d23;border-color:#0b5444}
.pill.off{color:#ffa3b3;background:#2a0e16;border-color:#541b2a}

/* search */
.searchbar{display:flex;gap:10px;margin-top:10px}
.kv{display:grid;grid-template-columns:110px 1fr;gap:8px;color:#9bb2d3}
.kv .mono{font-family:ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; color:#cfe3ff}

/* toast */
.toast{
  position:fixed; right:20px; bottom:20px; min-width:220px;
  background:#0e172b; border:1px solid #21345a; padding:10px 12px; border-radius:12px; box-shadow:var(--shadow); opacity:0; transform:translateY(10px);
  transition:.2s ease; pointer-events:none
}
.toast.show{opacity:1; transform:translateY(0)}
.toast.ok{border-color:#0b5444}
.toast.err{border-color:#5d0b21}

/* subtle scanlines */
.scan::before{
  content:"";position:absolute;inset:0;border-radius:inherit;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(255,255,255,.03) 3px);
  pointer-events:none;mix-blend-mode:overlay
}

/* reduce motion */
@media (prefers-reduced-motion: reduce){
  .scan::before{display:none}
}
</style>
</head>

<body>
  <div class="nav">
    <div class="container" style="display:flex;justify-content:space-between;align-items:center;">
      <div class="brand"><div class="logo"></div><h1>MILANO • Tokens Admin</h1></div>
      <div class="kv">
        <div>Clients</div><div class="mono" id="clients_count">—</div>
        <div>Room Key</div><div class="mono" id="room_key">origin||token</div>
      </div>
    </div>
  </div>

  <div class="container grid">
    <!-- Left: controls -->
    <section class="card scan">
      <div class="form">
        <h3 style="margin:0 0 10px">Access</h3>
        <div class="row">
          <input id="secret" class="input" placeholder="Admin secret (x-admin-secret)" />
          <button id="btn_check" class="btn secondary">Check Access</button>
        </div>

        <h3 style="margin:16px 0 10px">Add / Generate Token</h3>
        <div class="row">
          <input id="token_value" class="input" placeholder="Token value (e.g. alpha123)" />
          <input id="token_label" class="input" placeholder="Label (optional)" />
        </div>
        <div class="toolbar">
          <button id="btn_add" class="btn">Add Token</button>
          <button id="btn_gen" class="btn ghost">Generate</button>
          <button id="btn_export" class="btn ghost">Export JSON</button>
          <label class="btn ghost" style="position:relative;overflow:hidden">
            Import JSON <input id="file_import" type="file" accept="application/json" style="position:absolute;inset:0;opacity:0;cursor:pointer" />
          </label>
        </div>

        <h3 style="margin:16px 0 10px">Search & Filters</h3>
        <div class="searchbar">
          <input id="q" class="input" placeholder="Search tokens/labels…" />
          <select id="filter_state" class="input">
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          <button id="btn_refresh" class="btn secondary">Refresh</button>
        </div>
      </div>
    </section>

    <!-- Right: table -->
    <section class="card scan">
      <div class="table">
        <table>
          <thead>
            <tr>
              <th style="width:32%">Token</th>
              <th style="width:26%">Label</th>
              <th style="width:14%">Status</th>
              <th style="width:18%">Created</th>
              <th style="width:10%">Actions</th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div id="toast" class="toast"></div>

<script>
/* ===== helpers ===== */
const $ = (s, r=document)=>r.querySelector(s);
const $$= (s, r=document)=>Array.from(r.querySelectorAll(s));
const toast = (msg, ok=true)=>{
  const el=$("#toast");
  el.className = "toast " + (ok?"ok":"err");
  el.textContent = msg;
  requestAnimationFrame(()=>{ el.classList.add("show"); });
  setTimeout(()=>el.classList.remove("show"), 1800);
};

const secretEl = $("#secret");
secretEl.value = localStorage.getItem("ADMIN_SECRET") || "";
function hdrs(){
  const sec = secretEl.value.trim();
  if(!sec){ toast("Secret required", false); throw new Error("no secret"); }
  localStorage.setItem("ADMIN_SECRET", sec);
  return { "content-type": "application/json", "x-admin-secret": sec };
}

/* ===== state ===== */
let TOKENS = [];
let FILTER = { q:"", state:"all" };

function render(){
  const tbody = $("#tbody");
  const q = FILTER.q.toLowerCase();
  const s = FILTER.state;

  const items = TOKENS.filter(t=>{
    const okState = (s==="all") || (s==="enabled" && t.enabled) || (s==="disabled" && !t.enabled);
    const okQ = !q || (t.value.toLowerCase().includes(q) || (t.label||"").toLowerCase().includes(q));
    return okState && okQ;
  });

  tbody.innerHTML = items.map(t => `
    <tr>
      <td><code>${escapeHtml(t.value)}</code></td>
      <td>${escapeHtml(t.label||"")}</td>
      <td>${t.enabled?'<span class="pill ok">ENABLED</span>':'<span class="pill off">DISABLED</span>'}</td>
      <td>${new Date(t.createdAt).toLocaleString()}</td>
      <td>
        <button class="btn secondary btn-sm" data-act="toggle" data-v="${encodeURIComponent(t.value)}">${t.enabled?'Disable':'Enable'}</button>
        <button class="btn danger btn-sm" data-act="del" data-v="${encodeURIComponent(t.value)}">Del</button>
      </td>
    </tr>`).join("");

  $("#clients_count").textContent = "—"; // احتياطي (يمكن وصلها لاحقًا بـ /debug/rooms)
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

/* ===== io ===== */
async function loadTokens(){
  const r = await fetch("/api/tokens",{headers: hdrs()});
  if(!r.ok){ toast("Unauthorized /api/tokens", false); return; }
  const j = await r.json();
  TOKENS = j.tokens || [];
  render();
}

async function addToken(){
  const value = $("#token_value").value.trim();
  const label = $("#token_label").value.trim();
  if(!value){ toast("Enter token value", false); return; }
  const r = await fetch("/api/tokens",{method:"POST",headers:hdrs(),body:JSON.stringify({value,label})});
  if(r.ok){ toast("Token added"); $("#token_value").value=""; $("#token_label").value=""; loadTokens(); }
  else toast("Add failed", false);
}

async function patchToggle(val){
  const r = await fetch("/api/tokens/"+val,{method:"PATCH",headers:hdrs(),body:JSON.stringify({toggle:true})});
  if(r.ok){ toast("Updated"); loadTokens(); } else toast("Update failed", false);
}

async function delToken(val){
  if(!confirm("Delete token?")) return;
  const r = await fetch("/api/tokens/"+val,{method:"DELETE",headers:hdrs()});
  if(r.ok){ toast("Deleted"); loadTokens(); } else toast("Delete failed", false);
}

/* ===== events ===== */
$("#btn_refresh").onclick = loadTokens;
$("#btn_check").onclick  = loadTokens;
$("#btn_add").onclick    = addToken;
$("#btn_gen").onclick    = ()=>{
  const v = "tok_" + Math.random().toString(36).slice(2,8) + Math.random().toString(36).slice(2,6);
  $("#token_value").value = v;
  toast("Generated");
};
$("#file_import").onchange = async (e)=>{
  const f = e.target.files?.[0]; if(!f) return;
  const txt = await f.text();
  try{
    const arr = JSON.parse(txt);
    if(!Array.isArray(arr)) throw new Error("Invalid JSON");
    for(const t of arr){
      if(!t?.value) continue;
      await fetch("/api/tokens",{method:"POST",headers:hdrs(),body:JSON.stringify({value:t.value,label:t.label})});
    }
    toast("Imported"); loadTokens();
  }catch(_){ toast("Import failed", false); }
};

$("#q").oninput = e=>{ FILTER.q = e.target.value; render(); };
$("#filter_state").onchange = e=>{ FILTER.state = e.target.value; render(); };

$("#tbody").onclick = (e)=>{
  const b = e.target.closest("button"); if(!b) return;
  const act = b.dataset.act;
  const v   = b.dataset.v;
  if(act==="toggle") patchToggle(v);
  if(act==="del")    delToken(v);
};

/* hotkeys:  Ctrl+K focus search,  Ctrl+Enter add */
document.addEventListener("keydown",(e)=>{
  if(e.ctrlKey && e.key.toLowerCase()==="k"){ e.preventDefault(); $("#q").focus(); }
  if(e.ctrlKey && e.key==="Enter"){ e.preventDefault(); addToken(); }
});

/* show room key hint (front-end only hint) */
(function showRoomHint(){
  try {
    const origin = location.origin; // admin panel origin (for مرجع فقط)
    const token  = "(client token)";
    $("#room_key").textContent = origin + "||" + token;
  } catch {}
})();

/* init */
loadTokens();
</script>
</body>
</html>`;
  res.setHeader("content-type","text/html; charset=utf-8");
  res.send(html);
});


/* ====== REST API للتوكنات (محمي بالـ Admin secret) ====== */
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
  saveTokensToDisk();
  res.json({ ok: true });
});
app.patch("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const t = tokens.get(value);
  if (!t) return res.status(404).json({ ok:false, error:"not found" });
  if (req.body && req.body.toggle) {
    t.enabled = !t.enabled;
    saveTokensToDisk();
    return res.json({ ok:true, enabled: t.enabled });
  }
  return res.json({ ok:true });
});
app.delete("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const exists = tokens.has(value);
  tokens.delete(value);
  saveTokensToDisk();
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
  const key = origin + "||" + token;
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
  ws.__roomKey = key;
  ws.__origin = origin;
  ws.__token  = token;
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
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

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
        broadcast(agg.roomKey, {
          type: "check_result",
          checkId,
          majority: (ok >= err) ? "TRUE" : "FALSE",
          tally: { ok, err, total: ok+err }
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
      return;
    }

    /* ====== بث أمر LOGIN ALL (من عميل → نفس الغرفة) ====== */
    if (msg.type === "run_login_all") {
      if (!ws.__roomKey) return;
      broadcast(ws.__roomKey, { type: "run_login_all" });
      return;
    }

    /* ====== بث Super Submit (من عميل → نفس الغرفة) ====== */
    // الإضافة تبعث: {type:"super_submit"}
    if (msg.type === "super_submit") {
      if (!ws.__roomKey) return; // لم ينضم عبر hello
      // (اختياري) لو تضمّنت الرسالة token، تأكد من التطابق مع جلسة ws:
      if (typeof msg.token === "string" && msg.token !== ws.__token) return;
      // أعِد البث لكل العملاء في نفس origin||token
      broadcast(ws.__roomKey, { type: "super_submit", token: ws.__token });
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

process.on("SIGTERM", saveTokensToDisk);
process.on("SIGINT",  saveTokensToDisk);

server.listen(PORT, () => {
  console.log("MILANO check server listening on :" + PORT);
});

/* ====== HTTP super_submit (اختياري للاختبار اليدوي) ==================== */
// أطلق بث super_submit يدويًا عبر HTTP:
// curl -X POST http://localhost:4600/super_submit -H "content-type: application/json" \
//      -d '{"origin":"https://www.blsspainmorocco.net","token":"YOUR_TOKEN"}'
app.post("/super_submit", (req, res) => {
  const origin = typeof req.body?.origin === "string" ? req.body.origin : null;
  const token  = typeof req.body?.token  === "string" ? req.body.token  : null;
  if (!origin || !token) return res.status(400).json({ ok:false, error:"origin and token required" });
  const key = origin + "||" + token;
  broadcast(key, { type: "super_submit", token });
  res.json({ ok: true, origin, token });
});
