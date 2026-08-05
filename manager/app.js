/* Quản Lý ChatGPT Local Coder — frontend logic */
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
const setBusy = (b) => {
  busy = b;
  ["btn-install", "btn-server", "btn-tunnel", "btn-save", "btn-check", "btn-profile-save", "btn-profile-del", "btn-tunnel-dl"].forEach(
    (id) => ($(id).disabled = b)
  );
};

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

let lastStatus = null;

async function refreshStatus(initial) {
  try {
    const s = await api("/api/status");
    lastStatus = s;

    // 1. install
    const installed = s.installed.dist && s.installed.nodeModules;
    $("install-status").textContent = installed ? "Trạng thái: Đã cài đặt OK" : "Trạng thái: Chưa cài đặt";
    setDot("install-dot", installed, null);
    $("btn-install").disabled = busy;

    // 2. server
    const srv = s.server;
    setDot("server-dot", srv.running, srv.running ? "Đang chạy" : "Dừng");
    $("btn-server").textContent = srv.running ? "Tắt" : "Bật";
    $("btn-server").disabled = busy;
    $("server-detail").textContent = srv.running
      ? `PID ${srv.pid || "?"} • cổng ${srv.port} • workspace: ${(srv.health && srv.health.defaultCwd) || s.env.WORKSPACE_PATH || "—"}`
      : `Server chưa chạy — cổng ${srv.port}. Bấm "Bật" để khởi động.`;

    // 3. tunnel
    const tun = s.tunnel;
    const tunLabel = tun.running ? "Đang chạy" : "Dừng";
    setDot("tunnel-dot", tun.running, tunLabel);
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
    if (initial) setBusy(false);
  } catch (err) {
    setDot("server-dot", false, "Mất kết nối manager");
    setDot("tunnel-dot", false, "Mất kết nối manager");
    $("mgr-version").textContent = "Manager không phản hồi — kiểm tra cửa sổ manager.bat";
    if (initial) setBusy(false);
    console.error(err);
  }
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
  refreshStatus(false);
}

/* ---------------- check / save ---------------- */
async function doCheck() {
  setBusy(true);
  try {
    const r = await api("/api/check", "POST");
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
  setBusy(true);
  try {
    const body = rawDirty ? { raw: $("f-raw").value } : { values: collectValues() };
    await api("/api/env", "PUT", body);
    await api("/api/config", "PUT", { connectorName: $("f-connector").value.trim() });
    rawDirty = false;
    toast("Đã lưu .env ✓");

    if ($("chk-restart").checked) {
      const s = lastStatus;
      if (s && s.server.running) {
        await api("/api/server/stop", "POST");
        await api("/api/server/start", "POST");
      }
      if (s && s.tunnel.running) {
        await api("/api/tunnel/stop", "POST");
        await api("/api/tunnel/start", "POST");
      }
    }
    await loadEnv();
    await refreshStatus(false);
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
  setBusy(true);
  try {
    const s = lastStatus;
    const r = s && s.server.running ? await api("/api/server/stop", "POST") : await api("/api/server/start", "POST");
    toast(r.ok ? (r.alreadyRunning ? "Server đã chạy" : r.alreadyStopped ? "Server đã dừng" : "OK") : "Lỗi: " + (r.error || ""), r.ok ? "ok" : "err");
    if (!r.ok && r.error) toast(r.error, "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  refreshStatus(false);
}

async function toggleTunnel() {
  setBusy(true);
  try {
    const s = lastStatus;
    let r;
    if (s && s.tunnel.running) {
      r = await api("/api/tunnel/stop", "POST");
    } else {
      r = await api("/api/tunnel/start", "POST");
      if (!r.ok && r.error === "NO_CLOUDFLARED") {
        toast("Chưa có cloudflared — bấm 'Tải cloudflared'", "err");
      }
    }
    if (!r.ok) toast(r.error || "Lỗi", "err");
  } catch (err) {
    toast("Lỗi: " + err.message, "err");
  }
  setBusy(false);
  refreshStatus(false);
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
  refreshStatus(false);
}

/* ---------------- env loading ---------------- */
async function loadEnv() {
  const r = await api("/api/env");
  const v = r.values;
  fillForm(v, v.OPENAI_TUNNEL_API_KEY || null);
  $("f-raw").value = r.raw || "";
  const cfg = await api("/api/config");
  $("f-connector").value = cfg.connectorName || "";
}

/* ---------------- misc ---------------- */
async function copyUrl() {
  const s = lastStatus;
  if (s && s.tunnel.url) {
    try {
      await navigator.clipboard.writeText(s.tunnel.url);
      toast("Đã sao chép URL: " + s.tunnel.url);
    } catch {
      toast(s.tunnel.url, "ok");
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
  $("btn-connector").addEventListener("click", async () => {
    try {
      await api("/api/open/connector", "POST");
    } catch {
      window.open("https://chatgpt.com/settings/connectors", "_blank");
    }
  });

  // folder picker: native dialog qua manager server (trả đường dẫn ĐẦY ĐỦ)
  $("btn-workspace-pick").addEventListener("click", async () => {
    const btn = $("btn-workspace-pick");
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

  // periodic refresh
  refreshStatus(true);
  setInterval(() => !busy && refreshStatus(false), 3000);

  Promise.all([loadEnv(), loadProfiles()]).then(() => refreshStatus(false));
}

document.addEventListener("DOMContentLoaded", init);
