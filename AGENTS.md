# Codex MCP Server — Agent Onboarding

MCP server local giống Codex: đọc/ghi file, chạy lệnh, git. Dùng với ChatGPT Developer Mode hoặc bất kỳ MCP client nào.

## Lần đầu kết nối — gọi ngay 2 tool này

1. **`agent_status`** — xem quyền, full disk access, workspace roots
2. **`project_context`** — đọc AGENTS.md, README, CLAUDE.md trong project

## Quyền truy cập

- `FULL_DISK_ACCESS` là security mode: `false` = mutation/project-discovery paths chỉ trong workspace roots và arbitrary/project-controlled process trees phải qua Windows AppContainer. Ngoại lệ context duy nhất: `read_text_file` được đọc canonical user Global Harness dưới `~/.agents` và đúng các Harness-owned text file `~/.codex` được allowlist để bootstrap/router tự load nội dung cần thiết; ngoại lệ này không mở write, shell, Git, hook, upstream hay project authority. Mọi upstream MCP transport hiện chạy native (`stdio` hoặc HTTP) đều bị block trong strict mode cho tới khi có sandbox-managed/pinned transport; `true` = explicit trusted native/full-machine mode. Fixed host mediators chỉ được phép thực hiện operation hẹp đã định nghĩa, không nhận arbitrary command text.
- **Destructive-command guard luôn bật**, không phụ thuộc `FULL_DISK_ACCESS`: shell không được dùng để permanent-delete, `git clean -f*`, `git reset --hard`, hoặc bypass restore/delete safety.
- `WORKSPACE_PATH` bắt buộc xác định **đúng một primary workspace root** và là default cwd/context ổn định; không derive ngầm từ `process.cwd()` và không nhét nhiều root bằng `;`. Root bổ sung chỉ qua `EXTRA_WORKSPACE_PATHS`. Root được cấu hình có thể là một Git project hoặc một collection root mà user chủ động cấp quyền. Khi `FULL_DISK_ACCESS=false`, chính các root đã cấu hình là hard mutation/project/process authority; `read_text_file` chỉ có thêm read-only Global Harness context (`~/.agents` + exact allowlisted Harness-owned `~/.codex` text files), không biến các path đó thành workspace. Khi `true`, filesystem authority là explicit full-machine.

## ChatGPT connector lifecycle / approval state

### Cách đúng (làm TRƯỚC khi chat)

1. **Settings → Apps → Connectors** → chọn connector **Codex Local**
2. Đặt quyền app: **Chỉ hỏi trước thay đổi quan trọng** hoặc **Hỏi trước khi thay đổi**
3. Chỉ bấm **Refresh** khi public MCP contract version thay đổi hoặc connector snapshot thực tế không khớp `mcp_contract.version/hash`; internal implementation update không đổi ABI thì không Refresh.
4. Mở chat mới, chọn connector, rồi mới gửi prompt

### KHÔNG bấm "Luôn cho phép" trên popup

Đây là bug/UI ChatGPT: bấm **Luôn cho phép** thường **đóng MCP session** → tunnel log `stream canceled` → phải kết nối lại.

Thay vào đó:
- Bấm **Cho phép một lần** khi cần, hoặc
- Cấu hình quyền ở **Settings → Apps** (bước trên) để ít hỏi hơn

### Lỗi tunnel `stream canceled by remote`

Bình thường khi:
- Server restart (dùng `chatgpt-local-coder.bat stop` / `start` hoặc nút Restart trong manager) trong lúc ChatGPT đang kết nối
- ChatGPT đóng stream SSE sau khi đổi quyền
- Tunnel URL đổi (chạy lại `chatgpt-local-coder.bat tunnel start` kiểu cloudflared) mà chưa update Connector URL

**Fix:** Giữ server + tunnel chạy ổn định, không restart giữa chừng. Sau restart nội bộ, reconnect/new chat nếu transport cần; chỉ Refresh connector khi public ABI version/snapshot thực sự đổi.

**Khuyến nghị:** Dùng OpenAI Secure MCP Tunnel (`chatgpt-local-coder.bat tunnel start`) — `tunnel_id` cố định, không cần đổi URL connector mỗi lần.

## Mapping Claude Code ↔ Codex MCP

