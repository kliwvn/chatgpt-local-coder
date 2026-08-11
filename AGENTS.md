# Codex MCP Server — Agent Onboarding

MCP server local giống Codex: đọc/ghi file, chạy lệnh, git. Dùng với ChatGPT Developer Mode hoặc bất kỳ MCP client nào.

## Lần đầu kết nối — gọi ngay 2 tool này

1. **`agent_status`** — xem quyền, full disk access, workspace roots
2. **`project_context`** — đọc AGENTS.md, README, CLAUDE.md trong project

## Quyền truy cập

- `FULL_DISK_ACCESS` chỉ điều khiển scope của **path-aware tools**: `false` = workspace roots; `true` = path toàn máy.
- **Destructive-command guard luôn bật**, không phụ thuộc `FULL_DISK_ACCESS`: shell không được dùng để permanent-delete, `git clean -f*`, `git reset --hard`, hoặc bypass restore/delete safety.
- `WORKSPACE_PATH` chỉ là thư mục mặc định cho path tương đối và shell/git

## ChatGPT: tránh popup + lỗi "Luôn cho phép phải kết nối lại"

### Cách đúng (làm TRƯỚC khi chat)

1. **Settings → Apps → Connectors** → chọn connector **Codex Local**
2. Đặt quyền app: **Chỉ hỏi trước thay đổi quan trọng** hoặc **Hỏi trước khi thay đổi**
3. Bấm **Refresh** connector (sau mỗi lần update server)
4. Mở chat mới, chọn connector, rồi mới gửi prompt

### KHÔNG bấm "Luôn cho phép" trên popup

Đây là bug/UI ChatGPT: bấm **Luôn cho phép** thường **đóng MCP session** → tunnel log `stream canceled` → phải kết nối lại.

Thay vào đó:
- Bấm **Cho phép một lần** khi cần, hoặc
- Cấu hình quyền ở **Settings → Apps** (bước trên) để ít hỏi hơn

### Lỗi tunnel `stream canceled by remote`

Bình thường khi:
- Server restart (`stop.ps1` / `start.ps1`) trong lúc ChatGPT đang kết nối
- ChatGPT đóng stream SSE sau khi đổi quyền
- Tunnel URL đổi (chạy lại `tunnel.bat` cloudflared) mà chưa update Connector URL

**Fix:** Giữ server + tunnel chạy ổn định, không restart giữa chừng. Nếu restart → Refresh connector + chat mới.

**Khuyến nghị:** Dùng `openai-tunnel.bat` (OpenAI Secure MCP Tunnel) — `tunnel_id` cố định, không cần đổi URL connector mỗi lần.

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
| — | `mcp_servers`, `mcp_tools`, `mcp_call` | Gọi MCP server khác trên máy (hub) |
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

## ChatGPT safety layer — tool bị chặn ngẫu nhiên

Một số tool wrapper đôi khi có thể bị lớp an toàn của client chặn. Chỉ được dùng `run_command` fallback cho thao tác **không phá hủy**. **Không bao giờ bypass delete/restore bằng shell.** Executor MCP chặn permanent-delete độc lập với hướng dẫn của agent.

| Tool hay bị chặn | Fallback `run_command` |
|---|---|
| `git_push` | `git push -u origin <branch>` |
| `git_checkout` | `git switch <branch>` |

`git_restore` phải dùng tool `git_restore` để tạo checkpoint trước khi ghi đè. `delete_file` / `delete_directory` phải dùng tool tương ứng để chuyển target vào Recycle Bin. Không dùng `rm`, `Remove-Item`, `rmdir`, `del`, script Python/Node delete, `git clean -f*` hoặc `git reset --hard` làm fallback.

**Ổn định:** `git_status`, `git_diff`, `git_add`, `git_commit`, `git_log`, `git_branch`, `git_stash`, `git_reset` (`soft`/`mixed`), `git_pull`.

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
.\start.ps1 -Force          # Terminal 1: MCP server
.\openai-tunnel.bat         # Terminal 2: OpenAI tunnel (URL cố định)
```

**Lần đầu:** chạy `.\openai-tunnel-init.bat` → nhập `tunnel_id` + Runtime API key từ [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels).

**ChatGPT:** [Settings → Connectors](https://chatgpt.com/#settings/Connectors) → chọn tunnel (không cần dán URL thủ công).

Tunnel cũ (URL đổi mỗi lần): `.\tunnel.bat` (cloudflared).

Health check: `http://localhost:3000/health` | Tunnel UI: `http://127.0.0.1:8080/ui`

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| Access denied | Kiểm tra path; bật `FULL_DISK_ACCESS=true` |
| Patch context not found | Đọc file trước; thêm context lines (dòng bắt đầu bằng space) |
| ChatGPT hỏi quyền / write action bị disable | Kiểm tra MCP dispatch diagnostics rồi Refresh/re-approve connector. Local MCP annotations không thể auto-approve thay ChatGPT. |
| Connection failed | Chạy `.\start.ps1` + tunnel; URL phải HTTPS |