const ENV_KEYS = [
  "WORKSPACE_PATH",
  "EXTRA_WORKSPACE_PATHS",
  "PORT",
  "ADMIN_PORT",
  "CHATGPT_AUTO_APPROVE",
  "CHATGPT_TOOL_PROFILE",
  "SHELL_TIMEOUT",
  "MCP_SESSION_RECOVERY",
  "MCP_SESSION_TTL_MS",
  "MCP_SESSION_CLEANUP_MS",
  "MCP_SESSION_DELETE_GRACE_MS",
  "MCP_MAX_SESSIONS",
  "CHECKPOINT_ENABLED",
  "MCP_UPSTREAM_CONFIG",
  "POST_EDIT_HOOKS_CONFIG",
];

const TITLES = {
  dashboard: "Tổng quan",
  servers: "MCP Servers",
  import: "Import",
  activity: "Nhật ký",
  project: "Project context",
  settings: "Cài đặt",
  logs: "Raw status",
};

const SOURCE_LABELS = {
  cursor: "Cursor",
  claude: "Claude Code",
  opencode: "OpenCode",
};

let upstreamConfig = { servers: [] };
let editingServerId = null;
let activityPollTimer = null;
let activityPollInFlight = false;
let activityEventSource = null;
let activitySeenIds = new Set();
let activityPaused = false;
let dashboardRefreshInFlight = false;
let dashboardPollTimer = null;