| Claude Code | Codex MCP | Ghi chú |
|---|---|---|
| `Read` | `read_text_file` | Có `offset`+`limit` (line numbers) |
| `Write` | `write_file` | |
| `Edit` | `edit_file` | Có `replace_all` |
| `MultiEdit` | `multi_edit` | |
| `Glob` | `glob` | Sort theo mtime |
| `Grep` | `grep` | content / files_with_matches / count |
| `LS` | `list_directory` | Có `ignore` globs |
| `Bash` | `run_command` | Lệnh ngắn, chờ xong |
| Background shell | `start_process` + `process_output` | |
| `Rewind` | `rewind` | `list` / `preview` / `restore` — undo file edits qua checkpoint tự động |
| — | `mcp_servers`, `mcp_tools`, `mcp_call` | Hub MCP; tool luôn tồn tại trong ABI, nhưng strict mode fail-closed cho native stdio/HTTP upstream |
| — | Admin UI `:3001/ui` | Import MCP từ Cursor / Claude Code / OpenCode |
| — | `apply_patch` | Codex/OpenAI style (thêm so với Claude) |
| — | `git_*`, `git_restore` | Git tools riêng (Claude dùng Bash) |
| — | `project_context` | Đọc AGENTS.md / CLAUDE.md |

**Không có trong MCP này** (ChatGPT built-in hoặc MCP khác): `WebSearch`, `WebFetch`, `Task`/subagent, `NotebookEdit`, `LSP`.

## Sửa code — tool nào dùng khi nào

| Việc cần làm | Tool |
|---|---|
| Tìm file theo tên | `glob` |
| Tìm nội dung | `grep` |
| Đọc file | `read_text_file` |
| Liệt kê thư mục | `list_directory` |
| Sửa bằng diff/patch | `apply_patch` (ưu tiên) |
| Sửa nhiều đoạn | `multi_edit` |
| Sửa bằng regex | `replace_regex` |
| Tạo file mới | `write_file` |
| Xóa / đổi tên | `delete_file` / `delete_directory` (Recycle Bin), `move_file` |
| Chạy lệnh ngắn | `run_command` |
| Build/test dài | `start_process` → `process_output` |
| Git | `git_status`, `git_diff`, `git_commit`, `git_restore` |
| Restore file từ commit | `git_restore` (không dùng `git_checkout` cho file) |
| Undo edits trong session | `rewind` action `list` → `preview` → `restore` (không track bash) |
| Switch branch | `git_checkout` (chỉ branch) hoặc `git_branch` action `switch` |

### Timeout của `run_command` không phải hết MCP session / ChatGPT turn

- `run_command` có synchronous response budget riêng (`MCP_SYNC_RESPONSE_BUDGET_MS`, mặc định 100000 ms). Nếu hết budget, foreground process tree bị terminate và result phải ghi rõ `command_outcome=timed_out`, `timeout_scope=run_command_sync_response_budget`, `timeout_is_session_termination=false`.
- Không được dùng timeout này, `MCP_SESSION_TTL_MS`, session cleanup/recovery, process capacity hoặc một tool call fail làm lý do tuyên bố "hết phiên tool", "hết turn", "không thể làm tiếp trong turn này". Chỉ được nói như vậy nếu **host thực sự trả explicit terminal signal tương ứng**.
- Khi `timed_out=true`, kiểm tra side effect có thể đã xảy ra trước timeout, rồi tiếp tục task bằng fresh tool call; job dài phải chạy qua `start_process` + `process_output` thay vì lặp lại `run_command` dài một cách mù quáng.
- **Interruption = checkpoint, không phải completion.** HTTP `502/503/504`, connection reset, transient connector/transport loss hoặc một invocation fail đơn lẻ phải dẫn tới: re-read CURRENT state/side effects → retry an toàn bằng fresh call → tiếp tục mọi work còn executable. Không blind-retry `401/403` hoặc host-disabled/safety denial; các lỗi đó phải diagnose riêng. Chỉ explicit host terminal/unrecoverable signal mới là stopping condition vì transport.
- `start_process` là non-terminal workflow. Result của `start_process`/`process_output`/`process_status` phải expose `continuation_required`; khi `continuation_required=true` hoặc `process_output.running=true`, tiếp tục poll `process_output` đến `running=false`, đọc exit/output rồi tiếp tục task. Background job không phải conversation boundary.

