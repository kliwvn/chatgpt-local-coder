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

Built for **[ChatGPT Developer Mode](https://platform.openai.com/docs/guides/developer-mode)** with optimized tool annotations (fewer permission popups) and **[OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)** support (stable URL, no connector re-wiring every restart).

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
| **Focus Server / Tunnel** | Start/stop server; **Khởi động lại Gateway** thực hiện graceful restart, **đợi PID cũ thoát hoàn toàn** rồi mới start/xác nhận PID mới, trong khi giữ Tunnel đang chạy; lifecycle server/tunnel được serialize theo workspace để tránh overlap/double-spawn/race |
| **Log viewer** | Xem log server thời gian thực (2.5s poll), lọc **Tất cả / Chỉ MCP**, pause, clear. "Tất cả" = toàn bộ server.log (MCP + TOOL + lỗi); chi tiết tool/audit đầy đủ nằm trong audit file `.mcp-audit.log` |
| **Workspace sidebar** | Cột trái liệt kê từng workspace: tên + trạng thái server/tunnel, **WORKSPACE_PATH đầy đủ**, từng `EXTRA_WORKSPACE_PATHS` trên dòng riêng (không rút gọn/ellipsis), `FULL_DISK_ACCESS`, port + PID |
| **Nút mở Cài Đặt Connector** | Mở thẳng `https://chatgpt.com/settings/connectors` từ card Focus Tunnel |
| **Hướng dẫn sử dụng** | Modal 4 bước: cài đặt → cấu hình → tunnel → tag `@connector` trong chat |
| **Autostart ẩn hoàn toàn** | Tự chạy khi đăng nhập Windows qua Startup LNK → `wscript manager-hidden.vbs` → node chạy nền, **không hiện cửa sổ terminal/popup** nào. Bật/tắt trong dashboard (API `/api/autostart`) hoặc `setup.bat` |

Manager và server chạy độc lập: manager quản lý, server xử lý MCP. Tắt manager không làm chết server đang chạy.

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

> **Tip:** After server updates or restarts → **Refresh** the connector and start a **new chat** (re-tag the connector).  
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
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run shell commands (`npm test`, builds, …) |
| `shell_status` / `shell_reset` | Persistent shell session |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` / `stop_process` | Manage background jobs |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

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
CHATGPT_AUTO_APPROVE=true
SHELL_TIMEOUT=120
MCP_SESSION_RECOVERY=true
MCP_SESSION_TTL_MS=120000
MCP_SESSION_CLEANUP_MS=15000
MCP_SESSION_DELETE_GRACE_MS=45000
MCP_MAX_SESSIONS=64
FULL_DISK_ACCESS=false

# Workspace bổ sung (phân cách bằng ; trên Windows)
# EXTRA_WORKSPACE_PATHS=D:\Coding\other-repo

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
| `WORKSPACE_PATH` | `cwd` | **Your project root** (like `cd` before `claude`). Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions |
| `EXTRA_WORKSPACE_PATHS` | — | Thêm workspace bổ sung (`;`-separated) — server được phép truy cập tất cả các root này |
| `WORKSPACE_PATHS` / `ALLOWED_WORKSPACE_PATHS` | — | Aliases của `EXTRA_WORKSPACE_PATHS` (đọc thêm nếu có) |
| `FULL_DISK_ACCESS` | `false` | Scope cho **path-aware filesystem/git/config tools**. `false` = chỉ path canonical trong `WORKSPACE_PATH` (+ `EXTRA_WORKSPACE_PATHS`); `true` = cho phép path toàn máy. Không phải OS sandbox cho native shell |
| `CHATGPT_AUTO_APPROVE` | `true` | Tool annotations to reduce ChatGPT popups |
| `MCP_SESSION_RECOVERY` | `true` | Auto-recover stale sessions after restart |
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
| `AUDIT_LOG_MAX_BYTES` | `10485760` | Giới hạn audit log hiện tại ~10MB; rotate sang `.1` trước khi append tiếp |
| `ACTIVITY_LOG_MAX` | `500` | Số dòng activity giữ trong RAM cho feed admin (`/api/activity`) |
| `MANAGER_PORT` | `3300` | Cổng manager dashboard (manager/server.mjs) |
| `ADMIN_PORT` | `3001` | Admin GUI localhost-only (proxy qua manager) |
| `ADMIN_TOKEN` | — | Tùy chọn bảo vệ **Admin API**. Static `/ui/` vẫn chỉ localhost và tải được; khi API trả 401, UI hỏi token và chỉ giữ trong `sessionStorage` (scope theo instance khi qua Manager) + gửi `Authorization: Bearer`, không đưa token vào URL/localStorage. Activity Live dùng authenticated polling khi token được bật |

> **Path sandbox fail-closed mặc định.** `FULL_DISK_ACCESS=false` → các tool có path argument canonicalize path thật (`realpath`/nearest existing ancestor) rồi chặn `..\..`, symlink/junction và multi-file patch escape ra ngoài workspace roots. Recursive `glob`/`grep`/search không follow symlink entries. Project-controlled `CLAUDE.md`/rules imports cũng không được vượt workspace roots. **`run_command` / `start_process` là native shell và không được OS-sandbox bởi setting này**; chỉ working directory của chúng được kiểm tra. Chỉ chạy connector trên máy/code bạn tin cậy.

> **Về session initialize liên tục:** ChatGPT connector có thể tạo MCP transport session mới rất thường xuyên, thậm chí gần một session mỗi tool call. Đây **không phải** model conversation context và **không reset/xóa lịch sử chat, reasoning context hay chất lượng model trực tiếp**. Chi phí thật nằm ở transport handshake, object allocation/tool registration và state/lifecycle nếu server thiết kế sai. Local Coder giữ upstream MCP connections/cache dùng chung, tự recover stale session, và giới hạn retention bằng TTL + hard cap ở trên. Shell state bootstrap từ disk **một lần mỗi process/workspace** thay vì mỗi transport. `run_command.working_directory` là one-off isolation boundary: command và `cd`/`Set-Location`/`pushd` bên trong chỉ tác động child invocation đó, không mutate hay ghi vào persistent default-shell cwd/history; chỉ call không truyền `working_directory` hoặc `shell_reset` mới dùng state mặc định. Stale-session recovery loopback có timeout nội bộ và chỉ drain tối đa một response prefix nhỏ trước khi cancel, nên wrong/local streaming endpoint không thể làm recovery giữ body trong RAM hoặc chờ stream vô hạn. Explicit DELETE chạy trong cùng per-session op chain với POST, nên phải chờ tool call trước đó hoàn tất rồi session được dispose ngay; `MCP_SESSION_DELETE_GRACE_MS` chỉ còn là fallback cho transport-close ngoài explicit DELETE. Các state bền vững khác (checkpoint index, auto-memory, `.env`/manager config) được serialize/ghi atomic và keyed queue tự giải phóng key sau khi settle. Initialize response vẫn mang đúng một MCP instruction document (không double-wrap). Vì vậy initialize churn hiện có thể tốn CPU/GC/I/O nhỏ, nhưng không làm mất model context; ảnh hưởng gián tiếp tới tool context đã được tách khỏi transport lifecycle.

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

## 🧪 Development

```powershell
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## 🔒 Security

**Path sandbox fail-closed mặc định:** `FULL_DISK_ACCESS=false` giới hạn các path-aware filesystem/git/config operations trong `WORKSPACE_PATH` + `EXTRA_WORKSPACE_PATHS`, với canonical-path checks chống `..`, symlink/junction và patch-path escape. Source mutations trên cùng/overlapping path được serialize và source writes/copies dùng atomic replace để tránh lost-update/partial-write khi nhiều MCP transport chạy song song.

**Native shell caveat:** `run_command` và `start_process` chạy shell/process thật của OS. `FULL_DISK_ACCESS=false` **không** biến chúng thành OS sandbox và không thể ngăn một command được phép tự truy cập path khác. Setting này là path boundary cho các tool mà server tự kiểm soát path, không phải VM/container/process isolation.

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
| **Resource not found** on tool call | Refresh connector + new chat. Server auto-recovers sessions — ensure latest build is running. |
| **Connection failed** | Check `.\start.ps1` + tunnel are both running. URL must be HTTPS. |
| **502 from tunnel during restart** | The tunnel can remain up while the local server is restarting; a brief 502 means `127.0.0.1:3000` was temporarily unavailable. Manager now drains MCP sessions with bounded graceful close before force fallback, reducing this window. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **Tool blocked by OpenAI safety** | Not a server bug. Retry with `run_command` (response may include `run_command_fallback`). Affects `git_push`, `git_checkout`, `delete_directory` occasionally. |
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

**Path sandbox:** mặc định `FULL_DISK_ACCESS=false` — các tool có path argument chỉ đọc/ghi trong canonical `WORKSPACE_PATH` (+ `EXTRA_WORKSPACE_PATHS`) và chặn symlink/junction/patch escape. `run_command` / `start_process` vẫn là native shell, **không** được OS-sandbox bởi setting này. Bật `true` chỉ mở scope của path-aware tools ra toàn máy.

Chạy thủ công (không dùng manager):

```powershell
.\start.ps1                    # terminal 1
.\openai-tunnel.bat            # terminal 2 (tunnel cố định)
```

**ChatGPT:** Settings → Connectors → tạo connector → chọn tunnel → Refresh → chat mới.

**Bắt buộc tag connector mỗi chat:** Chat mới → **+** → **More** → bật connector, hoặc gõ **`@`** + tên connector trong ô chat. Nếu không tag, ChatGPT báo *"Đang tìm các công cụ có sẵn"* rồi *"Lỗi trong luồng tin nhắn"* — **server không có log lỗi** vì MCP chưa được gọi.

**WORKSPACE_PATH:** đặt đúng thư mục project (không phải thư mục `chatgpt-local-coder`). Server tự đọc `CLAUDE.md` / `AGENTS.md` giống Claude Code.

**Lưu ý:** Không bấm **"Luôn cho phép"** trên popup — cấu hình quyền ở Settings → Apps. Sau khi restart server: Refresh connector + mở chat mới + tag lại connector.

Chi tiết cho AI agent: [AGENTS.md](AGENTS.md)