// Khi admin UI được nhúng qua manager (http://127.0.0.1:<MANAGER_PORT>/admin/ui/),
// mọi request API tương đối phải đi qua /admin để manager proxy chuyển tiếp tới
// admin server thật của instance (proxy sẵn có strip tiền tố /admin).
// Khi mở trực tiếp (http://127.0.0.1:<ADMIN_PORT>/ui/), base rỗng.
const IS_PROXIED = location.pathname.startsWith("/admin/");
const API_BASE = IS_PROXIED ? "/admin" : "";
// Trong chế độ proxy, giữ instance hiện tại trên mọi URL API (manager proxy
// chọn instance theo query ?instance=... khi không có header x-instance-name).
const API_INSTANCE = new URLSearchParams(location.search).get("instance") || "";
const apiUrl = (path) => {
  let url = API_BASE + path;
  if (IS_PROXIED && API_INSTANCE) {
    url += (url.includes("?") ? "&" : "?") + `instance=${encodeURIComponent(API_INSTANCE)}`;
  }
  return url;
};

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}
async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function badge(health) {
  if (health === "connected") return '<span class="badge ok">connected</span>';
  if (health === "disabled") return '<span class="badge off">disabled</span>';
  return `<span class="badge bad">${health || "unknown"}</span>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serversTable(rows, { actions = true } = {}) {
  if (!rows.length) return '<div class="empty">Chưa có upstream server. Thêm mới hoặc Import.</div>';
  const head = `<table><thead><tr>
    <th>Server</th><th>Transport</th><th>Status</th><th>Expose</th><th>Tools</th>
    ${actions ? "<th></th>" : ""}
  </tr></thead><tbody>`;
  const body = rows
    .map((s) => {
      const actionsCell = actions
        ? `<td><div class="btn-group">
            <button class="btn sm ghost" data-action="test" data-id="${esc(s.id)}">Test</button>
            <button class="btn sm ghost" data-action="tools" data-id="${esc(s.id)}">Tools</button>
            <button class="btn sm ghost" data-action="edit" data-id="${esc(s.id)}">Sửa</button>
            <button class="btn sm ghost" data-action="delete" data-id="${esc(s.id)}">Xóa</button>
          </div></td>`
        : "";
      return `<tr>
        <td><strong>${esc(s.name)}</strong><div class="muted" style="font-size:0.72rem;font-family:var(--mono)">${esc(s.id)}</div></td>
        <td>${esc(s.transport)}</td>
        <td>${badge(s.health)}</td>
        <td>${esc(s.expose)}</td>
        <td>${s.tool_count ?? 0} <span class="muted">/ ${s.proxied_tools?.length ?? 0} proxy</span></td>
        ${actionsCell}
      </tr>`;
    })
    .join("");
  return head + body + "</tbody></table>";
}

async function loadDashboard() {
  const health = await api("/health");
  const connected = health.connected_sessions ?? 0;
  const sessionPolicy = health.session_policy || {};
  const sessionMax = sessionPolicy.max_retained ?? "—";
  const idleTtlMs = Number(sessionPolicy.idle_ttl_ms || 0);
  const cleanupMs = Number(sessionPolicy.cleanup_interval_ms || 0);
  const idleTtlLabel = idleTtlMs >= 60000 ? `${Math.round(idleTtlMs / 60000)}m` : `${Math.round(idleTtlMs / 1000)}s`;
  const cleanupLabel = cleanupMs >= 60000 ? `${Math.round(cleanupMs / 60000)}m` : `${Math.round(cleanupMs / 1000)}s`;
  document.getElementById("conn-status").textContent =
    `MCP :${health.mcp_port} · ${health.active_sessions} sessions · ${connected} đang kết nối`;
  const instr = health.instructions || {};
  const memCount = instr.memory_files?.length ?? 0;
  const gitBranch = instr.git?.branch || (instr.git?.is_repo === false ? "—" : "?");
  document.getElementById("stat-grid").innerHTML = `
    <div class="stat"><div class="stat-label">MCP Port</div><div class="stat-value">${health.mcp_port}</div></div>
    <div class="stat"><div class="stat-label">Sessions (đã đăng ký)</div><div class="stat-value">${health.active_sessions}</div></div>
    <div class="stat"><div class="stat-label">Đang kết nối (SSE)</div><div class="stat-value">${connected}</div></div>
    <div class="stat"><div class="stat-label">Session retention</div><div class="stat-value">${health.active_sessions}/${sessionMax}</div>
      <div class="stat-sub">idle TTL ${idleTtlLabel} · cleanup ${cleanupLabel}</div></div>
    <div class="stat"><div class="stat-label">Project memory</div><div class="stat-value">${memCount} file(s)</div>
      <div class="stat-sub">${instr.instruction_bytes ? Math.round(instr.instruction_bytes / 1024) + " KB instructions" : ""}</div></div>
    <div class="stat"><div class="stat-label">Git branch</div><div class="stat-value" style="font-size:0.85rem">${esc(gitBranch)}</div></div>
    <div class="stat"><div class="stat-label">Workspace</div><div class="stat-value" style="font-size:0.85rem">${esc(health.default_cwd?.split(/[/\\]/).pop())}</div>
      <div class="stat-sub">${esc(health.default_cwd)}</div></div>`;
  document.getElementById("dash-servers").innerHTML = serversTable(health.upstream || [], { actions: false });
  renderSessions(health.sessions || []);
  document.getElementById("status-json").textContent = JSON.stringify(health, null, 2);
}

function renderSessions(sessions) {
  const el = document.getElementById("dash-sessions");
  if (!sessions.length) {
    el.innerHTML = '<div class="empty">Chưa có phiên nào được đăng ký.</div>';
    return;
  }
  const rows = sessions
    .map((s) => {
      let statusBadge;
      if (s.connected) statusBadge = '<span class="badge ok">đang kết nối</span>';
      else if (s.status === "closing") statusBadge = '<span class="badge bad">closing</span>';
      else statusBadge = '<span class="badge">registered</span>';
      return `<tr>
        <td>${s.index}</td>
        <td><code>${esc(s.shortId)}</code></td>
        <td>${statusBadge}</td>
        <td>${s.ageSeconds}s</td>
        <td>${s.idleSeconds}s</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `<table><thead><tr>
    <th>#</th><th>Session (rút gọn)</th><th>Trạng thái</th><th>Tuổi</th><th>Idle</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}


async function loadProject() {
  const preview = await api("/api/instructions/preview");
  const s = preview.summary || {};
  document.getElementById("project-meta").innerHTML = `
    <div class="stat"><div class="stat-label">Root</div><div class="stat-value" style="font-size:0.8rem">${esc(s.root || "—")}</div></div>
    <div class="stat"><div class="stat-label">Memory files</div><div class="stat-value">${s.memory_files?.length ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Instructions</div><div class="stat-value">${preview.total_chars ? Math.round(preview.total_chars / 1024) + " KB" : "—"}</div></div>
    <div class="stat"><div class="stat-label">Tool profile</div><div class="stat-value">${esc(s.tool_profile || "slim")}</div></div>
    <div class="stat"><div class="stat-label">Git</div><div class="stat-value">${esc(s.git?.branch || "—")}</div></div>`;
  document.getElementById("project-preview").textContent =
    preview.preview + (preview.truncated ? "\n\n… (truncated)" : "");
}

async function loadServers() {
  const health = await api("/health");
  const cfg = await api("/api/upstream");
  upstreamConfig = cfg.config;
  const el = document.getElementById("servers-table");
  el.innerHTML = serversTable(health.upstream || []);
  bindServerActions(el, cfg.config);
}

function bindServerActions(container, config) {
  container.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === "test") {
          const r = await api(`/api/upstream/${id}/test`, { method: "POST" });
          toast(r.ok ? `OK — ${r.status.tool_count} tools` : r.status.last_error || "Failed", !r.ok);
          await loadServers();
        } else if (action === "tools") {
          const r = await api(`/api/upstream/${id}/tools`);
          const list = document.getElementById("tools-list");
          list.innerHTML = r.tools.length
            ? r.tools.map((t) => `<div class="tool-row"><div class="name">${esc(t.name)}</div><div class="desc">${esc(t.description || "")}</div></div>`).join("")
            : '<div class="muted">Không có tools</div>';
          document.getElementById("tools-dialog").showModal();
        } else if (action === "edit") {
          openServerDialog(config.servers.find((x) => x.id === id));
        } else if (action === "delete") {
          if (!confirm(`Xóa server "${id}"?`)) return;
          await api(`/api/upstream/${id}`, { method: "DELETE" });
          toast("Đã xóa");
          await loadServers();
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function loadImport() {
  const { sources } = await api("/api/import/sources");
  const grid = document.getElementById("import-grid");
  if (!sources.length) {
    grid.innerHTML = '<div class="empty">Không tìm thấy config MCP trên máy.</div>';
    return;
  }
  grid.innerHTML = sources
    .map(
      (s) => `<div class="import-card">
        <h3>${esc(SOURCE_LABELS[s.source] || s.source)}</h3>
        <div class="path">${esc(s.path)}</div>
        <div class="meta">${s.server_count} server(s)</div>
        <button class="btn primary sm" data-import="${esc(s.source)}" data-path="${esc(s.path)}">Import</button>
      </div>`
    )
    .join("");
  grid.querySelectorAll("[data-import]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const r = await api(`/api/import/${btn.dataset.import}`, {
          method: "POST",
          body: JSON.stringify({ path: btn.dataset.path, merge: true }),
        });
        toast(`Import OK: ${r.imported.join(", ") || "(không mới)"}`);
        await refreshAll();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function activityKindBadge(kind) {
  const labels = { mcp: "MCP", tool: "TOOL", session: "SESSION", system: "SYS" };
  return `<span class="badge kind-${kind}">${labels[kind] || kind}</span>`;
}

function activityStatusBadge(status) {
  if (!status) return "";
  if (status === "ok") return '<span class="badge ok">ok</span>';
  if (status === "error" || status === "blocked") return `<span class="badge bad">${esc(status)}</span>`;
  return `<span class="badge">${esc(status)}</span>`;
}

function renderActivityRow(entry) {
  const tool = entry.tool || entry.action || "—";
  const summary = entry.summary || entry.target || "";
  const dur = entry.duration_ms != null ? `${entry.duration_ms}ms` : "";
  const sid = entry.session_id ? entry.session_id.slice(0, 8) : "";
  const details = entry.details ? JSON.stringify(entry.details, null, 2) : "";
  return `<div class="activity-row" data-id="${esc(entry.id)}">
    <div class="activity-main">
      <span class="activity-time">${formatTime(entry.time)}</span>
      ${activityKindBadge(entry.kind)}
      <span class="activity-tool">${esc(tool)}</span>
      ${activityStatusBadge(entry.status)}
      ${dur ? `<span class="activity-dur">${dur}</span>` : ""}
      ${sid ? `<span class="activity-sid" title="${esc(entry.session_id)}">${esc(sid)}</span>` : ""}
    </div>
    ${summary ? `<div class="activity-summary">${esc(summary)}</div>` : ""}
    ${details ? `<pre class="activity-details hidden">${esc(details)}</pre>` : ""}
  </div>`;
}

function bindActivityRows(container) {
  container.querySelectorAll(".activity-row").forEach((row) => {
    const details = row.querySelector(".activity-details");
    if (!details) return;
    row.addEventListener("click", () => details.classList.toggle("hidden"));
  });
}

function mergeActivityEntries(entries, { prepend = false } = {}) {
  const feed = document.getElementById("activity-feed");
  const empty = feed.querySelector(".empty");
  if (empty) empty.remove();

  const fresh = entries.filter((e) => !activitySeenIds.has(e.id));
  if (!fresh.length) return;

  for (const e of fresh) activitySeenIds.add(e.id);
  const html = fresh.map(renderActivityRow).join("");

  if (prepend) {
    feed.insertAdjacentHTML("afterbegin", html);
    bindActivityRows(feed);
    while (feed.children.length > 300) feed.lastElementChild?.remove();
    return;
  }

  feed.innerHTML = html + feed.innerHTML;
  bindActivityRows(feed);
  while (feed.children.length > 300) feed.lastElementChild?.remove();
}

async function loadActivity({ reset = false } = {}) {
  if (activityPaused && !reset) return;
  const kind = document.getElementById("activity-kind").value;
  const status = document.getElementById("activity-status").value;
  const q = document.getElementById("activity-search").value.trim();
  const params = new URLSearchParams({ limit: "120" });
  if (kind !== "all") params.set("kind", kind);
  if (status === "error") params.set("status", "error");
  if (q) params.set("q", q);

  const { entries } = await api(`/api/activity?${params}`);
  if (reset) {
    activitySeenIds.clear();
    const feed = document.getElementById("activity-feed");
    feed.innerHTML = entries.length
      ? entries.map(renderActivityRow).join("")
      : '<div class="empty">Không có log khớp bộ lọc.</div>';
    activitySeenIds = new Set(entries.map((e) => e.id));
    bindActivityRows(feed);
    return;
  }
  mergeActivityEntries(entries, { prepend: true });
}

function stopActivityStream() {
  if (activityPollTimer) {
    clearInterval(activityPollTimer);
    activityPollTimer = null;
  }
  if (activityEventSource) {
    activityEventSource.close();
    activityEventSource = null;
  }
}

async function pollActivityQuietly() {
  if (activityPollInFlight || document.visibilityState !== "visible" || activityPaused) return;
  activityPollInFlight = true;
  try {
    await loadActivity();
  } catch {
    // SSE fallback is best-effort; manual/filter refresh still surfaces errors.
  } finally {
    activityPollInFlight = false;
  }
}

function startActivityStream() {
  stopActivityStream();
  const live = document.getElementById("activity-live").checked;
  if (!live || activityPaused) return;

  activityEventSource = new EventSource(apiUrl("/api/activity/stream"));
  activityEventSource.onmessage = (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      const kind = document.getElementById("activity-kind").value;
      const status = document.getElementById("activity-status").value;
      const q = document.getElementById("activity-search").value.trim().toLowerCase();
      if (kind !== "all" && entry.kind !== kind) return;
      if (status === "error" && entry.status !== "error" && entry.status !== "blocked") return;
      if (q) {
        const hay = [entry.tool, entry.action, entry.target, entry.summary].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return;
      }
      mergeActivityEntries([entry], { prepend: true });
    } catch {}
  };
  activityEventSource.onerror = () => {
    activityEventSource?.close();
    activityEventSource = null;
    if (!activityPollTimer) {
      activityPollTimer = setInterval(pollActivityQuietly, 2000);
    }
  };
}

function onActivityTabActive() {
  loadActivity({ reset: true }).catch((e) => toast(e.message, true));
  startActivityStream();
}

async function loadEnvForm() {
  const data = await api("/api/config/env");
  const form = document.getElementById("env-form");
  form.innerHTML = "";
  const values = data.values || {};
  for (const key of ENV_KEYS) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${key}</span>`;
    const input = document.createElement("input");
    input.name = key;
    input.value = values[key] ?? "";
    label.appendChild(input);
    form.appendChild(label);
  }
}