## ChatGPT safety layer — tool bị chặn ngẫu nhiên

Một số tool wrapper có thể bị lớp an toàn của ChatGPT host chặn **trước khi request tới Local Coder**. Không dùng `run_command`, Git hoặc tool khác để bypass một MCP action đang bị host chặn. Xác định layer bằng protocol read-only v2 trong `agent_status.mcp_dispatch.protocol`: dùng `write_file` tạo canary canonical `.clc-host-gate-canary-<UTC>-<nonce>.tmp` với nonce mới dài 8–64 ký tự và content chính xác `host-gate diagnostic canary\n` trong project/scratch directory đã được user cấp quyền, rồi gọi `agent_status` ngay sau host result. Match exact basename ở `host_gate_canaries` trước, rồi `recent_dispatches`: `state=reached` = `MCP_REACHED_UNSETTLED`; `state=rejected` = `MCP_REJECTED`; `state=executed` = `MCP_EXECUTED`. **Không có record chỉ được suy ra `HOST_NOT_INVOKED` khi host báo disabled/not-dispatched và timestamp của attempt nằm trong `mcp_dispatch.coverage.canary.complete_since` của đúng live process hiện tại**; nếu process đã restart, record có thể đã bị evict, hoặc timestamp không đủ chứng minh coverage thì dùng `INDETERMINATE_NO_COVERAGE` và chạy canary mới. `agent_status` dùng để quan sát sẽ tự xuất hiện tạm thời `state=reached` cho tới khi response của chính nó hoàn tất. Aggregate counter chỉ là process-global, không dùng để quy một attempt cho riêng chat.

Nếu clean canary PASS nhưng sau khi nạp thêm context lại thành `HOST_NOT_INVOKED`, bisect context theo bounded batches và dừng tại transition PASS→FAIL. Transition đó chỉ là **trigger window**, không phải bằng chứng file/context độc hại. Không lược bỏ user intent, authorization hoặc safety context chỉ để giữ write enabled.

`git_restore` phải dùng tool `git_restore` để tạo checkpoint trước khi ghi đè. `delete_file` / `delete_directory` phải dùng tool tương ứng để chuyển target vào Recycle Bin. Không dùng `rm`, `Remove-Item`, `rmdir`, `del`, script Python/Node delete, `git clean -f*` hoặc `git reset --hard` làm fallback.

**Ổn định:** `git_status`, `git_diff`, `git_add`, `git_commit`, `git_log`, `git_branch`, `git_stash`, `git_reset` (`soft`/`mixed`), `git_pull`.

## ChatGPT public MCP contract (ABI)

ChatGPT host connector nhìn thấy **một ABI cố định, có version** — không phải tập
tool nội bộ:

- **Slim profile = 27 tools** (đóng băng): inventory chính xác, thứ tự, title,
  description, input schema, annotations. Canonical document:
  `scripts/fixtures/chatgpt-public-contract-v1.json` (SHA-256
  `afd98bd3…39e6`).
- **Internal executor changes không được đổi ABI public**: process sandbox, checkpoint, atomic write, logging, Git/hook/upstream hardening không được làm đổi `tools/list` slim (contract test sẽ fail nếu drift). Đổi ABI là thao tác explicit: bump
  `CHATGPT_PUBLIC_CONTRACT_VERSION` → `npm run build && node scripts/generate-contract-fixture.mjs`
  → cập nhật test expected → commit fixture mới.
  Startup fail-closed: nếu live registration lệch fixture → server từ chối
  boot với `MCP_PUBLIC_CONTRACT_DRIFT` (override chỉ bằng env explicit
  `CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE=1`, dev-only).
- **Refresh connector**: chỉ cần khi **contract version đổi**. Không refresh sau
  mỗi update implementation nội bộ — ABI không đổi thì connector không cần đụng.
