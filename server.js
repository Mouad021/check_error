// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import process from "process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "2006";
const DATA_DIR = process.env.DATA_DIR || ".";
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

// تخزين التوكنات (ذاكرة + ملف)
const tokens = new Map();
function loadTokensFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    (j.list || []).forEach(t => tokens.set(t.value, {
      label: t.label || t.value,
      enabled: !!t.enabled,
      createdAt: t.createdAt || Date.now()
    }));
    console.log("Loaded tokens:", tokens.size);
  } catch {}
}
function saveTokensToDisk() {
  const list = [...tokens.entries()].map(([value, meta]) => ({
    value, label: meta.label, enabled: !!meta.enabled, createdAt: meta.createdAt
  }));
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify({ list }, null, 2)); } catch {}
}
loadTokensFromDisk();

// حماية الإدارة
function requireAdmin(req, res, next) {
  const sec = req.headers["x-admin-secret"];
  if (!sec || sec !== ADMIN_SECRET) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

// لوحة /admin بسيطة
app.get("/admin", (_req, res) => {
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"/><title>MILANO Check – Admin</title>
<style>
  body{margin:0;background:#0b1220;color:#e5e7eb;font:14px/1.5 system-ui,Segoe UI,Arial}
  .wrap{max-width:920px;margin:30px auto;padding:0 16px}
  .card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px}
  .row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  input{flex:1;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:10px;padding:10px 12px;min-width:200px}
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
      <input id="secret" type="text" placeholder="Admin secret (required)" class="secret">
      <button id="refresh">Refresh</button>
    </div>
    <div class="row">
      <input id="token_value" type="text" placeholder="token value (e.g. alpha123)">
      <input id="token_label" type="text" placeholder="label (optional)">
      <button id="add">Add Token</button>
    </div>
    <div class="hint">أضف/عطّل/احذف التوكنات. العملاء لا ينضمون إلا بتوكن مفعّل.</div>
    <table id="tbl">
      <thead><tr><th>Token</th><th>Label</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>
<script>
const $=(s)=>document.querySelector(s);
$("#secret").value = localStorage.getItem("ADMIN_SECRET") || "";
function hdrs(){
  const h={"Content-Type":"application/json"};
  const sec=$("#secret").value.trim();
  if(!sec){ alert("Admin secret is required"); throw new Error("no secret"); }
  h["x-admin-secret"]=sec; localStorage.setItem("ADMIN_SECRET",sec); return h;
}
async function load(){
  const r=await fetch("/api/tokens",{headers:hdrs()});
  const j=await r.json();
  const tbody=$("#tbl tbody"); tbody.innerHTML="";
  (j.tokens||[]).forEach(t=>{
    const tr=document.createElement("tr");
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
$("#refresh").onclick=load;
$("#add").onclick=async ()=>{
  const value=$("#token_value").value.trim();
  const label=$("#token_label").value.trim();
  if(!value){ alert("token value required"); return; }
  await fetch("/api/tokens",{method:"POST",headers:hdrs(),body:JSON.stringify({value,label})});
  $("#token_value").value=""; $("#token_label").value=""; load();
};
$("#tbl").onclick=async (e)=>{
  const btn=e.target.closest("button"); if(!btn) return;
  const val=btn.getAttribute("data-v");
  const act=btn.getAttribute("data-act");
  if(act==="del"){
    if(!confirm("Delete token "+val+" ?")) return;
    await fetch("/api/tokens/"+encodeURIComponent(val),{method:"DELETE",headers:hdrs()});
    load();
  }else if(act==="toggle"){
    await fetch("/api/tokens/"+encodeURIComponent(val),{method:"PATCH",headers:hdrs(),body:JSON.stringify({toggle:true})});
    load();
  }
};
load();
</script>`;
  res.setHeader("content-type","text/html; charset=utf-8");
  res.send(html);
});

// REST للتوكنات
app.get("/api/tokens", requireAdmin, (_req, res) => {
  const list = [...tokens.entries()].map(([value, meta]) => ({
    value, label: meta.label, enabled: !!meta.enabled, createdAt: meta.createdAt
  }));
  res.json({ ok:true, tokens:list });
});
app.post("/api/tokens", requireAdmin, (req, res) => {
  const { value, label } = req.body || {};
  if (!value || typeof value !== "string") return res.status(400).json({ ok:false, error:"value required" });
  tokens.set(value, { label: label || value, enabled: true, createdAt: Date.now() });
  saveTokensToDisk();
  res.json({ ok:true });
});
app.patch("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const t = tokens.get(value);
  if (!t) return res.status(404).json({ ok:false, error:"not found" });
  if (req.body && req.body.toggle) {
    t.enabled = !t.enabled; saveTokensToDisk();
    return res.json({ ok:true, enabled: t.enabled });
  }
  res.json({ ok:true });
});
app.delete("/api/tokens/:value", requireAdmin, (req, res) => {
  const value = req.params.value;
  const exists = tokens.has(value);
  tokens.delete(value); saveTokensToDisk();
  res.json({ ok:true, deleted: !!exists });
});

// WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

// roomKey = origin + "||" + token
const rooms = new Map(); // roomKey -> Set(ws)

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
  ws.__roomKey = key; ws.__origin = origin; ws.__token = token;
}
function leaveRoom(ws) {
  const key = ws.__roomKey; if (!key) return;
  const s = rooms.get(key); if (!s) return;
  s.delete(ws); if (!s.size) rooms.delete(key);
}
function broadcast(roomKey, obj) {
  const s = rooms.get(roomKey); if (!s) return;
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

    // {type:"hello", room, token}
    if (msg.type === "hello" && typeof msg.room === "string" && typeof msg.token === "string") {
      joinRoom(ws, msg.room, msg.token);
      if (ws.__roomKey) {
        try { ws.send(JSON.stringify({ type:"hello_ack", room: ws.__roomKey })); } catch {}
      }
      return;
    }

    // بث الضغط إلى نفس الغرفة
    if (msg.type === "run_login_all") {
      if (!ws.__roomKey) return;
      broadcast(ws.__roomKey, { type:"run_login_all", from: msg.from || null });
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Ping/Pong
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try{ws.terminate();}catch{} continue; }
    ws.isAlive = false; try{ws.ping();}catch{}
  }
}, 5000);

process.on("SIGTERM", saveTokensToDisk);
process.on("SIGINT", saveTokensToDisk);

server.listen(PORT, () => console.log("MILANO WS listening on :"+PORT));