const dialog = document.getElementById("server-dialog");
const serverForm = document.getElementById("server-form");

function transportFields(form) {
  const t = form.transport.value;
  form.querySelectorAll(".stdio-field").forEach((el) => el.classList.toggle("hidden", t !== "stdio"));
  form.querySelectorAll(".http-field").forEach((el) => el.classList.toggle("hidden", t !== "http"));
  document.getElementById("tool-picker").classList.toggle("hidden", form.expose.value !== "allowlist");
}

serverForm.transport.addEventListener("change", () => transportFields(serverForm));
serverForm.expose.addEventListener("change", () => transportFields(serverForm));

function openServerDialog(server) {
  editingServerId = server?.id ?? null;
  serverForm.reset();
  document.getElementById("dialog-title").textContent = server ? "Sửa MCP Server" : "Thêm MCP Server";
  document.getElementById("tool-chips").innerHTML = "";
  if (server) {
    serverForm.id.value = server.id;
    serverForm.id.readOnly = true;
    serverForm.name.value = server.name || "";
    serverForm.enabled.checked = server.enabled !== false;
    serverForm.transport.value = server.transport;
    serverForm.command.value = server.command || "";
    serverForm.args.value = JSON.stringify(server.args || []);
    serverForm.cwd.value = server.cwd || "";
    serverForm.url.value = server.url || "";
    serverForm.headers.value = JSON.stringify(server.headers || {});
    serverForm.tool_prefix.value = server.tool_prefix || server.id;
    serverForm.expose.value = server.expose || "meta_only";
    serverForm.tools.value = (server.tools || []).join(", ");
    serverForm.idle_timeout_sec.value = server.idle_timeout_sec ?? 600;
  } else {
    serverForm.id.readOnly = false;
  }
  transportFields(serverForm);
  dialog.showModal();
}

