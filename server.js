import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = process.env.PORT || 4600;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "2006";

// إذا كنت تستخدم Render Persistent Disk ضع هذا:
const TOKENS_DB_PATH = process.env.TOKENS_DB_PATH || path.join(__dirname, "tokens.json");

/* ====== تخزين التوكنات مع حفظ دائم ====== */
const tokens = new Map();

function loadTokensFromDisk() {
  try {
    if (!fs.existsSync(TOKENS_DB_PATH)) return;
    const raw = fs.readFileSync(TOKENS_DB_PATH, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach(t => {
        if (!t.value) return;
        tokens.set(t.value, {
          label: t.label || t.value,
          enabled: t.enabled !== false,
          createdAt: t.createdAt || Date.now()
        });
      });
      console.log("Loaded tokens:", tokens.size);
    }
  } catch(e){
    console.log("Error loading tokens:", e.message);
  }
}
function saveTokensToDisk(){
  try {
    const arr = [...tokens.entries()].map(([value, meta]) => ({
      value,
      label: meta.label || value,
      enabled: !!meta.enabled,
      createdAt: meta.createdAt || Date.now()
    }));
    fs.writeFileSync(TOKENS_DB_PATH, JSON.stringify(arr, null, 2), "utf8");
  } catch(e){
    console.log("Error saving tokens:", e.message);
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
  return res.status(401).json({ ok:false, error:"unauthorized" });
}

/* ====== REST API ====== */
app.get("/api/tokens", requireAdmin, (_req, res) => {
  res.json({
    ok:true,
    tokens: [...tokens.entries()].map(([value, meta]) => ({
      value, label: meta.label, enabled: meta.enabled, createdAt: meta.createdAt
    }))
  });
});
app.post("/api/tokens", requireAdmin, (req, res) => {
  const { value, label } = req.body || {};
  if(!value) return res.status(400).json({ ok:false });
  tokens.set(value, { label: label || value, enabled: true, createdAt: Date.now() });
  saveTokensToDisk();
  res.json({ ok:true });
});
app.patch("/api/tokens/:value", requireAdmin, (req, res) => {
  const t = tokens.get(req.params.value);
  if(!t) return res.status(404).json({ ok:false });
  t.enabled = !t.enabled;
  saveTokensToDisk();
  res.json({ ok:true, enabled:t.enabled });
});
app.delete("/api/tokens/:value", requireAdmin, (req, res) => {
  tokens.delete(req.params.value);
  saveTokensToDisk();
  res.json({ ok:true });
});

/* ====== WebSocket ====== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate:false });

const rooms = new Map();               // roomKey = origin + "||" + token → Set(ws)
const pendingAggregations = new Map(); // checkId → { roomKey, deadline, results[] }

function joinRoom(ws, origin, token){
  const t = tokens.get(token);
  if(!t || !t.enabled){
    ws.send(JSON.stringify({type:"error",reason:"token_denied"}));
    ws.close();
    return;
  }
  const key = origin + "||" + token;
  if(!rooms.has(key)) rooms.set(key,new Set());
  rooms.get(key).add(ws);
  ws.__roomKey = key;
  ws.__origin = origin;
  ws.__token  = token;
}

function broadcast(roomKey, obj){
  const set = rooms.get(roomKey);
  if(!set) return;
  const msg = JSON.stringify(obj);
  for(const ws of set){
    if(ws.readyState===ws.OPEN){
      try{ ws.send(msg); } catch{}
    }
  }
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong",()=>ws.isAlive=true);

  ws.on("message", raw => {
    let msg;
    try{ msg = JSON.parse(raw.toString()); } catch{return;}

    if(msg.type==="hello"){
      joinRoom(ws, msg.room, msg.token);
      return;
    }

    /* ====== طلب check ====== */
    if(msg.type==="check_request" && ws.__roomKey){
      const roomKey = ws.__roomKey;
      const checkId = msg.checkId || Math.random().toString(36).slice(2);
      const timeoutMs = 900;

      pendingAggregations.set(checkId,{roomKey,deadline:Date.now()+timeoutMs,results:[]});

      broadcast(roomKey,{type:"run_checks",checkId,url:msg.url});
      setTimeout(()=>{
        const agg = pendingAggregations.get(checkId);
        if(!agg) return;
        let ok=0,err=0;
        for(const r of agg.results){
          if(r.status==="OK") ok++;
          else if(r.status==="ERROR") err++;
        }
        broadcast(agg.roomKey,{
          type:"check_result",
          checkId,
          majority: (ok>=err)?"TRUE":"FALSE",
          tally:{ok,err}
        });
        pendingAggregations.delete(checkId);
      },timeoutMs+20);
      return;
    }

    if(msg.type==="check_result_part"){
      const agg = pendingAggregations.get(msg.checkId);
      if(!agg) return;
      agg.results.push({status:msg.status,detail:msg.detail||{}});
      return;
    }

    /* ====== NEW → بث LOGIN ALL ====== */
    if(msg.type==="run_login_all"){
      if(!ws.__roomKey) return;
      broadcast(ws.__roomKey, { type:"run_login_all" });
      return;
    }
  });

  ws.on("close",()=>{
    const key=ws.__roomKey;
    if(key && rooms.get(key)){
      rooms.get(key).delete(ws);
      if(!rooms.get(key).size) rooms.delete(key);
    }
  });
});

/* ====== Ping للحفاظ على الاتصال ====== */
setInterval(()=>{
  for(const ws of wss.clients){
    if(!ws.isAlive){ ws.terminate(); continue; }
    ws.isAlive=false;
    ws.ping();
  }
},5000);

server.listen(PORT, ()=>console.log("MILANO check server running on:"+PORT));
