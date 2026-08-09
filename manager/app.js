/* Quản Lý ChatGPT Local Coder — frontend logic (multi-instance) */
"use strict";

const $ = (id) => document.getElementById(id);
const api = async (path, method = "GET", body) => {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = (msg, kind = "ok") => {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3800);
};

let busy = false;
const ACTION_IDS = [
  "btn-install", "btn-server", "btn-server-restart", "btn-tunnel", "btn-save", "btn-check",
  "btn-profile-save", "btn-profile-del", "btn-tunnel-dl", "btn-del-inst", "add-create",
];
const setBusy = (b) => {
  busy = b;
  ACTION_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.disabled = b;
  });
  syncActionDisabledState();
};

/* ---------------- state ---------------- */
const state = { instances: [], current: null, lastBundle: null, node: null };

function syncActionDisabledState() {
  const bundle = state.lastBundle;
  const serverConflict = Boolean(bundle?.server?.portOccupied);
  const tunnelConflict = Boolean(bundle?.tunnel?.portOccupied);
  const serverRunning = Boolean(bundle?.server?.running);
  const serverButton = $("btn-server");
  const restartButton = $("btn-server-restart");
  const tunnelButton = $("btn-tunnel");
  if (serverButton) serverButton.disabled = busy || serverConflict;
  if (restartButton) restartButton.disabled = busy || !serverRunning || serverConflict;
  if (tunnelButton) tunnelButton.disabled = busy || tunnelConflict;
}

const instUrl = (name, sub) => `/api/instances/${encodeURIComponent(name)}${sub}`;
const curUrl = (sub) => (state.current ? instUrl(state.current, sub) : null);

/* ---------------- field mapping ---------------- */
const FIELD_ENV = {
  "f-workspace": "WORKSPACE_PATH",
  "f-port": "PORT",
  "f-profile": "CHATGPT_TOOL_PROFILE",
  "f-auto-approve": "CHATGPT_AUTO_APPROVE",
  "f-timeout": "SHELL_TIMEOUT",
  "f-recovery": "MCP_SESSION_RECOVERY",
  "f-session-ttl": "MCP_SESSION_TTL_MS",
  "f-session-cleanup": "MCP_SESSION_CLEANUP_MS",
  "f-session-grace": "MCP_SESSION_DELETE_GRACE_MS",
  "f-session-max": "MCP_MAX_SESSIONS",
  "f-tunnel-id": "OPENAI_TUNNEL_ID",
  "f-full-disk": "FULL_DISK_ACCESS",
  "f-extra-ws": "EXTRA_WORKSPACE_PATHS",
  "f-mem-bytes": "PROJECT_MEMORY_MAX_BYTES",
  "f-mem-lines": "PROJECT_MEMORY_MAX_LINES",
};

function collectValues() {
  const values = {};
  for (const [id, key] of Object.entries(FIELD_ENV)) values[key] = $(id).value.trim();
  if ($("f-tunnel-key").value) values.OPENAI_TUNNEL_API_KEY = $("f-tunnel-key").value.trim();
  return values;
}

function fillForm(values, keySet) {
  for (const [id, key] of Object.entries(FIELD_ENV)) {
    if (values[key] !== undefined) $(id).value = values[key];
  }
  if (keySet) {
    $("f-tunnel-key").value = "";
    $("key-hint").textContent = `API key đã đặt (…${keySet.last4}) — để nguyên để giữ, gõ giá trị mới để thay thế.`;
    $("f-tunnel-key").placeholder = "•••••••••••• (đã đặt)";
  } else {
    // instance mới không có key — xóa giá trị cũ để không lưu nhầm secret của workspace khác
    $("f-tunnel-key").value = "";
    $("key-hint").textContent = "";
    $("f-tunnel-key").placeholder = "sk-… (Runtime key)";
  }
}

/* ---------------- status rendering ---------------- */
function setDot(id, ok, label) {
  const dot = $(id);
  dot.className = `status-dot ${ok ? "ok" : "bad"}`;
  if (label != null) {
    const lbl = $(id.replace("-dot", "-status"));
    if (lbl) lbl.textContent = label;
  }
}