document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
document.getElementById("close-tools").addEventListener("click", () => document.getElementById("tools-dialog").close());

document.getElementById("fetch-tools").addEventListener("click", async () => {
  const id = serverForm.id.value.trim();
  if (!id) return toast("Nhập ID trước", true);
  try {
    const r = await api(`/api/upstream/${id}/tools`);
    const selected = new Set(serverForm.tools.value.split(",").map((s) => s.trim()).filter(Boolean));
    const chips = document.getElementById("tool-chips");
    chips.innerHTML = r.tools
      .map((t) => {
        const on = selected.has(t.name) ? " on" : "";
        return `<span class="chip${on}" data-tool="${esc(t.name)}">${esc(t.name)}</span>`;
      })
      .join("");
    chips.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        chip.classList.toggle("on");
        const names = [...chips.querySelectorAll(".chip.on")].map((c) => c.dataset.tool);
        serverForm.tools.value = names.join(", ");
      });
    });
    toast(`${r.tools.length} tools`);
  } catch (err) {
    toast(err.message, true);
  }
});

serverForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let args = [];
  let headers = {};
  try {
    args = serverForm.args.value.trim() ? JSON.parse(serverForm.args.value) : [];
  } catch {
    return toast("Args phải là JSON array hợp lệ", true);
  }
  if (!Array.isArray(args)) return toast("Args phải là JSON array", true);
  try {
    headers = serverForm.headers.value.trim() ? JSON.parse(serverForm.headers.value) : {};
  } catch {
    return toast("HTTP headers phải là JSON object hợp lệ", true);
  }
  if (!headers || Array.isArray(headers) || typeof headers !== "object") {
    return toast("HTTP headers phải là JSON object", true);
  }
  if (Object.values(headers).some((value) => typeof value !== "string")) {
    return toast("Mọi HTTP header value phải là string", true);
  }
  const server = {
    id: serverForm.id.value.trim(),
    name: serverForm.name.value.trim() || serverForm.id.value.trim(),
    enabled: serverForm.enabled.checked,
    transport: serverForm.transport.value,
    command: serverForm.command.value.trim() || undefined,
    args,
    cwd: serverForm.cwd.value.trim() || undefined,
    url: serverForm.url.value.trim() || undefined,
    headers,
    tool_prefix: serverForm.tool_prefix.value.trim() || undefined,
    expose: serverForm.expose.value,
    tools: serverForm.tools.value.split(",").map((s) => s.trim()).filter(Boolean),
    idle_timeout_sec: Number(serverForm.idle_timeout_sec.value) || 600,
  };
  try {
    await api("/api/upstream", { method: "POST", body: JSON.stringify({ server }) });
    dialog.close();
    toast("Đã lưu");
    await loadServers();
  } catch (err) {
    toast(err.message, true);
  }
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    document.getElementById("page-title").textContent = TITLES[btn.dataset.tab] || btn.dataset.tab;
    stopActivityStream();
    if (btn.dataset.tab === "activity") onActivityTabActive();
    if (btn.dataset.tab === "project") loadProject().catch((e) => toast(e.message, true));
  });
});