- **Chẩn đoán layer chặn write**: `agent_status` trả `mcp_contract` (version, hash, tool_count, dynamic flags), `boot.boot_id`, `process_security`, và tách `local_executor_profile`/`local_write_allowed` khỏi `host_action_permission: "unobservable"`. `/health` cũng expose contract + sandbox health.
- **Security invariant**: `FULL_DISK_ACCESS=false` phải confine mutation/project-discovery tools và arbitrary/project-controlled process trees vào workspace roots bằng Windows AppContainer. `read_text_file` có đúng một read-only context exception cho canonical Global Harness surfaces (`~/.agents` + exact allowlisted Harness-owned `~/.codex` text files), chỉ để bootstrap/router selectively load nội dung cần thiết; canonicalization phải chặn symlink/junction escape và mọi mutation/process/project authority vẫn giữ workspace boundary. Native stdio/HTTP upstream đều fail-closed trước transport; DNS preflight đơn thuần không đủ vì rebinding/redirect có thể chạm local host-authority service. Shell/Git/hooks/child process/upstream không được dùng để vượt path denial. Sandbox prepare/hash/ACL/self-test failure → fail closed; không native fallback. `FULL_DISK_ACCESS=true` mới là explicit trusted native full-machine mode. Fixed host mediators (AppContainer control, Recycle Bin operation, explicit setup helper) chỉ nhận input hẹp, không arbitrary command. `SANDBOX_EXEC_ROOTS` là privileged RX policy: nếu approved roots đổi, runtime phải fail closed cho tới khi `npm run setup:sandbox` revoke grants cũ + grant roots mới; agent command không bao giờ chạy elevated.

## Format `apply_patch` (Codex-style)

```
@@
-old line to remove
+new line to add
 context line unchanged
```

Hoặc unified diff chuẩn:

```
@@ -10,3 +10,4 @@
 context
-old
+new
```

Tham số: `{ "path": "src/foo.ts", "patch": "...", "dry_run": false }`

Dùng `dry_run: true` để xem diff trước khi ghi.

## Đường dẫn file

- Dùng path tuyệt đối: `C:\Users\...\project\src\file.ts`
- Hoặc relative từ `WORKSPACE_PATH` trong `.env`
- Gọi `list_allowed_directories` nếu bị "Access denied"

## Khởi động server

```powershell
cd codex-mcp-server
.\chatgpt-local-coder.bat start  # Terminal 1: Manager (tự quản MCP server + tunnel)
.\chatgpt-local-coder.bat tunnel start   # Terminal 2: OpenAI tunnel (URL cố định)
```

**Lần đầu:** chạy `chatgpt-local-coder.bat tunnel start` → nhập `tunnel_id` + Runtime API key từ [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) (lưu vào instance `.env` qua manager UI nếu chưa có).

**ChatGPT:** [Settings → Connectors](https://chatgpt.com/#settings/Connectors) → chọn tunnel (không cần dán URL thủ công).

Tunnel cũ (URL đổi mỗi lần): `chatgpt-local-coder.bat tunnel start` (cloudflared).

Health check: `http://localhost:3000/health` | Tunnel UI: `http://127.0.0.1:8080/ui`

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| Access denied | Kiểm tra path và thêm **đúng root cần thiết** vào `EXTRA_WORKSPACE_PATHS`. Chỉ bật `FULL_DISK_ACCESS=true` khi user chủ động chọn trusted full-machine mode, không dùng nó như workaround cho path denial. |
| Patch context not found | Đọc file trước; thêm context lines (dòng bắt đầu bằng space) |
| ChatGPT hỏi quyền / write action bị disable | Gọi `agent_status`, làm canonical canary `.clc-host-gate-canary-<UTC>-<nonce>.tmp` + exact canary content, rồi match exact basename trong `mcp_dispatch.host_gate_canaries`/`recent_dispatches`. `reached`/`rejected`/`executed` chứng minh request đã tới Local Coder. Chỉ dùng absent + host disabled để kết luận `HOST_NOT_INVOKED` khi `mcp_dispatch.coverage.canary.complete_since` bao phủ timestamp của attempt trên cùng live process; nếu không thì `INDETERMINATE_NO_COVERAGE`. Kiểm host surface/action policy; chỉ Refresh khi connector snapshot/public ABI thực sự cần đổi. Local MCP annotations không thể auto-approve thay ChatGPT. |
| Connection failed | Chạy `chatgpt-local-coder.bat status` — Manager + Server + Tunnel phải chạy; URL phải HTTPS |