function renderServerTunnel(s) {
  // install (global)
  const installed = s.installed.dist && s.installed.nodeModules;
  $("install-status").textContent = installed ? "Trạng thái: Đã cài đặt OK" : "Trạng thái: Chưa cài đặt";
  setDot("install-dot", installed, null);
  $("btn-install").disabled = busy;

  // server
  const srv = s.server;
  const serverConflict = Boolean(srv.portOccupied);
  setDot("server-dot", srv.running, srv.running ? "Đang chạy" : serverConflict ? "Xung đột cổng" : "Dừng");
  setDot("inst-server-dot", srv.running, srv.running ? "Server: chạy" : serverConflict ? "Server: xung đột cổng" : "Server: dừng");
  $("btn-server").textContent = srv.running ? "Tắt" : "Bật";
  $("btn-server").disabled = busy || serverConflict;
  $("btn-server-restart").disabled = busy || !srv.running || serverConflict;
  const roots =
    (srv.health && srv.health.instructions && srv.health.instructions.workspace_roots) ||
    (s.env.WORKSPACE_PATH ? [s.env.WORKSPACE_PATH] : []);
  const wsLabel =
    roots.length > 1
      ? `${roots[0]} (+${roots.length - 1} path mở rộng)`
      : roots[0] || (srv.health && srv.health.defaultCwd) || "—";
  $("server-detail").textContent = srv.running
    ? `PID ${srv.pid || "?"} • cổng ${srv.port} • workspace: ${wsLabel} • ${srv.health ? `${srv.health.activeSessions ?? 0} phiên đã đăng ký${srv.health.connectedSessions != null ? ` (${srv.health.connectedSessions} đang kết nối)` : ""}` : "health: —"}`
    : serverConflict
      ? `Cổng ${srv.port} đang bị process khác chiếm${srv.pid ? ` (PID ${srv.pid})` : ""}. Đổi PORT hoặc dừng process đó trước khi bật Local Coder.`
      : `Server chưa chạy — cổng ${srv.port}. Bấm "Bật" để khởi động.`;

  // tunnel
  const tun = s.tunnel;
  const tunnelConflict = Boolean(tun.portOccupied);
  setDot("tunnel-dot", tun.running, tun.running ? "Đang chạy" : tunnelConflict ? "Xung đột cổng" : "Dừng");
  setDot("inst-tunnel-dot", tun.running, tun.running ? "Tunnel: chạy" : tunnelConflict ? "Tunnel: xung đột cổng" : "Tunnel: dừng");
  $("btn-tunnel").textContent = tun.running ? "Tắt" : "Bật";
  $("btn-tunnel").disabled = busy || tunnelConflict;
  const mode = tun.mode === "openai" ? "OpenAI Secure Tunnel" : "Cloudflare Tunnel";
  if (tun.running && tun.url) {
    $("tunnel-detail").innerHTML = `${esc(mode)} • URL: <b class="mono">${esc(tun.url)}</b>`;
    $("btn-copy-url").classList.remove("hidden");
  } else if (tun.running && tun.mode === "openai") {
    $("tunnel-detail").textContent = `${mode} đang chạy (Tunnel ID: ${tun.tunnelId || "?"}) — URL cố định dùng trong connector.`;
    $("btn-copy-url").classList.add("hidden");
  } else if (tun.running) {
    $("tunnel-detail").textContent = `${mode} đang chạy (khởi động ngoài manager) — tắt rồi bật lại để lấy URL.`;
    $("btn-copy-url").classList.add("hidden");
  } else if (tunnelConflict) {
    $("tunnel-detail").textContent = `Tunnel health port ${tun.healthPort} đang bị process khác chiếm. Đổi OPENAI_TUNNEL_HEALTH_PORT hoặc dừng process đó.`;
    $("btn-copy-url").classList.add("hidden");
  } else {
    $("tunnel-detail").textContent =
      tun.mode === "openai"
        ? `Chưa chạy — dùng OpenAI Tunnel (ID: ${tun.tunnelId || "(thiếu)"}).`
        : tun.cloudflaredExists
          ? "Chưa chạy — Cloudflare quick tunnel. URL đổi mỗi lần khởi động."
          : "Chưa có cloudflared.exe — bấm 'Tải cloudflared'.";
    $("btn-copy-url").classList.add("hidden");
  }

  $("btn-tunnel-dl").classList.toggle("hidden", tun.cloudflaredExists !== false || tun.running);

  $("mgr-version").textContent = `Manager 127.0.0.1:${location.port} • Node ${s.node}`;
}