document.getElementById("activity-kind").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-status").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-search").addEventListener("input", () => {
  clearTimeout(activitySearchDebounce);
  activitySearchDebounce = setTimeout(() => loadActivity({ reset: true }).catch(() => {}), 350);
});
let activitySearchDebounce;
document.getElementById("activity-live").addEventListener("change", () => {
  activityPaused = false;
  if (document.getElementById("activity-live").checked) startActivityStream();
  else stopActivityStream();
});
document.getElementById("activity-clear").addEventListener("click", () => {
  // Keep the source checkpoint. If SSE falls back to polling after Clear,
  // historical entries must not reappear; only unseen future IDs are appended.
  document.getElementById("activity-feed").innerHTML =
    '<div class="empty">Đã xóa hiển thị. Log mới vẫn sẽ xuất hiện khi Live bật.</div>';
});

document.getElementById("add-server").addEventListener("click", () => openServerDialog(null));
document.getElementById("save-env").addEventListener("click", async () => {
  const values = {};
  document.querySelectorAll("#env-form input").forEach((el) => (values[el.name] = el.value));
  try {
    await api("/api/config/env", { method: "PUT", body: JSON.stringify({ values }) });
    toast("Đã lưu .env — restart server để áp dụng thay đổi runtime");
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById("import-file-btn").addEventListener("click", async () => {
  const filePath = document.getElementById("import-file-path").value.trim();
  const source = document.getElementById("import-file-source").value;
  if (!filePath) return toast("Nhập đường dẫn file", true);
  try {
    const r = await api("/api/import/file", {
      method: "POST",
      body: JSON.stringify({ path: filePath, detect_as: source, merge: true }),
    });
    toast(`Import OK: ${r.imported.join(", ") || "(không mới)"}`);
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

async function refreshAll() {
  await Promise.all([loadDashboard(), loadServers(), loadImport(), loadEnvForm(), loadProject().catch(() => {})]);
}

async function refreshDashboardQuietly() {
  if (document.visibilityState !== "visible" || dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  try {
    await loadDashboard();
  } catch {
    // The connector/server may be restarting. Manual refresh still surfaces
    // errors; background polling stays silent and retries next interval.
  } finally {
    dashboardRefreshInFlight = false;
  }
}

document.getElementById("refresh-all").addEventListener("click", () => refreshAll().catch((e) => toast(e.message, true)));
document.getElementById("sessions-refresh").addEventListener("click", () =>
  loadDashboard().catch((e) => toast(e.message, true))
);

refreshAll().catch((err) => toast(err.message, true));
dashboardPollTimer = setInterval(refreshDashboardQuietly, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshDashboardQuietly();
});
window.addEventListener("beforeunload", () => clearInterval(dashboardPollTimer));