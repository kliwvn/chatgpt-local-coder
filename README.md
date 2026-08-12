<div align="center">

# ChatGPT Local Coder

**Turn ChatGPT web into a local coding agent — files, shell, git, patches, 40+ MCP tools.**

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Developer%20Mode-10a37f?style=flat-square)](https://platform.openai.com/docs/guides/developer-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4?style=flat-square)](https://nodejs.org)

[Quick Start](#-quick-start) · [Connect ChatGPT](#-connect-chatgpt) · [Tools](#-tools) · [Tunnel](#-tunnel-options) · [Troubleshooting](#-troubleshooting) · [Tiếng Việt](#-tiếng-việt)

</div>

---

ChatGPT Local Coder is a **self-hosted MCP server** that turns ChatGPT into a coding agent on your machine — read and edit code, run `npm test`, manage git, apply unified diffs, and explore projects with `glob` / `grep`. Path-aware tools are scoped to your workspace roots by default (`FULL_DISK_ACCESS=false`).

No desktop app. No vendor lock-in. Run one Node process on your PC, expose it through a tunnel, and code from ChatGPT in the browser.

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     localhost     ┌─────────────────────┐
│   ChatGPT Web   │ ─────────────► │  Tunnel (opt.)   │ ────────────────► │  chatgpt-local-coder │
│ Developer Mode  │                │ OpenAI / CF      │      :3000/mcp    │  40+ MCP tools       │
└─────────────────┘                └──────────────────┘                   └──────────┬──────────┘
                                                                                    │
                                         ┌──────────────────────────────────────────┼──────────┐
                                         ▼                    ▼                    ▼          ▼
                                   Filesystem              Shell + Git         Background    Project
                                   read/write/patch        status/diff/commit   processes     context
```

## ✨ Why this project

| | ChatGPT alone | **+ ChatGPT Local Coder** |
|---|---|---|
| Edit your repo | ❌ | ✅ `apply_patch`, `edit_file`, `multi_edit` |
| Run tests / builds | ❌ | ✅ `run_command`, `start_process` |
| Git workflow | ❌ | ✅ `git_status`, `git_commit`, `git_push`, … |
| Explore codebase | Limited | ✅ `glob`, `grep`, `list_directory` |
| Path-aware disk access | — | ✅ Workspace roots only by default — `FULL_DISK_ACCESS=true` mở path-aware tools ra toàn máy |
| Multi-workspace | — | ✅ Manager dashboard, mỗi workspace 1 server + tunnel + connector |
| Session recovery | — | ✅ Auto-recover after server restart |

Built for **[ChatGPT Developer Mode](https://platform.openai.com/docs/guides/developer-mode)** with semantically audited, fixture-locked MCP tool annotations and **[OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)** support (stable URL, no connector re-wiring every restart). Local metadata describes real effects; it is not tuned to bypass ChatGPT host approval.

## 🚀 Quick Start

**Requirements:** [Node.js](https://nodejs.org) 22+, npm, Git (optional, for git tools)

```powershell
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
.\setup.bat          # TỰ ĐỘNG: cài Node deps + build + autostart + mở dashboard
```

> **`setup.bat` = một chạm duy nhất.** Kiểm tra Node 22+, tự `npm install` + `npm run build` nếu thiếu, cài autostart (Startup folder) để manager tự chạy khi đăng nhập, khởi động manager nếu chưa chạy, và **mở dashboard http://127.0.0.1:3300**. Chạy lại bất cứ lúc nào (idempotent — bỏ qua bước đã xong).

Cài thủ công từng bước:

```powershell
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env          # edit WORKSPACE_PATH
npm install
npm run build
.\manager.bat                   # manager dashboard (http://127.0.0.1:3300) — chạy server + tunnel + connector cho bạn
```

Muốn chạy thủ công (không dùng manager):

```powershell
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env          # edit WORKSPACE_PATH
npm install
npm run build
.\start.ps1
```

Server runs at `http://localhost:3000` — health check: `http://localhost:3000/health`

<details>
<summary><b>macOS / Linux</b></summary>

```bash
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
cp .env.example .env
npm install && npm run build
npm start
```

</details>

## 🖥️ Manager Dashboard

`manager.bat` mở **manager** tại `http://127.0.0.1:3300` — giao diện quản lý toàn bộ (Windows; chạy được trên mọi nền tảng bằng `node manager/server.mjs`):

| Tính năng | Mô tả |
|-----------|-------|
| **Multi-workspace** | Mỗi workspace = 1 MCP server (PORT riêng) + 1 tunnel + 1 connector ChatGPT riêng. Workspaces lưu trong `manager/instances/` |
| **Cài Đặt** | Kiểm tra Node/TS, `npm install` + `npm run build` một nút — đã cài thì báo "Trạng thái: Đã cài đặt OK" |
| **Cấu hình workspace** | `WORKSPACE_PATH` + folder picker (chọn thư mục bằng dialog Windows), đổi tên, xóa, profile |
| **Server / Tunnel** | Start/stop server; **Khởi động lại Gateway** thực hiện graceful restart, **đợi PID cũ thoát hoàn toàn** rồi mới start/xác nhận PID mới, trong khi giữ Tunnel đang chạy; lifecycle server/tunnel được serialize theo workspace để tránh overlap/double-spawn/race. Managed OpenAI Tunnel dùng log level `warn` để giữ lỗi/cảnh báo nhưng tránh INFO log tăng liên tục khi chạy dài ngày; Local Coder không quảng bá OAuth/PRMD khi không dùng OAuth. Với tunnel-client v0.0.10, no-auth discovery cần 404 có body JSON không phải PRMD để đi hết fallback candidates và giữ `/readyz` ở `200 ready`; binary hiện vẫn ghi đúng một WARN OAuth discovery lúc startup, WARN không lặp khi runtime ổn định |
| **Log viewer** | Xem log server thời gian thực (2.5s poll), lọc **Tất cả / Chỉ MCP**, pause, clear. "Chỉ MCP" gồm MCP/TOOL cùng `COMMAND FAILED` / `COMMAND NO MATCH` theo taxonomy mới; command/tool failure được highlight riêng khỏi transport error. Chi tiết tool/audit đầy đủ nằm trong audit file `.mcp-audit.log` |
| **Workspace sidebar** | Cột trái liệt kê từng workspace: tên + trạng thái server/tunnel, **WORKSPACE_PATH đầy đủ**, `EXTRA_WORKSPACE_PATHS` gộp trên **một dòng** và ngăn cách bằng `;` (ellipsis khi quá dài, hover xem đủ), `FULL_DISK_ACCESS`, **MCP port + Admin port + PID** |
| **Nút mở Cài Đặt Connector** | Mở thẳng `https://chatgpt.com/settings/connectors` từ card Tunnel |
| **Hướng dẫn sử dụng** | Modal 4 bước: cài đặt → cấu hình → tunnel → tag `@connector` trong chat |
| **Autostart ẩn hoàn toàn** | Tự chạy khi đăng nhập Windows qua Startup LNK → PowerShell hidden launcher `manager-hidden.ps1` → `manager.bat`/node chạy nền. Không phụ thuộc VBScript engine; khi bật lại autostart, Manager tự ghi lại LNK và dọn launcher VBS cũ nếu còn. Bật/tắt trong dashboard (API `/api/autostart`) hoặc `setup.bat` |

Manager và server chạy độc lập: manager quản lý, server xử lý MCP. Tắt manager không làm chết server đang chạy.

Managed instances giữ checkpoint/shell runtime state trong thư mục instance (`manager/instances/<name>/checkpoints` và `shell-state`) thay vì tạo `.mcp-checkpoints` / `.mcp-state` ở repo root. Instance `default` tự migrate legacy repo-root state khi khởi động nếu chưa có target và người dùng chưa cấu hình custom path; các giá trị legacy tương đương như `CHECKPOINT_PATH=.mcp-checkpoints` cũng được nhận diện, migrate và gỡ khỏi `.env` sau khi chuyển state thành công.

## 🔌 Connect ChatGPT

### 1. Enable Developer Mode

1. Open [ChatGPT](https://chatgpt.com) → **Settings** → **Apps & Connectors**
2. Under **Advanced**, enable **Developer mode**

### 2. Expose your server (pick one tunnel)

See [Tunnel options](#-tunnel-options) below. You need a **public HTTPS** URL pointing to `http://localhost:3000/mcp`.

### 3. Create a connector

1. **Settings** → **Connectors** → **Create**
2. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `Local Coder` |
| **Description** | `Local coding agent. First call agent_status + project_context. Use glob/grep to explore, apply_patch to edit, run_command for shell.` |
| **URL** | Your tunnel HTTPS URL (e.g. `https://…` or OpenAI Tunnel ID) |
| **Authentication** | None |

3. **Create** → verify tools appear in the list

### 4. Use in chat — **must tag the connector**

Every message that should use local tools **must include the connector**. If you skip this, ChatGPT only uses built-in tools, may show *"Looking for available tools"* / *"Đang tìm các công cụ có sẵn"*, then **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** — with **no error in server logs** (the MCP server was never called).

**How to tag (pick one):**

1. **Before sending:** **New chat** → **+** (tools) → **More** → enable **Local Coder** (connector stays on for that chat).
2. **In the message:** type **`@`** and choose **Local Coder** (or your connector name) so it appears as a pill/chip above the input.

Then send your prompt. You should see tool permission prompts or MCP activity — not a dead stream with no server log.

Example prompts (after tagging):

- *"Read package.json and explain the dependencies"*
- *"Run npm test and fix any failures"*
- *"Find all TODO comments with grep and summarize"*

> **Connector ABI rule:** restart/update implementation nội bộ **không cần Refresh** nếu `mcp_contract.version/hash` không đổi. Chỉ Refresh connector khi public contract version được chủ động bump; transport recovery riêng có thể cần reconnect nhưng không phải ABI migration.  
> **Avoid** clicking **"Always allow"** on permission popups — it can reset the MCP session. Configure permissions in **Settings → Apps** instead.

## 🌐 Tunnel options

### Option A — OpenAI Secure MCP Tunnel *(recommended)*

Stable tunnel ID — connector URL never changes.

```powershell
# Terminal 1
.\start.ps1 -Force

# Terminal 2 — first time only
.\openai-tunnel-init.bat    # enter tunnel_id + Runtime API key from OpenAI Platform

# Every time after
.\openai-tunnel.bat
```

Get credentials: [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)

In ChatGPT Connectors: **Connection type → Tunnel** → paste your `tunnel_…` ID.

### Option B — Cloudflare Quick Tunnel

Free, but URL changes on every restart (update connector each time).

```powershell
# Terminal 1
.\start.bat

# Terminal 2
.\tunnel.bat    # copy https://….trycloudflare.com into connector URL
```

Install cloudflared: `winget install Cloudflare.cloudflared`

## 🧰 Tools

**40+ tools** with structured JSON responses `{ ok, tool, summary, data }`.

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Permissions, workspace roots, audit log |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace edits |
| `multi_edit` | Multiple edits in one file |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` | Find files by pattern (sorted by mtime) |
| `grep` | Search content (content / files / count modes) |
| `list_directory` | List folder contents |
| `directory_tree` | Recursive tree as JSON |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Recoverable removal: move file/folder to Windows Recycle Bin; protected roots/aliases are refused |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run shell commands (`npm test`, builds, …); destructive delete / forced Git discard commands are blocked before spawn |
| `shell_status` / `shell_reset` | Persistent shell session |
| `start_process` | Long-running / background commands; uses the same destructive-command guard as `run_command` |
| `process_status` / `process_output` / `stop_process` | Manage background jobs |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore exact tracked file paths with an automatic checkpoint first |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and non-destructive reset (`soft` / `mixed`; hard reset is not exposed) |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| — | `apply_patch`, `git_*`, `project_context` |

## ⚙️ Configuration

Copy `.env.example` → `.env`:

```env
PORT=3000
MANAGER_PORT=3300
WORKSPACE_PATH=C:\Users\You\projects\my-app
SHELL_TIMEOUT=120
MCP_SESSION_TTL_MS=120000
MCP_SESSION_CLEANUP_MS=15000
MCP_SESSION_DELETE_GRACE_MS=45000
MCP_MAX_SESSIONS=64
FULL_DISK_ACCESS=false

# Workspace bổ sung (phân cách bằng ; trên Windows)
# EXTRA_WORKSPACE_PATHS=D:\Coding\other-repo

# Strict-process sandbox (FULL_DISK_ACCESS=false)
SANDBOX_NETWORK_MODE=none
# SANDBOX_ENV_ALLOWLIST=NODE_ENV;CI;MY_PROJECT_SETTING
# SANDBOX_EXEC_ROOTS=C:\Tools\custom-bin

# Checkpoint / rewind (Claude Code-style code undo)
CHECKPOINT_ENABLED=true
CHECKPOINT_MAX_FILE_BYTES=5242880

# Bounded audit/activity diagnostics
AUDIT_LOG_PATH=.mcp-audit.log
AUDIT_LOG_MAX_BYTES=10485760
ACTIVITY_LOG_MAX=500

# Bounded recent cross-session auto-memory
AUTO_MEMORY_MAX_BYTES=25000
AUTO_MEMORY_MAX_LINES=200

# OpenAI Secure Tunnel (optional)
OPENAI_TUNNEL_ID=
OPENAI_TUNNEL_API_KEY=
```

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | **required** | **Đúng 1 primary project root** (like `cd` before `claude`). Không được để trống và không chứa danh sách `;`; runtime không derive authority/context từ `process.cwd()`. Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions. Với `FULL_DISK_ACCESS=false`, root này còn là một phần hard workspace boundary; với `true`, nó vẫn là deterministic project/default-cwd context. |
| `EXTRA_WORKSPACE_PATHS` | — | Thêm workspace bổ sung (`;`-separated) — server được phép truy cập tất cả các root này |
| `WORKSPACE_PATHS` / `ALLOWED_WORKSPACE_PATHS` | — | **Obsolete/ignored.** Manager loại các key legacy này khỏi managed `.env`; chỉ `WORKSPACE_PATH` + `EXTRA_WORKSPACE_PATHS` là workspace authority/context SSoT. |
| `FULL_DISK_ACCESS` | `false` | Security mode. `false` = canonical workspace roots **và** arbitrary/project-controlled local process trees chạy trong Windows AppContainer; local stdio upstream bị block; sandbox unavailable/self-test fail → process execution fail closed. Fixed host mediators chỉ thực hiện operation đã định nghĩa (ví dụ Recycle Bin broker) và không nhận arbitrary command text. `true` = explicit trusted native OS-user/full-machine mode. |
| `SANDBOX_NETWORK_MODE` | `none` | Strict process network: `none` (default) hoặc `internet`; không silently grant loopback/LAN. |
| `SANDBOX_ENV_ALLOWLIST` | — | Env bổ sung (`;`-separated) cho sandbox. Secret-like names vẫn bị deny mặc định; HOME/TEMP/AppData dùng sandbox profile. |
| `SANDBOX_EXEC_ROOTS` | — | Toolchain roots bổ sung được cấp read/execute-only bằng `npm run setup:sandbox`; không writable. Node/npm/Git roots được auto-discover. Nếu danh sách approved RX roots đổi, runtime **fail closed** thay vì giữ ACL cũ; chạy lại `npm run setup:sandbox` để revoke grants cũ + grant roots mới rồi restart Local Coder. |
| `MCP_SESSION_TTL_MS` | `120000` | Xóa session **idle** sau 2 phút. Session đang SSE-connected hoặc đang chạy tool không bị evict; stale POST được auto-recover |
| `MCP_SESSION_CLEANUP_MS` | `15000` | Chu kỳ cleanup session idle (15 giây) |
| `MCP_SESSION_DELETE_GRACE_MS` | `45000` | **Fallback grace** cho transport close ngoài explicit DELETE. Explicit DELETE đã serialize sau các POST/tool call trước đó nên được dispose ngay khi op chain drain xong, tránh giữ session churn thêm 45s không cần thiết |
| `MCP_MAX_SESSIONS` | `64` | Hard cap session giữ trong RAM; evict session idle cũ nhất trước, không đụng session connected/in-flight |
| `SHELL_TIMEOUT` | `120` | Max seconds for `run_command` |
| `SHELL_OUTPUT_MAX_CHARS` | `250000` | Giới hạn tail stdout/stderr của `run_command` trong RAM; response báo `*_truncated` khi bị cắt |
| `GIT_OUTPUT_MAX_CHARS` | `500000` | Giới hạn output Git trong RAM; output bị cắt có marker rõ để agent không hiểu nhầm diff/log là đầy đủ |
| `READ_TEXT_MAX_BYTES` | `2097152` | Whole-file `read_text_file` tối đa 2 MiB. File lớn phải dùng `offset+limit`, `head` hoặc `tail`; partial reads cũng fail-fast nếu một slice/single line vượt budget |
| `EDIT_TEXT_MAX_BYTES` | `5242880` | Max source/result cho exact edit và patch text. Default 5 MiB khớp checkpoint file cap để edit mặc định vẫn rewindable; multi-file patch còn có aggregate preflight buffer cap |
| `READ_BASE64_MAX_BYTES` | `2097152` | Max binary chunk mỗi lần `read_file_base64`; dùng `offset/length` để đọc tiếp file lớn |
| `MCP_TOOL_RESULT_MAX_BYTES` | `7340032` | Global result wire budget ~7 MiB, giữ margin dưới giới hạn 10 MiB của OpenAI Secure MCP Tunnel; result quá lớn trả preview + metadata thay vì để tunnel 413 |
| `MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES` | `131072` | Chỉ duplicate payload đầy đủ sang cả MCP text + structured content khi payload nhỏ (≤128 KiB); payload lớn chỉ giữ một bản structured để giảm wire/context/GC |
| `PROCESS_MAX_RUNNING` | `16` | Hard cap background process do `start_process` quản lý; ngăn process/session churn spawn vô hạn |
| `PROCESS_HISTORY_MAX` | `32` | Số process đã kết thúc giữ trong RAM để xem status/output; process cũ tự prune |
| `PROCESS_LOG_MAX_CHARS` | `200000` | Max ký tự giữ **mỗi stdout/stderr stream** của một background process; buffer giữ tail mới nhất |
| `CHECKPOINT_ENABLED` / `CHECKPOINT_MAX_FILE_BYTES` | `true` / `5242880` | Checkpoint code trước khi sửa (rewind); file > 5MB bị skip |
| `CHECKPOINT_MAX_TOTAL_BYTES` / `CHECKPOINT_MAX_NODES` | `33554432` / `10000` | Bound aggregate snapshot RAM/traversal mỗi mutation. Directory subtree thiếu vì byte/node/file cap được đánh dấu `skipped` ở parent để rewind preview không báo restore giả |
| `PROJECT_MEMORY_MAX_BYTES` / `PROJECT_MEMORY_MAX_LINES` | `25000` / `200` | Giới hạn CLAUDE.md/AGENTS.md inject vào instructions. Đặt `0` = không giới hạn |
| `AUTO_MEMORY_MAX_BYTES` / `AUTO_MEMORY_MAX_LINES` | `25000` / `200` | Giới hạn recent cross-session auto-memory; `MEMORY.md` được compact atomic và ưu tiên note mới nhất thay vì tăng vô hạn |
| `AUDIT_LOG_PATH` | `.mcp-audit.log` | JSONL audit log. Với managed instance, path tương đối được resolve trong `manager/instances/<name>/` để không trộn log giữa workspace |
| `AUDIT_LOG_MAX_BYTES` | `10485760` | Giới hạn audit log hiện tại ~10MB; rotate sang `.1` trước khi append tiếp. Writer serialize concurrent appends, chỉ prepare/stat metadata một lần trên hot path và tự re-sync nếu thư mục log bị xóa khi process đang chạy |
| `ACTIVITY_LOG_MAX` | `500` | Số dòng activity giữ trong RAM cho feed admin (`/api/activity`) |
| `MANAGER_PORT` | `3300` | Cổng manager dashboard (manager/server.mjs) |
| `ADMIN_PORT` | `3001` | Admin GUI localhost-only (proxy qua manager) |
| `ADMIN_TOKEN` | — | Tùy chọn bảo vệ **Admin API**. Static `/ui/` vẫn chỉ localhost và tải được; khi API trả 401, UI hỏi token và chỉ giữ trong `sessionStorage` (scope theo instance khi qua Manager) + gửi `Authorization: Bearer`, không đưa token vào URL/localStorage. Activity Live dùng authenticated polling khi token được bật |

> **Hard workspace boundary mặc định trên Windows.** `FULL_DISK_ACCESS=false` → path tools canonicalize/reject escape và arbitrary/project-controlled local process (`run_command`, `start_process`, typed Git/Git descendants, post-edit hooks) phải chạy dưới Windows AppContainer; local stdio upstream bị block trước spawn. AppContainer chỉ nhận RW cho `WORKSPACE_PATH` + `EXTRA_WORKSPACE_PATHS`; approved toolchain roots là RX-only; HOME/TEMP/AppData và environment được sanitize. Junction/symlink tới target ngoài root vẫn bị OS deny. Nếu broker/ACL/helper-hash/self-test không đạt, process execution trả `OS_SANDBOX_*` và **không fallback native**. Lần đầu trên Windows chạy `npm run setup:sandbox` cho compatibility grants tối thiểu (NUL kernel object, traverse-only ancestry metadata, RX toolchain). Nếu approved RX roots đổi, chạy lại setup: script revoke SID grants cũ trước khi grant roots mới; runtime sẽ fail closed cho tới khi policy được reconcile.

> **Destructive filesystem safety:** `FULL_DISK_ACCESS=true` **không** tắt destructive guard. Slim profile luôn expose `delete_file` / `delete_directory` để removal hợp lệ đi qua recoverable Recycle Bin semantics; multi-file patch rollback, cross-volume move rollback và Manager Delete Instance cũng tránh permanent-delete user paths. `requireCommandAllowed()` và typed-Git guards tiếp tục là defense-in-depth cho thao tác nguy hiểm **bên trong root được cấp**. Với `FULL_DISK_ACCESS=false`, hard confidentiality/integrity boundary cho outside roots là AppContainer OS policy, không phải regex parser.

> **Về session initialize liên tục:** ChatGPT connector có thể tạo MCP transport session mới rất thường xuyên, thậm chí gần một session mỗi tool call. Đây **không phải** model conversation context và **không reset/xóa lịch sử chat, reasoning context hay chất lượng model trực tiếp**. Chi phí thật nằm ở transport handshake, object allocation/tool registration và state/lifecycle nếu server thiết kế sai. Local Coder giữ upstream MCP connections/cache dùng chung, tự recover stale session, và giới hạn retention bằng TTL + hard cap ở trên. Console/server log chỉ sample `openai-mcp` initialize theo **counter riêng của client ở mốc 25/50/75/...**, nên warm-up/tunnel/recovery không làm lệch nhịp 1/25; dòng sample giữ cả global `initialized=` và `clientInitialized=` để diagnostics mà không spam log. Shell state bootstrap từ disk **một lần mỗi process/workspace** thay vì mỗi transport. `run_command.working_directory` là one-off isolation boundary: command và `cd`/`Set-Location`/`pushd` bên trong chỉ tác động child invocation đó, không mutate hay ghi vào persistent default-shell cwd/history; chỉ call không truyền `working_directory` hoặc `shell_reset` mới dùng state mặc định. Stale-session recovery loopback có timeout nội bộ và chỉ drain tối đa một response prefix nhỏ trước khi cancel, nên wrong/local streaming endpoint không thể làm recovery giữ body trong RAM hoặc chờ stream vô hạn. Explicit DELETE chạy trong cùng per-session op chain với POST, nên phải chờ tool call trước đó hoàn tất rồi session được dispose ngay; `MCP_SESSION_DELETE_GRACE_MS` chỉ còn là fallback cho transport-close ngoài explicit DELETE. Các state bền vững khác (checkpoint index, auto-memory, `.env`/manager config) được serialize/ghi atomic và keyed queue tự giải phóng key sau khi settle. Initialize response vẫn mang đúng một MCP instruction document (không double-wrap). Vì vậy initialize churn hiện có thể tốn CPU/GC/I/O nhỏ, nhưng không làm mất model context; ảnh hưởng gián tiếp tới tool context đã được tách khỏi transport lifecycle.

> **Large tool output / tunnel 413:** OpenAI Secure MCP Tunnel có body limit khoảng 10 MiB. Local Coder giữ result budget mặc định ~7 MiB, không duplicate payload lớn giữa `content.text` và `structuredContent`, cap foreground shell/Git output, và yêu cầu chunk/range cho file lớn. Nếu một local hoặc proxied upstream tool vẫn tạo result vượt budget, server trả `truncated`, `original_payload_bytes`, preview và hint thay vì để request chết bằng HTTP 413. Điều này cũng giảm token/context pressure do log/diff/base64 quá lớn bị nhét lặp vào tool result.

> **Discovery/edit bounds:** `glob`/`grep`/`list_directory.ignore` dùng cùng glob matcher đã escape regex metacharacter, hỗ trợ root-level match, path glob và dotfiles/dot-directories (trừ `.git`/`node_modules`, không follow symlink); traversal dùng streaming directory handles thay vì materialize toàn bộ entry list. Regex do agent cung cấp cho `grep`, `search_files` và `replace_regex` chạy qua worker có timeout; catastrophic backtracking chỉ reset worker thay vì khóa Gateway event loop, còn literal/simple search giữ fast path. Exact edit/patch source và result được bounded bởi `EDIT_TEXT_MAX_BYTES`; multi-file patch còn giới hạn tổng original buffers giữ cho rollback/preflight.

> **Context-loader bounds:** `PROJECT_MEMORY_MAX_BYTES/LINES` được áp ngay từ lúc đọc `CLAUDE.md`/`AGENTS.md` và mở rộng `@import`, không đợi đọc nguyên file rồi mới cắt. Skill/rule/project-context discovery dùng streaming directory handles, không follow symlink, giới hạn số file và chỉ đọc prefix cần thiết; prefix truncation giữ biên UTF-8 hợp lệ để không inject ký tự thay thế `U+FFFD` vào instructions.

> **Post-edit hook bounds:** file cấu hình hooks bị giới hạn kích thước/số hook, glob dùng cùng matcher chuẩn với discovery, số hook execution mỗi mutation có hard cap, stdout/stderr được giữ bằng bounded tail. Hook timeout giết cả process tree trên Windows (SIGKILL trên POSIX) và chờ child close với bounded fallback để giảm orphan process sau formatter/linter bị treo.

> **Upstream MCP config bounds:** config/import/discovery MCP chỉ đọc tối đa 2 MiB, giới hạn số server/list/map/string và validate runtime type trước khi dùng. Mixed upstream MCP content (text + resource/image/etc.) được giữ cấu trúc thay vì bị ép thành chuỗi `[object Object]`.

> **State/Manager I/O bounds:** `.env`, Manager JSON/PID state, checkpoint index/manifest, audit history, upstream config và persisted shell state đều có read/write budget thay vì materialize file sửa tay/corrupt vô hạn. Manager helper processes (`netstat`, PowerShell/C# helpers, install/build) có timeout + bounded output; health responses và binary downloads được stream/bound. Tunnel client ZIP chỉ extract đúng một `tunnel-client.exe` với uncompressed-size cap, dùng temp file rồi commit để archive lỗi/duplicate/oversize không thay executable cũ.

> **Cross-agent shell isolation:** invocation có `working_directory` không còn đi vào default-shell history/cwd dù command chứa `cd`; `shell_status` chỉ phản ánh default shell, recent commands được secret-redact, và `shell_reset` clear cả cwd state lẫn history. Điều này ngăn nhiều agent/workspace dùng chung Gateway làm nhiễm shell context của nhau.

> **Foreground shell timeout:** stdout/stderr của `run_command` giữ bounded tail. Khi timeout, process tree bị terminate; caller ưu tiên chờ child `close` nhưng có bounded fallback, nên một OS/process edge không phát `close` cũng không thể giữ Promise của `run_command` vô hạn.

> **Command/error taxonomy:** `run_command` non-zero exit là **command-level outcome**, không phải MCP transport failure. Server log dùng `[COMMAND FAILED] ... exit=<code> cwd=<path>` cho test/build/script fail, `[COMMAND NO MATCH]` cho `git grep` exit `1` (Git định nghĩa là không có match), `[TOOL FAILED]` cho failure cấp tool/upstream, và chỉ dùng `[MCP ERROR]` cho protocol/transport/server request failure. Raw `exit_code` vẫn luôn được giữ trong tool result/audit record; no-match chỉ được normalize semantic thành `command_outcome=no_match` để agent không debug một kết quả tìm kiếm hợp lệ như lỗi hệ thống.

> **Background process lifecycle:** `start_process` dùng registry dùng chung giữa các MCP transport session. Registry giới hạn số process đang chạy, số process-history và log tail trong RAM. Khi Gateway graceful shutdown/restart, Local Coder dừng toàn bộ process tree do `start_process` tạo trước khi thoát để tránh orphan process sau restart.


## 🏗️ Architecture

```
src/
├── index.ts                 # Express + MCP session manager
├── server-factory.ts        # Tool registration
├── lib/
│   ├── mcp-session-manager.ts   # Session recovery, TTL
│   ├── patch.ts             # apply_patch engine
│   └── persistent-shell.ts  # Stateful shell
└── tools/
    ├── filesystem.ts        # 19 tools
    ├── shell.ts             # 8 tools
    ├── git.ts               # 12 tools
    └── context.ts           # agent_status, project_context
```

- **Transport:** MCP Streamable HTTP (`/mcp` and `/`)
- **Session:** Stateful with auto-recovery when ChatGPT holds a stale session ID
- **Output:** Structured JSON from every tool

### ChatGPT public MCP contract (ABI)

The ChatGPT host connector sees a **frozen, versioned ABI**, not the internal
tool set. The `slim` profile (default for ChatGPT) always exposes exactly
**27 tools** — exact names, order, titles, descriptions, input schemas and
annotations — locked by `scripts/fixtures/chatgpt-public-contract-v1.json`
(SHA-256 `afd98bd3…39e6`). Internal executor changes must not alter this ABI;
the server **fails closed at boot** with `MCP_PUBLIC_CONTRACT_DRIFT` if the live
registration drifts from the fixture (dev-only escape:
`CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE=1`).

- **Refresh the ChatGPT connector only when the contract version changes** —
  not after every internal implementation update.
- `agent_status` reports `mcp_contract` (version, hash, tool_count,
  dynamic_tools, list_changed) and `boot.boot_id`, and separates the local
  executor profile (`local_executor_profile`, `local_write_allowed`) from the
  host action gate (`host_action_permission: "unobservable"`), which the server
  cannot observe.
- `/health` exposes `boot_id` + `mcp_contract`; the manager `/api/health`
  exposes `mcp_public_contract` + its own `boot_id`.
- Changing the ABI is an explicit operation: bump
  `CHATGPT_PUBLIC_CONTRACT_VERSION`, run
  `npm run build && node scripts/generate-contract-fixture.mjs`, update test
  expectations, and commit the new fixture.

Regression coverage: `scripts/test-chatgpt-public-contract.mjs` (exact
inventory + hash + no listChanged in slim), `scripts/test-chatgpt-action-contract.mjs`
(critical action semantics), `scripts/test-chatgpt-legacy-compat.mjs`
(backward-compatible inputs), `scripts/test-chatgpt-diagnostics.mjs`
(fingerprint + drift guard).

## 🧪 Development

```powershell
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## 🔒 Security

**Security modes:** `FULL_DISK_ACCESS=false` là hard workspace mode trên Windows: canonical path checks bảo vệ path-aware APIs và Windows AppContainer bảo vệ arbitrary/project-controlled process trees. `run_command`, `start_process`, typed Git/Git descendants và post-edit hooks đều đi qua central ProcessExecutor; local stdio upstream bị block trước spawn; outside-root read/write bị OS deny, setup failure fail closed, và Job Object `KILL_ON_JOB_CLOSE` quản lý descendants. Fixed host mediators (AppContainer broker control, recoverable Recycle Bin operation, explicit setup helper) có operation/input hẹp và không phải arbitrary command execution. `FULL_DISK_ACCESS=true` là explicit trusted native mode với ordinary OS-user authority.

**Strict upstream policy:** local stdio upstream bị block trước spawn; loopback/private/link-local HTTP upstream bị block trước connect vì có thể là host-authority escape. Public `mcp_servers` / `mcp_tools` / `mcp_call` vẫn tồn tại để ABI không đổi. Remote public HTTP upstream là trust dimension riêng. `npm run setup:sandbox` chỉ làm one-time Windows compatibility setup; nó không chạy agent command elevated.

- Server chỉ nghe `127.0.0.1` — không phơi ra mạng nội bộ
- Manager + admin GUI localhost-only; CORS hẹp
- `.env` và secrets gitignored
- Audit log: `.mcp-audit.log` (optional, configurable). Managed instances resolve relative paths inside their own `manager/instances/<name>/` directory to avoid cross-workspace log mixing. Tool/activity/audit data is secret-redacted before logging, and the audit file is bounded/rotated by `AUDIT_LOG_MAX_BYTES` (default ~10MB).
- Manager identifies the expected Local Coder/tunnel process by health/command identity, not merely by an open port; wrong-process port conflicts are reported instead of being treated as "running".
- Chỉ expose qua tunnel bạn kiểm soát. Không share connector URL / tunnel API key
- Use on a trusted network / personal machine only

## 🩺 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** right after *"Looking for tools"* — **no server log** | You did **not tag the connector**. New chat → **+** → **More** → enable connector, or type **`@Local Coder`** in the message. Then retry. |
| **Resource not found** on tool call | Kiểm tra server/session và latest build trước. Chỉ Refresh connector nếu `mcp_contract.version` được chủ động thay đổi; same-ABI implementation restart không tự yêu cầu Refresh. |
| **Connection failed** | Check `.\start.ps1` + tunnel are both running. URL must be HTTPS. |
| **502 from tunnel during restart** | The tunnel can remain up while the local server is restarting; a brief 502 means `127.0.0.1:3000` was temporarily unavailable. Manager now drains MCP sessions with bounded graceful close before force fallback, reducing this window. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **`MCP write action is temporarily disabled`** | Xem `/health` → `mcpDispatch` (hoặc `agent_status.mcp_dispatch`). Nếu `MCP_REACHED.write_total` không tăng khi lỗi xảy ra thì host **không dispatch action tới Local Coder** (`HOST_NOT_INVOKED` chỉ được suy ra từ host-result + counter delta, server không thể tự log event này). So sánh connector snapshot với `mcp_contract.version/hash` và kiểm tra Action control/approval phía ChatGPT; chỉ Refresh nếu snapshot public ABI cần đổi. Nếu `MCP_REJECTED.write_total` tăng thì request đã tới Local Coder nhưng bị transport/session gate từ chối; xem `last_write_reason`/`reasons`. |
| **Tool blocked by client safety** | Không dùng shell/Git/tool khác để bypass một MCP action đang bị host chặn. Xác định layer bằng `mcpDispatch`; sửa host/session/contract state nếu request chưa tới server. |
| **`stream canceled`** in tunnel log | Server/tunnel restarted mid-session → refresh connector, new chat. |
| **Tunnel URL keeps changing** | Switch to OpenAI Secure Tunnel (`openai-tunnel.bat`). |
| **Access denied — "Path nằm ngoài workspace"** | Path sandbox mặc định (`FULL_DISK_ACCESS=false`). Mở rộng `EXTRA_WORKSPACE_PATHS` hoặc bật `FULL_DISK_ACCESS=true` trong `.env` instance, restart server trong manager. |
| **Không thấy manager / 3300** | Chạy `manager.bat` (hoặc `node manager/server.mjs`) — dashboard tại http://127.0.0.1:3300. Nếu đã có manager chạy, mở thẳng URL. |
| **git not found** | Install [Git](https://git-scm.com). |

See also [AGENTS.md](AGENTS.md) for agent onboarding and `apply_patch` format.

## 📚 References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ChatGPT Apps SDK](https://developers.openai.com/apps-sdk)
- [OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)

## 📄 License

[MIT](LICENSE) — use freely, attribution appreciated.

## ⭐ Support

If this saves you time, **star the repo** — it helps others find it.

---

## 🇻🇳 Tiếng Việt

**ChatGPT Local Coder** biến ChatGPT web thành agent code trên máy bạn qua MCP.
**Cách nhanh nhất:**
```powershell
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
.\setup.bat                    # MỘT CHẠM: cài deps + build + autostart + mở dashboard
```

Cài thủ công từng bước:
```powershell
git clone https://github.com/kliwvn/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env
npm install && npm run build
.\manager.bat                  # dashboard quản lý tại http://127.0.0.1:3300
```

Mở **http://127.0.0.1:3300**: manager tự cài đặt, cấu hình workspace (folder picker), start server + tunnel, nút mở **Cài Đặt Connector**, **log viewer** (lọc Chỉ MCP), nút **Hướng Dẫn Sử Dụng** — không cần chạy terminal tay.

**Path/process sandbox:** mặc định `FULL_DISK_ACCESS=false` — các tool có path argument chỉ đọc/ghi trong canonical `WORKSPACE_PATH` (+ `EXTRA_WORKSPACE_PATHS`) và chặn symlink/junction/patch escape; `run_command`, `start_process`, typed Git và project-controlled hooks chạy dưới Windows AppContainer với cùng workspace boundary. Local stdio upstream bị block thay vì native-spawn. Bật `FULL_DISK_ACCESS=true` chuyển sang explicit trusted native/full-machine mode nhưng **không tắt destructive-command guard**. `delete_file` / `delete_directory` dùng fixed Recycle Bin mediator trên local Windows drive và fail closed với protected root/alias/unsupported volume; mediator không nhận arbitrary shell command và không có fallback `Remove-Item -Recurse -Force`.

Chạy thủ công (không dùng manager):

```powershell
.\start.ps1                    # terminal 1
.\openai-tunnel.bat            # terminal 2 (tunnel cố định)
```

**ChatGPT:** Settings → Connectors → tạo connector → chọn tunnel → Refresh → chat mới.

**Bắt buộc tag connector mỗi chat:** Chat mới → **+** → **More** → bật connector, hoặc gõ **`@`** + tên connector trong ô chat. Nếu không tag, ChatGPT báo *"Đang tìm các công cụ có sẵn"* rồi *"Lỗi trong luồng tin nhắn"* — **server không có log lỗi** vì MCP chưa được gọi.

**WORKSPACE_PATH:** bắt buộc đặt đúng **một** thư mục project (không phải một parent chứa nhiều repo khi strict mode, và không ghép nhiều path bằng `;`). Project bổ sung đi vào `EXTRA_WORKSPACE_PATHS`. Server tự đọc `CLAUDE.md` / `AGENTS.md` giống Claude Code.

**Lưu ý:** Không bấm **"Luôn cho phép"** trên popup — cấu hình quyền ở Settings → Apps. Restart/internal update giữ cùng `mcp_contract.version/hash` thì không Refresh vì ABI; chỉ Refresh khi public contract version chủ động đổi. Reconnect transport/session nếu client thực tế yêu cầu là việc riêng.

Chi tiết cho AI agent: [AGENTS.md](AGENTS.md)