/* ---------------- log viewer ---------------- */
// Keep the MCP-only view aligned with the server-side activity taxonomy. A
// command outcome is still tool activity even though it is deliberately not an
// MCP transport error.
const LOG_MCP_RE = /\[(?:MCP|TOOL|AUDIT)(?: ERROR| FAILED)?\]|\[COMMAND (?:FAILED|NO MATCH)\]/i;
const LOG_STATE = { mode: "all", paused: false, sourceLog: "", lastLog: "", lastSize: 0, lastCount: 0, lastMtime: 0, fetchInFlight: false };
let instancesFetchInFlight = false;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function renderLogLines(logText) {
  const out = [];
  for (const line of String(logText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const isMcp = LOG_MCP_RE.test(line);
    if (LOG_STATE.mode === "mcp" && !isMcp) continue;
    const e = esc(line);
    let cls = "";
    if (/MCP ERROR|TOOL ERROR|TOOL FAILED|COMMAND FAILED|\[err|\[error\]|\[fail\]/i.test(line)) cls = "err";
    else if (isMcp && /\[TOOL\]/.test(line)) cls = "tool";
    else if (isMcp) cls = "mcp";
    else if (/\[HTTP\]/.test(line)) cls = "http";
    out.push(cls ? `<div class="${cls}">${e}</div>` : `<div>${e}</div>`);
  }
  return out.join("");
}

function renderLogView() {
  const view = $("log-view");
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const html = renderLogLines(LOG_STATE.lastLog);
  view.innerHTML = html || '<div class="hint">(không có dòng phù hợp)</div>';
  $("log-meta").textContent = LOG_STATE.lastMtime
    ? `server.log — ${fmtBytes(LOG_STATE.lastSize)} · ${LOG_STATE.lastCount} dòng (tail) · cập nhật ${new Date(LOG_STATE.lastMtime).toLocaleTimeString("vi-VN")}${LOG_STATE.mode === "mcp" ? " · lọc: MCP/TOOL/COMMAND" : ""}`
    : "";
  if (atBottom) view.scrollTop = view.scrollHeight;
}

function setLogMode(mode) {
  LOG_STATE.mode = mode;
  $("log-mode-all").classList.toggle("active", mode === "all");
  $("log-mode-mcp").classList.toggle("active", mode === "mcp");
  renderLogView();
}

function logSnapshotDelta(previous, next) {
  if (!previous) return { append: next, reset: true };
  if (previous === next) return { append: "", reset: false };
  const prev = previous.split(/\r?\n/).filter(Boolean);
  const curr = next.split(/\r?\n/).filter(Boolean);
  const max = Math.min(prev.length, curr.length);
  for (let n = max; n > 0; n--) {
    let same = true;
    for (let i = 0; i < n; i++) {
      if (prev[prev.length - n + i] !== curr[i]) { same = false; break; }
    }
    if (same) return { append: curr.slice(n).join("\n"), reset: false };
  }
  return { append: next, reset: true };
}

async function loadLog() {
  if (!state.current || LOG_STATE.paused || LOG_STATE.fetchInFlight || document.visibilityState !== "visible") return;
  const name = state.current;
  LOG_STATE.fetchInFlight = true;
  try {
    const q = new URLSearchParams({ kind: "server", max: "300000" });
    if (LOG_STATE.lastSize > 0 || LOG_STATE.lastMtime > 0) {
      q.set("if_size", String(LOG_STATE.lastSize));
      q.set("if_mtime", String(LOG_STATE.lastMtime));
    }
    const r = await api(instUrl(name, `/log?${q.toString()}`));
    if (state.current !== name) return;
    if (r.unchanged) return;
    const next = r.log || "";
    const delta = logSnapshotDelta(LOG_STATE.sourceLog, next);
    LOG_STATE.sourceLog = next;
    if (delta.reset) LOG_STATE.lastLog = delta.append;
    else if (delta.append) LOG_STATE.lastLog = [LOG_STATE.lastLog, delta.append].filter(Boolean).join("\n");
    LOG_STATE.lastSize = r.size || 0;
    LOG_STATE.lastCount = next.split(/\r?\n/).filter((l) => l.trim()).length;
    // Bound the on-screen buffer to the authoritative tail size so repeated
    // overlap appends cannot grow beyond what the server actually returns.
    if (LOG_STATE.lastCount > 0) {
      LOG_STATE.lastLog = LOG_STATE.lastLog.split(/\r?\n/).filter(Boolean).slice(-LOG_STATE.lastCount).join("\n");
    }
    LOG_STATE.lastMtime = r.mtime || 0;
    renderLogView();
  } catch {
    /* instance chưa có log file — giữ nguyên view */
  } finally {
    LOG_STATE.fetchInFlight = false;
  }
}
/* ---------------- instance list / selection ---------------- */
function splitExtraWorkspacePaths(value) {
  return String(value || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getInstance(name) {
  return state.instances.find((i) => i.name === name) || null;
}

async function loadInstances(initial) {
  if (instancesFetchInFlight || (!initial && document.visibilityState !== "visible")) return;
  instancesFetchInFlight = true;
  try {
    const r = await api("/api/instances");
    state.node = r.node || null;
    state.instances = r.instances || [];
    const list = $("inst-list");
    list.innerHTML = state.instances
      .map((i) => {
        const srv = i.server.running;
        const tun = i.tunnel.running;
        const ws = i.env.WORKSPACE_PATH || "—";
        const extra = i.env.EXTRA_WORKSPACE_PATHS || "";
        const extraRoots = splitExtraWorkspacePaths(extra);
        const extraInline = extraRoots.join("; ");
        const extraHtml = extraRoots.length
          ? `<div class="inst-extra" title="${esc(extraInline)}"><span class="inst-extra-label">EXTRA:</span><span class="inst-extra-path mono">${esc(extraInline)}</span></div>`
          : "";
        const access = i.env.FULL_DISK_ACCESS === "true" ? "full path" : "workspace paths";
        const port = i.server.port || i.env.PORT || "—";
        const active = state.current === i.name ? " active" : "";
        const stateTxt = srv
          ? `<span class="status-dot ok"></span>Server chạy <span class="status-dot ok"></span>Tunnel ${tun ? "chạy" : "dừng"}`
          : `<span class="status-dot bad"></span>Server dừng <span class="status-dot ${tun ? "ok" : "bad"}"></span>Tunnel ${tun ? "chạy" : "dừng"}`;
        return (
          `<li class="inst-item${active}" data-name="${esc(i.name)}">` +
          `<div class="inst-main">` +
          `<div class="inst-top"><span class="inst-name mono">${esc(i.name)}</span><span class="inst-state">${stateTxt}</span></div>` +
          `<span class="inst-ws" title="${esc(ws)}">${esc(ws)}</span>` +
          extraHtml +
          `<span class="inst-access">FULL_DISK_ACCESS: ${access}</span>` +
          `<span class="inst-meta">:${esc(String(port))} · pid ${esc(String(i.server.pid || "—"))}${srv && i.server.health ? ` · ${i.server.health.activeSessions ?? 0} đăng ký${i.server.health.connectedSessions != null ? ` · ${i.server.health.connectedSessions} kết nối` : ""}` : ""}</span>` +
          `</div>` +
          `</li>`
        );
      })
      .join("");
    list.querySelectorAll(".inst-item").forEach((el) =>
      el.addEventListener("click", () => selectInstance(el.dataset.name))
    );

    const any = state.instances.length > 0;
    $("empty-state").classList.toggle("hidden", any);
    $("inst-panel-wrap").classList.toggle("hidden", !any);

    if (state.current && !state.instances.some((i) => i.name === state.current)) {
      state.current = null;
    }
    if (!state.current && state.instances.length > 0) {
      if (initial) await selectInstance(state.instances[0].name, true);
      return;
    }
    if (state.current) {
      const b = getInstance(state.current);
      if (b) {
        state.lastBundle = b;
        renderServerTunnel(b);
      }
    }
    if (initial) setBusy(false);
  } catch (err) {
    setDot("server-dot", false, "Mất kết nối manager");
    setDot("tunnel-dot", false, "Mất kết nối manager");
    setDot("inst-server-dot", false, "Server: —");
    setDot("inst-tunnel-dot", false, "Tunnel: —");
    $("mgr-version").textContent = "Manager không phản hồi — kiểm tra cửa sổ manager.bat";
    if (initial) setBusy(false);
    console.error(err);
  } finally {
    instancesFetchInFlight = false;
  }
}

async function selectInstance(name, initial) {
  const b = getInstance(name);
  if (!b) {
    if (state.current === name) state.current = null;
    return;
  }
  state.current = name;
  LOG_STATE.sourceLog = "";
  LOG_STATE.lastLog = "";
  LOG_STATE.lastSize = 0;
  LOG_STATE.lastMtime = 0;
  LOG_STATE.lastCount = 0;
  state.lastBundle = b;
  const env = b.env;
  const cfg = b.config;

  // form
  fillForm(env, env.OPENAI_TUNNEL_API_KEY_SET ? { set: true, last4: "••••" } : null);
  $("f-connector").value = cfg.connectorName || "";
  $("f-autostart").checked = cfg.autoStart !== false;
  $("cfg-inst-name").textContent = name;
  $("log-inst-name").textContent = name;
  $("foot-admin").href = `/admin/ui/?instance=${encodeURIComponent(name)}`;
  $("foot-admin").textContent = `Admin UI của ${name} (qua manager) ↗`;

  // raw env — server trả masked values (không bao giờ gửi plaintext .env).
  // Dựng lại dạng KEY=VALUE cho editor; secret hiện là sentinel ******** và
  // được server khôi phục lại giá trị cũ khi lưu.
  try {
    const r = await api(instUrl(name, "/env"));
    if (state.current !== name) return; // user đã chuyển instance — không đè form
    $("f-raw").value = Object.entries(r.values || {})
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? "********" : v}`)
      .join("\n");
  } catch (err) {
    if (state.current !== name) return;
    $("f-raw").value = "";
    console.warn("load raw env lỗi:", err);
  }

  // status
  renderServerTunnel(b);
  $("check-result").classList.add("hidden");

  // sidebar active highlight
  document.querySelectorAll(".inst-item").forEach((el) => el.classList.toggle("active", el.dataset.name === name));

  // nút Xóa chỉ hiện với workspace không phải default (server cũng chặn)
  $("btn-del-inst").classList.toggle("hidden", name === "default");

  loadLog();

  if (initial) setBusy(false);
}

/* ---------------- install ---------------- */
async function doInstall() {
  setBusy(true);
  $("install-progress").classList.remove("hidden");
  $("install-log").textContent = "Đang cài dependencies + build… (có thể mất 1-2 phút)";
  try {
    const r = await api("/api/install", "POST");
    $("install-log").textContent = r.output || "(không có output)";
    toast(r.ok ? "Cài đặt xong" : "Cài đặt lỗi — xem log", r.ok ? "ok" : "err");
  } catch (err) {
    $("install-log").textContent = String(err.message || err);
    toast("Cài đặt lỗi", "err");
  }
  setBusy(false);
  loadInstances(false);
}

/* ---------------- check / save ---------------- */
async function doCheck() {
  if (!state.current) return;
  setBusy(true);
  try {
    const r = await api(curUrl("/check"), "POST", { values: collectValues() });
    const box = $("check-result");
    box.classList.remove("hidden");
    if (r.error) {
      box.innerHTML = `<div style="font-weight:700;color:var(--red)">⚠ Kiểm tra gặp lỗi nội bộ</div><div class="row-item">${esc(r.error)}</div>`;
    } else {
      box.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px;color:${r.ok ? "var(--green)" : "var(--red)"}">` +
        (r.ok ? "✅ Cấu hình hợp lệ" : "⚠ Có mục cần sửa") + "</div>" +
        (r.items || []).map((i) => `<div class="row-item"><span class="${i.ok ? "ok" : "bad"}">${i.ok ? "✔" : "✘"}</span><b>${esc(i.label)}:</b>&nbsp;${esc(i.detail)}</div>`).join("");
    }
    toast(r.ok ? "Cấu hình hợp lệ" : "Có mục chưa đạt", r.ok ? "ok" : "err");
  } catch (err) {
    toast("Kiểm tra lỗi: " + err.message, "err");
  }
  setBusy(false);
}

let rawDirty = false;

async function doSave() {
  if (!state.current) return;
  const name = state.current;
  setBusy(true);
  try {
    const body = rawDirty ? { raw: $("f-raw").value } : { values: collectValues() };
    const envRes = await api(instUrl(name, "/env"), "PUT", body);
    if (!envRes.ok) throw new Error(envRes.error || "Lưu .env thất bại");
    const cfgRes = await api(instUrl(name, "/config"), "PUT", {
      connectorName: $("f-connector").value.trim(),
      autoStart: $("f-autostart").checked,
    });
    if (!cfgRes.ok) throw new Error(cfgRes.error || "Lưu cấu hình thất bại");
    rawDirty = false;
    if ($("chk-restart").checked) {
      const b = state.lastBundle;
      if (b && b.server.running) {
        const restarted = await api(instUrl(name, "/server/restart"), "POST");
        if (!restarted.ok) throw new Error(restarted.error || "Restart Gateway thất bại");
      } else if (b && !b.server.running) {
        const started = await api(instUrl(name, "/server/start"), "POST");
        if (!started.ok) throw new Error(started.error || "Khởi động Gateway thất bại");
      }
      if (b && b.tunnel.running) {
        const restartedTunnel = await api(instUrl(name, "/tunnel/restart"), "POST");
        if (!restartedTunnel.ok) throw new Error(restartedTunnel.error || "Restart Tunnel thất bại");
      } else if (b && !b.tunnel.running) {
        const startedTunnel = await api(instUrl(name, "/tunnel/start"), "POST");
        if (!startedTunnel.ok) throw new Error(startedTunnel.error || "Khởi động Tunnel thất bại");
      }
    }
    await loadInstances(false);
    await selectInstance(name);
  } catch (err) {
    toast("Lưu lỗi: " + err.message, "err");
  }
  setBusy(false);
}

/* ---------------- profiles ---------------- */
let profiles = {};

async function loadProfiles() {
  const r = await api("/api/profiles");
  profiles = r.profiles || {};
  const sel = $("profile-select");
  sel.innerHTML = '<option value="">Mặc định</option>' +
    Object.keys(profiles).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

async function doProfileSave() {
  const name = prompt("Tên profile (để lưu cấu hình hiện tại):", "");
  if (!name) return;
  setBusy(true);
  try {
    const values = collectValues();
    values.MCP_CONNECTOR_NAME = $("f-connector").value.trim();
    await api("/api/profiles", "POST", { name, values });
    await loadProfiles();
    toast("Đã lưu profile " + name);
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}

async function doProfileDelete() {
  const name = $("profile-select").value;
  if (!name) return;
  if (!confirm(`Xóa profile "${name}"?`)) return;
  setBusy(true);
  try {
    await api(`/api/profiles?name=${encodeURIComponent(name)}`, "DELETE");
    await loadProfiles();
    toast("Đã xóa profile");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}

async function onProfileSelect() {
  const name = $("profile-select").value;
  if (!name) return;
  const p = profiles[name];
  if (!p || !p.values) return;
  const vals = { ...p.values };
  const key = vals.OPENAI_TUNNEL_API_KEY;
  delete vals.OPENAI_TUNNEL_API_KEY;
  fillForm(vals, key ? { set: true, last4: String(key).slice(-4) } : null);
  if (vals.MCP_CONNECTOR_NAME) $("f-connector").value = vals.MCP_CONNECTOR_NAME;
}

/* ---------------- server / tunnel toggles ---------------- */
async function toggleServer() {
  if (!state.current) return;
  const name = state.current;
  setBusy(true);
  try {
    const b = state.lastBundle;
    const r = b && b.server.running
      ? await api(instUrl(name, "/server/stop"), "POST")
      : await api(instUrl(name, "/server/start"), "POST");
    toast(r.ok ? (r.alreadyRunning ? "Server đã chạy" : r.alreadyStopped ? "Server đã dừng" : "OK") : "Lỗi: " + (r.error || ""), r.ok ? "ok" : "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  loadInstances(false);
}

async function restartGateway() {
  if (!state.current) return;
  const name = state.current;
  const beforePid = state.lastBundle?.server?.pid || null;
  setBusy(true);
  toast("Đang khởi động lại Gateway…");
  try {
    const r = await api(instUrl(name, "/server/restart"), "POST");
    if (!r.ok || !r.restarted) throw new Error(r.error || "Gateway restart failed");
    const pidText = beforePid && r.pid ? ` (PID ${beforePid} → ${r.pid})` : r.pid ? ` (PID ${r.pid})` : "";
    toast(`Gateway đã khởi động lại${pidText}; Tunnel được giữ nguyên.`, "ok");
    LOG_STATE.sourceLog = "";
    LOG_STATE.lastSize = 0;
    LOG_STATE.lastMtime = 0;
    await loadInstances(false);
    if (state.current === name) await selectInstance(name);
  } catch (err) {
    toast("Khởi động lại Gateway lỗi: " + err.message, "err");
  } finally {
    setBusy(false);
  }
}

async function toggleTunnel() {
  if (!state.current) return;
  const name = state.current;
  setBusy(true);
  try {
    const b = state.lastBundle;
    let r;
    if (b && b.tunnel.running) {
      r = await api(instUrl(name, "/tunnel/stop"), "POST");
    } else {
      r = await api(instUrl(name, "/tunnel/start"), "POST");
      if (!r.ok && r.error === "NO_CLOUDFLARED") {
        toast("Chưa có cloudflared — bấm 'Tải cloudflared'", "err");
      }
    }
    if (!r.ok) toast(r.error || "Lỗi", "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  loadInstances(false);
}

async function doTunnelDownload() {
  setBusy(true);
  try {
    toast("Đang tải cloudflared…");
    const r = await api("/api/tunnel/download", "POST");
    toast(r.ok ? "Đã tải cloudflared ✓ — bấm Bật Tunnel" : "Lỗi tải: " + (r.error || ""), r.ok ? "ok" : "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  loadInstances(false);
}

/* ---------------- add / delete workspace ---------------- */
async function doAddInstance() {
  const name = $("add-name").value.trim().toLowerCase();
  const workspacePath = $("add-workspace").value.trim();
  const port = $("add-port").value.trim();
  if (!name) {
    toast("Nhập tên workspace", "err");
    return;
  }
  const parsedPort = port ? Number(port) : undefined;
  if (port && (!Number.isInteger(parsedPort) || parsedPort < 3000 || parsedPort > 3999)) {
    toast("Cổng không hợp lệ (3000-3999)", "err");
    return;
  }
  setBusy(true);
  try {
    const r = await api("/api/instances", "POST", {
      name,
      workspacePath,
      port: parsedPort,
      autoStart: $("add-autostart").checked,
    });
    if (!r.ok) {
      toast("Lỗi: " + (r.error || ""), "err");
      return;
    }
    toast(`Đã tạo workspace ${r.name} — MCP cổng ${r.port} (admin tự cấp)`);
    $("add-modal").close();
    $("add-name").value = "";
    $("add-workspace").value = "";
    $("add-port").value = "";
    await loadInstances(false);
    await selectInstance(r.name);
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}

async function doDeleteInstance() {
  if (!state.current) return;
  const name = state.current;
  if (!confirm(`Xóa workspace "${name}"?\n\nServer + tunnel của workspace này sẽ bị dừng, file cấu hình bị xóa. (Không ảnh hưởng workspace khác.)`)) return;
  setBusy(true);
  try {
    const r = await api(instUrl(name, ""), "DELETE");
    if (!r.ok) {
      toast("Lỗi: " + (r.error || ""), "err");
      return;
    }
    toast(`Đã xóa workspace ${name}`, "ok");
    state.current = null;
    state.lastBundle = null;
    await loadInstances(false);
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}
async function doRenameInstance() {
  if (!state.current) return;
  const oldName = state.current;
  const newName = $("rename-name").value.trim().toLowerCase();
  if (!newName) {
    toast("Nhập tên mới", "err");
    return;
  }
  setBusy(true);
  try {
    const r = await api(instUrl(oldName, "/rename"), "POST", { name: newName });
    if (!r.ok) {
      toast("Lỗi: " + (r.error || ""), "err");
      return;
    }
    toast(r.renamed ? `Đã đổi tên ${oldName} → ${r.name}` : "Không có gì thay đổi");
    $("rename-modal").close();
    $("rename-name").value = "";
    state.current = r.name;
    state.lastBundle = null;
    await loadInstances(false);
    await selectInstance(r.name);
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}

/* ---------------- misc ---------------- */
async function copyUrl() {
  const el = document.querySelector("#tunnel-detail .mono");
  const url = el ? el.textContent.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    await navigator.clipboard.writeText(url);
    toast("Đã sao chép URL: " + url, "ok");
  } catch {
    // fallback cho trình duyệt không cho clipboard API (http non-secure context)
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Đã sao chép URL: " + url, "ok");
    } catch {
      toast("Không copy được — URL: " + url, "err");
    }
  }
}

function init() {
  setBusy(true);

  // data-open buttons → window.open
  document.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => window.open(el.dataset.open, "_blank"));
  });

  $("btn-install").addEventListener("click", doInstall);
  $("btn-check").addEventListener("click", doCheck);
  $("btn-save").addEventListener("click", doSave);
  $("btn-server").addEventListener("click", toggleServer);
  $("btn-server-restart").addEventListener("click", restartGateway);
  $("btn-tunnel").addEventListener("click", toggleTunnel);
  $("btn-tunnel-dl").addEventListener("click", doTunnelDownload);
  $("btn-copy-url").addEventListener("click", copyUrl);
  $("btn-profile-save").addEventListener("click", doProfileSave);
  $("btn-profile-del").addEventListener("click", doProfileDelete);
  $("profile-select").addEventListener("change", onProfileSelect);
  $("f-raw").addEventListener("input", () => (rawDirty = true));
  $("btn-del-inst").addEventListener("click", doDeleteInstance);
  const renameModal = $("rename-modal");
  $("btn-rename-inst").addEventListener("click", () => {
    if (!state.current) return;
    $("rename-name").value = state.current;
    renameModal.showModal();
  });
  $("rename-close").addEventListener("click", () => renameModal.close());
  $("rename-save").addEventListener("click", doRenameInstance);
  renameModal.addEventListener("click", (e) => {
    if (e.target === renameModal) renameModal.close();
  });

  // add workspace modal
  const addModal = $("add-modal");
  $("btn-add-inst").addEventListener("click", () => addModal.showModal());
  $("add-close").addEventListener("click", () => addModal.close());
  $("add-create").addEventListener("click", doAddInstance);
  addModal.addEventListener("click", (e) => {
    if (e.target === addModal) addModal.close();
  });
  $("add-pick").addEventListener("click", async () => {
    const btn = $("add-pick");
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Đang chọn...";
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        toast("Lỗi mở hộp thoại: " + (data.error || "không rõ"), "err");
        return;
      }
      if (!data.cancelled) {
        $("add-workspace").value = data.path;
        toast("Đã chọn: " + data.path, "ok");
      }
    } catch (err) {
      toast("Không mở được hộp thoại chọn thư mục — gõ tay đường dẫn (VD: D:\\Coding\\my-app)", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $("btn-connector").addEventListener("click", () => {
    // Mở thẳng từ trình duyệt (user gesture) — không phụ thuộc server session,
    // vì cmd /c start từ manager chạy trong session khác không hiện trên desktop.
    const url = "https://chatgpt.com/settings/connectors";
    if (!window.open(url, "_blank", "noopener")) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });

  // folder picker (per current instance): native dialog qua manager server
  $("btn-workspace-pick").addEventListener("click", async () => {
    if (!state.current) return;
    const btn = $("btn-workspace-pick");
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Đang chọn...";
    try {
      const res = await fetch(instUrl(state.current, "/pick-folder"), { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        toast("Lỗi mở hộp thoại: " + (data.error || "không rõ"), "err");
        return;
      }
      if (data.cancelled) return; // user hủy — giữ giá trị cũ
      $("f-workspace").value = data.path;
      toast("Đã chọn: " + data.path, "ok");
    } catch (err) {
      toast("Lỗi chọn folder: " + (err.message || err), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // guide modal
  const modal = $("guide-modal");
  $("btn-guide").addEventListener("click", () => {
    const b = state.lastBundle;
    const roots =
      (b && b.server.health && b.server.health.instructions && b.server.health.instructions.workspace_roots) ||
      (b && b.env && b.env.WORKSPACE_PATH ? [b.env.WORKSPACE_PATH] : []);
    $("guide-ws").textContent = roots.length
      ? `Workspace hiện tại (${state.current || "?"}): ${roots.join("  ·  ")} — ChatGPT chỉ truy cập file trong các thư mục này.`
      : "Chưa có instance focus — chọn workspace ở sidebar trước.";
    modal.showModal();
  });
  $("guide-close").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.close();
  });


  // autostart (manager chạy khi đăng nhập Windows) — bật/tắt qua Startup folder
  const btnAuto = $("btn-autostart");
  async function refreshAutostart() {
    try {
      const res = await fetch("/api/autostart");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "lỗi");
      btnAuto.textContent = data.enabled
        ? "⚡ Tự chạy khi đăng nhập: BẬT"
        : "⚡ Tự chạy khi đăng nhập: TẮT";
      btnAuto.dataset.on = data.enabled ? "1" : "0";
      btnAuto.classList.toggle("btn-green", data.enabled);
    } catch (err) {
      btnAuto.textContent = "⚡ Tự chạy khi đăng nhập: lỗi kiểm tra";
    }
  }
  btnAuto.addEventListener("click", async () => {
    const enable = btnAuto.dataset.on !== "1";
    btnAuto.disabled = true;
    try {
      const res = await fetch("/api/autostart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "lỗi");
      toast(enable ? "Đã bật autostart — manager sẽ tự chạy khi bạn đăng nhập" : "Đã tắt autostart", "ok");
      await refreshAutostart();
    } catch (err) {
      toast("Lỗi đổi autostart: " + err.message, "err");
    } finally {
      btnAuto.disabled = false;
    }
  });
  refreshAutostart().catch(() => {});

  // log viewer controls
  $("log-mode-all").addEventListener("click", () => setLogMode("all"));
  $("log-mode-mcp").addEventListener("click", () => setLogMode("mcp"));
  $("log-pause").addEventListener("click", () => {
    LOG_STATE.paused = !LOG_STATE.paused;
    $("log-pause").textContent = LOG_STATE.paused ? "▶" : "⏸";
    if (!LOG_STATE.paused) loadLog();
  });
  $("log-clear").addEventListener("click", () => {
    // Visual clear only: preserve sourceLog as the checkpoint, otherwise the
    // next poll would rehydrate the whole historical tail.
    LOG_STATE.lastLog = "";
    $("log-view").textContent = "";
    renderLogView();
  });

  // periodic refresh (không đụng form — chỉ sidebar + trạng thái)
  loadInstances(true);
  loadProfiles().catch(() => {});
  setInterval(() => !busy && loadInstances(false), 3000);
  setInterval(loadLog, 2500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!busy) void loadInstances(false);
      void loadLog();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
