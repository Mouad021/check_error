// ==UserScript==
// @name         BLS ManageApplicant CHECK – Tokened (Fast progress)
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  يعمل فقط إن كان token مضافًا في /admin. العزل بحسب (origin + token). 302/Home/Error => FALSE، 5xx/شبكة => FALSE، غير ذلك TRUE. إشعار سريع ثم نتيجة نهائية. واجهة مختصرة TRUE n / FALSE n.
// @match        https://www.blsspainmorocco.net/*
// @match        https://morocco.blsportugal.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SERVER_URL_WSS = "wss://check-error-1.onrender.com";

  // ضع هنا التوكن الخاص بهذا السكربت (يجب إضافته وتمكينه في /admin)
  const CLIENT_TOKEN = "alpha123"; // ← غيّره لكل سكربت

  const APP_PING_INTERVAL_MS = 5000;
  const CHECK_TIMEOUT_MS = 900; // سريع
  const roomOrigin = location.origin;
  const clientId = getClientId();

  const TARGET_URL = roomOrigin + "/MAR/appointmentdata/ManageApplicant";

  let localTrueSeq = 0;
  let localFalseSeq = 0;

  injectUI();

  function injectUI() {
    if (document.getElementById("bls-check-wrap")) return;

    const wrap = document.createElement("div");
    wrap.id = "bls-check-wrap";
    Object.assign(wrap.style, {
      position: "fixed", left: "12px", bottom: "12px", zIndex: 2147483647,
      display: "flex", flexDirection: "column", gap: "8px", fontFamily: "sans-serif"
    });

    const pill = document.createElement("div");
    pill.id = "bls-check-pill";
    pill.textContent = "–";
    Object.assign(pill.style, {
      padding: "6px 12px", minWidth: "120px", textAlign: "center",
      fontSize: "13px", fontWeight: "700", color: "#fff",
      background: "#999", borderRadius: "999px",
      boxShadow: "0 4px 16px rgba(0,0,0,.12)",
      transition: "background 120ms linear"
    });

    const btn = document.createElement("button");
    btn.id = "bls-check-btn";
    btn.textContent = "CHECK";
    Object.assign(btn.style, {
      padding: "10px 16px", fontSize: "14px", fontWeight: "600",
      borderRadius: "10px", border: "0", color: "#fff",
      background: "#1f6feb", cursor: "pointer",
      boxShadow: "0 4px 16px rgba(0,0,0,.12)"
    });
    btn.onclick = triggerGlobalCheck;

    wrap.appendChild(pill);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  function setPill(text, bg){ const el = document.getElementById("bls-check-pill"); if(!el) return; el.textContent = text; el.style.background = bg; }
  function setPending(){ setPill("…", "#64748b"); }
  function quickTrue(){ setPill("TRUE", "#22c55e"); }
  function quickFalse(){ setPill("FALSE", "#ef4444"); }
  function finalizeTrue(){ localTrueSeq++; setPill(`TRUE ${localTrueSeq}`, "#16a34a"); }
  function finalizeFalse(){ localFalseSeq++; setPill(`FALSE ${localFalseSeq}`, "#dc2626"); }

  /* WebSocket */
  let ws;
  connectWS();

  function connectWS() {
    try { if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return; } catch {}
    try { if (ws) ws.close(); } catch {}

    ws = new WebSocket(SERVER_URL_WSS.replace(/^http/, "ws"));

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: "hello", room: roomOrigin, token: CLIENT_TOKEN }));
      } catch {}
    };

    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || typeof data !== "object") return;

      if (data.type === "error" && data.reason === "token_denied") {
        setPill("TOKEN DENIED", "#7c2d12");
        try { ws.close(); } catch {}
        return;
      }
      if (data.type === "hello_ack") return;

      if (data.type === "check_progress") {
        if (data.majority === "TRUE") quickTrue(); else quickFalse();
        return;
      }

      if (data.type === "check_result") {
        if (data.majority === "TRUE") finalizeTrue(); else finalizeFalse();
        return;
      }

      if (data.type === "run_checks" && data.checkId) {
        runLocalCheck(data.checkId).then(part => {
          safeSend({ type: "check_result_part", ...part });
        });
        return;
      }
    };

    ws.onclose = () => setTimeout(connectWS, 1200);
    ws.onerror  = () => {};
  }

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({ type: "ping", ts: Date.now() });
    }
  }, APP_PING_INTERVAL_MS);

  function safeSend(obj) {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {}
  }

  function triggerGlobalCheck() {
    setPending();
    const checkId = Math.random().toString(36).slice(2) + Date.now();
    safeSend({ type: "check_request", checkId, url: location.href, timeoutMs: CHECK_TIMEOUT_MS });
  }

  // القاعدة: أي 3xx أو Location=>/Home/Error?errorId=* أو 5xx/شبكة = FALSE؛ غيرها TRUE.
  async function runLocalCheck(checkId) {
    const start = Date.now();

    const res = await timedFetch(TARGET_URL, {
      method: "GET",
      redirect: "manual",
      credentials: "include",
      cache: "no-store",
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    }, 1500);

    let status = "OK";
    let reason = "ok";

    if (res.kind === "ERR") {
      status = "ERROR"; reason = "network";
    } else {
      const sc = res.statusCode || 0;
      const loc = (res.headers && (res.headers["location"] || res.headers["Location"])) || "";

      if ([301,302,303,307,308].includes(sc)) {
        status = "ERROR"; reason = "redirect_" + sc;
      } else if (/^https:\/\/www\.blsspainmorocco\.net\/Home\/Error\?errorId=/i.test(loc)) {
        status = "ERROR"; reason = "home_error_redirect";
      } else if (sc >= 500) {
        status = "ERROR"; reason = "5xx";
      } else {
        status = "OK"; reason = "2xx_or_4xx_ok";
      }
    }

    return {
      type: "check_result_part",
      checkId,
      from: clientId,
      status, // "OK" | "ERROR"
      detail: {
        code: res.statusCode || 0,
        location: res.headers?.location || "",
        reason,
        elapsedMs: Date.now() - start
      }
    };
  }

  async function timedFetch(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, { ...(init||{}), signal: ctrl.signal });
      let bodyText = "";
      try {
        if (r.status === 200 || (r.headers && +(r.headers.get("content-length")||0) < 1_500_000)) {
          bodyText = await r.text();
        }
      } catch (_) {}
      return {
        kind: "OK",
        statusCode: r.status,
        redirected: r.redirected,
        headers: headerMap(r.headers),
        bodyText
      };
    } catch (e) {
      return { kind: "ERR", error: String(e) };
    } finally {
      clearTimeout(to);
    }
  }

  function headerMap(h) {
    const obj = {};
    try { h.forEach((v,k) => obj[k.toLowerCase()] = v); } catch {}
    return obj;
  }

  function getClientId() {
    const KEY = "bls_ma_check_client_id";
    let cid = localStorage.getItem(KEY);
    if (!cid) { cid = Math.random().toString(36).slice(2) + Date.now(); localStorage.setItem(KEY, cid); }
    return cid;
  }
})();
