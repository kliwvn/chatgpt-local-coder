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
  "btn-install", "btn-server", "btn-tunnel", "btn-save", "btn-check",
  "btn-profile-save", "btn-profile-del", "btn-tunnel-dl", "btn-del-inst", "add-create",
];
const setBusy = (b) => {
  busy = b;
  ACTION_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.disabled = b;
  });
};

/* ---------------- state ---------------- */
const state = { instances: [], current: null, lastBundle: null };

const instUrl = (name, sub) => `/api/instances/${encodeURIComponent(name)}${sub}`;
const curUrl = (sub) => (state.current ? instUrl(state.current, sub) : null);

/* ---------------- field mapping ---------------- */
const FIELD_ENV = {
  "f-workspace": "WORKSPACE_PATH",
  "f-port": "PORT",
  "f-admin-port": "ADMIN_PORT",
  "f-profile": "CHATGPT_TOOL_PROFILE",
  "f-auto-approve": "CHATGPT_AUTO_APPROVE",
  "f-timeout": "SHELL_TIMEOUT",
  "f-recovery": "MCP_SESSION_RECOVERY",
  "f-tunnel-id": "OPENAI_TUNNEL_ID",
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
  setDot("server-dot", srv.running, srv.running ? "Đang chạy" : "Dừng");
  $("btn-server").textContent = srv.running ? "Tắt" : "Bật";
  $("btn-server").disabled = busy;
  $("server-detail").textContent = srv.running
    ? `PID ${srv.pid || "?"} • cổng ${srv.port} • workspace: ${(srv.health && srv.health.defaultCwd) || s.env.WORKSPACE_PATH || "—"}`
    : `Server chưa chạy — cổng ${srv.port}. Bấm "Bật" để khởi động.`;

  // tunnel
  const tun = s.tunnel;
  setDot("tunnel-dot", tun.running, tun.running ? "Đang chạy" : "Dừng");
  $("btn-tunnel").textContent = tun.running ? "Tắt" : "Bật";
  $("btn-tunnel").disabled = busy;
  const mode = tun.mode === "openai" ? "OpenAI Secure Tunnel" : "Cloudflare Tunnel";
  if (tun.running && tun.url) {
    $("tunnel-detail").innerHTML = `${mode} • URL: <b class="mono">${tun.url}</b>`;
    $("btn-copy-url").classList.remove("hidden");
  } else if (tun.running && tun.mode === "openai") {
    $("tunnel-detail").textContent = `${mode} đang chạy (Tunnel ID: ${tun.tunnelId || "?"}) — URL cố định dùng trong connector.`;
    $("btn-copy-url").classList.add("hidden");
  } else if (tun.running) {
    $("tunnel-detail").textContent = `${mode} đang chạy (khởi động ngoài manager) — tắt rồi bật lại để lấy URL.`;
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

/* ---------------- instance list / selection ---------------- */
function shortPath(p) {
  if (!p) return "—";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

function getInstance(name) {
  return state.instances.find((i) => i.name === name) || null;
}

async function loadInstances(initial) {
  try {
    const r = await api("/api/instances");
    state.instances = r.instances || [];
    const list = $("inst-list");
    list.innerHTML = state.instances
      .map((i) => {
        const srv = i.server.running;
        const tun = i.tunnel.running;
        const ws = i.env.WORKSPACE_PATH || "—";
        const active = state.current === i.name ? " active" : "";
        return (
          `<li class="inst-item${active}" data-name="${i.name.replace(/"/g, "&quot;")}">` +
          `<div class="inst-main">` +
          `<span class="inst-name mono">${i.name}</span>` +
          `<span class="inst-ws" title="${ws.replace(/"/g, "&quot;")}">${shortPath(ws)}</span>` +
          `</div>` +
          `<span class="inst-dots">` +
          `<span class="status-dot ${srv ? "ok" : "bad"}" title="Server ${srv ? "chạy" : "dừng"}"></span>` +
          `<span class="status-dot ${tun ? "ok" : "bad"}" title="Tunnel ${tun ? "chạy" : "dừng"}"></span>` +
          `</span></li>`
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
      await selectInstance(state.instances[0].name, true);
      return;
    }
    if (state.current) {
      const b = getInstance(state.current);
      if (b) {
        state.lastBundle = b;
        renderServerTunnel({ installed: { dist: true, nodeModules: true }, server: b.server, tunnel: b.tunnel, env: b.env, node: state.node });
      }
    }
    if (initial) setBusy(false);
  } catch (err) {
    setDot("server-dot", false, "Mất kết nối manager");
    setDot("tunnel-dot", false, "Mất kết nối manager");
    $("mgr-version").textContent = "Manager không phản hồi — kiểm tra cửa sổ manager.bat";
    if (initial) setBusy(false);
    console.error(err);
  }
}

async function selectInstance(name, initial) {
  state.current = name;
  const b = getInstance(name);
  if (!b) return;
  state.lastBundle = b;
  const env = b.env;
  const cfg = b.config;

  // form
  fillForm(env, env.OPENAI_TUNNEL_API_KEY_SET ? { set: true, last4: "••••" } : null);
  $("f-connector").value = cfg.connectorName || "";
  $("f-autostart").checked = cfg.autoStart !== false;
  $("cfg-inst-name").textContent = name;
  $("foot-admin").href = `http://127.0.0.1:${env.ADMIN_PORT || "3001"}/ui`;
  $("foot-admin").textContent = `Admin UI của ${name} (cổng ${env.ADMIN_PORT || "3001"}) ↗`;

  // raw env
  try {
    const r = await api(instUrl(name, "/env"));
    $("f-raw").value = r.raw || "";
  } catch {}

  // status
  renderServerTunnel({ installed: { dist: true, nodeModules: true }, server: b.server, tunnel: b.tunnel, env, node: state.node });
  $("check-result").classList.add("hidden");

  // sidebar active highlight
  document.querySelectorAll(".inst-item").forEach((el) => el.classList.toggle("active", el.dataset.name === name));

  // refresh statuses + installed state
  const s = await api("/api/status").catch(() => null);
  if (s) {
    state.node = s.node;
    renderServerTunnel(s);
  }
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
    const r = await api(curUrl("/check"), "POST");
    const box = $("check-result");
    box.classList.remove("hidden");
    box.innerHTML =
      `<div style="font-weight:700;margin-bottom:6px;color:${r.ok ? "var(--green)" : "var(--red)"}">` +
      (r.ok ? "✅ Cấu hình hợp lệ" : "⚠ Có mục cần sửa") + "</div>" +
      r.items.map((i) => `<div class="row-item"><span class="${i.ok ? "ok" : "bad"}">${i.ok ? "✔" : "✘"}</span><b>${i.label}:</b>&nbsp;${i.detail}</div>`).join("");
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
    await api(instUrl(name, "/env"), "PUT", body);
    await api(instUrl(name, "/config"), "PUT", {
      connectorName: $("f-connector").value.trim(),
      autoStart: $("f-autostart").checked,
    });
    rawDirty = false;
    toast("Đã lưu cấu hình workspace " + name + " ✓");

    if ($("chk-restart").checked) {
      const b = state.lastBundle;
      if (b && b.server.running) {
        await api(instUrl(name, "/server/stop"), "POST");
        await api(instUrl(name, "/server/start"), "POST");
      }
      if (b && b.tunnel.running) {
        await api(instUrl(name, "/tunnel/stop"), "POST");
        await api(instUrl(name, "/tunnel/start"), "POST");
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
    Object.keys(profiles).map((n) => `<option value="${n.replace(/"/g, "&quot;")}">${n}</option>`).join("");
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
    if (!r.ok && r.error) toast(r.error, "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  loadInstances(false);
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
  const adminPort = $("add-admin-port").value.trim();
  if (!name) {
    toast("Nhập tên workspace", "err");
    return;
  }
  setBusy(true);
  try {
    const r = await api("/api/instances", "POST", {
      name,
      workspacePath,
      port: port ? parseInt(port, 10) : undefined,
      adminPort: adminPort ? parseInt(adminPort, 10) : undefined,
      autoStart: $("add-autostart").checked,
    });
    if (!r.ok) {
      toast("Lỗi: " + (r.error || ""), "err");
      return;
    }
    toast(`Đã tạo workspace ${r.name} — cổng ${r.port} (admin ${r.adminPort})`);
    $("add-modal").close();
    $("add-name").value = "";
    $("add-workspace").value = "";
    $("add-port").value = "";
    $("add-admin-port").value = "";
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
    toast(r.ok ? `Đã xóa workspace ${name}` : "Lỗi: " + (r.error || ""), r.ok ? "ok" : "err");
    state.current = null;
    state.lastBundle = null;
    await loadInstances(false);
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
}

/* ---------------- misc ---------------- */
async function copyUrl() {
  const b = state.lastBundle;
  if (b && b.tunnel.url) {
    try {
      await navigator.clipboard.writeText(b.tunnel.url);
      toast("Đã sao chép URL: " + b.tunnel.url);
    } catch {
      toast(b.tunnel.url, "ok");
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
  $("btn-tunnel").addEventListener("click", toggleTunnel);
  $("btn-tunnel-dl").addEventListener("click", doTunnelDownload);
  $("btn-copy-url").addEventListener("click", copyUrl);
  $("btn-profile-save").addEventListener("click", doProfileSave);
  $("btn-profile-del").addEventListener("click", doProfileDelete);
  $("profile-select").addEventListener("change", onProfileSelect);
  $("f-raw").addEventListener("input", () => (rawDirty = true));
  $("btn-del-inst").addEventListener("click", doDeleteInstance);

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

  $("btn-connector").addEventListener("click", async () => {
    try {
      await api("/api/open/connector", "POST");
    } catch {
      window.open("https://chatgpt.com/settings/connectors", "_blank");
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
      toast("Không mở được hộp thoại chọn thư mục — gõ tay đường dẫn (VD: D:\\Coding\\my-app)", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // guide modal
  const modal = $("guide-modal");
  $("btn-guide").addEventListener("click", () => modal.showModal());
  $("guide-close").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.close();
  });

  // periodic refresh (không đụng form — chỉ sidebar + trạng thái)
  loadInstances(true);
  loadProfiles().catch(() => {});
  setInterval(() => !busy && loadInstances(false), 3000);
}

document.addEventListener("DOMContentLoaded", init);
