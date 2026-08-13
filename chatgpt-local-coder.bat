@echo off
setlocal EnableExtensions
title ChatGPT Local Coder
cd /d "%~dp0"

REM =====================================================================
REM  ChatGPT Local Coder - file launcher duy nhat
REM  (thay the cac file cu: setup.bat, manager.bat, start.bat/ps1,
REM   stop.bat/ps1, tunnel.bat/ps1, openai-tunnel*.bat)
REM
REM  Cach dung:
REM    %~nx0               -> cai dat (node deps + build), bat autostart,
REM                           start Manager (an) va mo dashboard
REM    %~nx0 start         -> chi start Manager (an) neu chua chay
REM    %~nx0 stop          -> dung Manager (giu nguyen Server + Tunnel)
REM    %~nx0 status        -> trang thai Manager + cac instance
REM    %~nx0 autostart     -> bat tu dong chay khi dang nhap Windows (tao LNK)
REM    %~nx0 autostart off -> tat autostart (xoa LNK)
REM    %~nx0 tunnel start  -> start tunnel instance default (qua Manager)
REM    %~nx0 tunnel stop   -> dung tunnel instance default (qua Manager)
REM    %~nx0 install       -> chi npm install + build neu can
REM    %~nx0 help
REM
REM  Gioi han: khong ho tro duong dan cai dat chua khoang trang (gioi han
REM  nhung thao tac lenh cmd.exe trong script).
REM =====================================================================

set "CMD=%~1"
if "%CMD%"=="" set "CMD=setup"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

REM ---- Manager port tu .env (mac dinh 3300) ----
set "MGR_PORT=3300"
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"MANAGER_PORT=" ".env" 2^>nul`) do set "MGR_PORT=%%b"
for /f "delims=" %%p in ("%MGR_PORT%") do set "MGR_PORT=%%p"

if /i "%CMD%"=="setup"     goto :cmd_setup
if /i "%CMD%"=="start"     goto :cmd_start
if /i "%CMD%"=="stop"      goto :cmd_stop
if /i "%CMD%"=="status"    goto :cmd_status
if /i "%CMD%"=="autostart" goto :cmd_autostart
if /i "%CMD%"=="install"   goto :cmd_install
if /i "%CMD%"=="tunnel"    goto :cmd_tunnel
if /i "%CMD%"=="help"      goto :cmd_help
echo Lenh khong hop le: %CMD%  ^(xem "%~nx0 help"^)
exit /b 1

REM =====================================================================
:cmd_help
REM =====================================================================
echo Cach dung: %~nx0 [setup^|start^|stop^|status^|autostart [off]^|tunnel start^|tunnel stop^|install^|help]
echo   (khong tham so = setup: cai dat + autostart + start + mo dashboard)
exit /b 0

REM =====================================================================
:cmd_install
REM =====================================================================
call :check_node
if errorlevel 1 exit /b 1
if not exist "%~dp0node_modules" (
  echo [..] Dang cai thu vien ^(npm install^)...
  call npm install
  if errorlevel 1 ( echo [LOI] npm install that bai. & exit /b 1 )
) else (
  echo [OK] Thu vien da co san.
)
call :ensure_build
if errorlevel 1 exit /b 1
exit /b 0

REM =====================================================================
:cmd_setup
REM =====================================================================
call :cmd_install
if errorlevel 1 exit /b 1
call :ensure_autostart
if errorlevel 1 exit /b 1
call :cmd_start
if errorlevel 1 exit /b 1
echo.
echo  ============================================
echo   Cai dat hoan tat!
echo   Dashboard: http://127.0.0.1:%MGR_PORT%
echo  ============================================
echo.
if "%SETUP_NO_OPEN%"=="1" (
  echo  [TEST] Bo qua mo browser.
) else (
  start "" "http://127.0.0.1:%MGR_PORT%"
)
exit /b 0

REM =====================================================================
:cmd_start
REM =====================================================================
call :ensure_build
if errorlevel 1 exit /b 1
call :manager_running
if not errorlevel 1 (
  echo [OK] Manager da chay: http://127.0.0.1:%MGR_PORT%
  exit /b 0
)
if not exist "%~dp0manager\state\logs" mkdir "%~dp0manager\state\logs"
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo [..] Dang khoi dong Manager (an) tai http://127.0.0.1:%MGR_PORT% ...
"%PS%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'manager/server.mjs','--no-open' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0manager\state\logs\manager-console.log' -RedirectStandardError '%~dp0manager\state\logs\manager-console.err.log'"
ping -n 5 127.0.0.1 >nul
call :manager_running
if errorlevel 1 (
  echo [LOI] Manager chua san sau khi khoi dong. Xem manager\state\logs\manager-console.err.log
  exit /b 1
)
echo [OK] Manager dang chay: http://127.0.0.1:%MGR_PORT%
exit /b 0

REM =====================================================================
:cmd_stop
REM =====================================================================
call :manager_running
if errorlevel 1 (
  echo [OK] Manager chua chay tren http://127.0.0.1:%MGR_PORT%
  exit /b 0
)
"%PS%" -NoProfile -Command "try { $m=Invoke-RestMethod 'http://127.0.0.1:%MGR_PORT%/api/health' -TimeoutSec 3 } catch { Write-Host 'Khong doc duoc manager health.'; exit 1 }; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$m.pid) -ErrorAction SilentlyContinue; if (-not $p -or $p.Name -notmatch '^node') { Write-Host ('PID '+$m.pid+' khong phai node - khong dung.'); exit 1 }; if ($p.CommandLine -notmatch 'manager[\\/]server\.mjs') { Write-Host ('PID '+$m.pid+' khong phai Local Coder Manager - khong dung.'); exit 1 }; Stop-Process -Id $m.pid -Force; Write-Host ('Da dung Manager PID '+$m.pid+' (Server + Tunnel cac workspace giu nguyen)')"
exit /b 0

REM =====================================================================
:cmd_status
REM =====================================================================
"%PS%" -NoProfile -Command "$m=$null; try { $m=Invoke-RestMethod 'http://127.0.0.1:%MGR_PORT%/api/health' -TimeoutSec 3 } catch {}; if (-not $m) { Write-Host ('Manager: KHONG chay (http://127.0.0.1:%MGR_PORT%) - chay: %~nx0 start'); exit 1 }; Write-Host ('Manager: dang chay - PID ' + $m.pid + ' @ http://127.0.0.1:%MGR_PORT%'); $i=Invoke-RestMethod 'http://127.0.0.1:%MGR_PORT%/api/instances' -TimeoutSec 5; foreach ($x in $i.instances) { $sv=if ($x.server.running) {'chay'} else {'dung'}; $tn=if ($x.tunnel.running) {'chay'} else {'dung'}; $ws=$x.env.WORKSPACE_PATH; if (-not $ws) { $ws='(chua dat)' }; Write-Host (' - ' + $x.name + ': server=' + $sv + ' | tunnel=' + $tn + ' | ws=' + $ws) }"
exit /b 0

REM =====================================================================
:cmd_autostart
REM =====================================================================
if /i "%~2"=="off" goto :autostart_off
call :ensure_autostart
exit /b 0
:autostart_off
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChatGPT Local Coder Manager.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo [OK] Da tat autostart (xoa LNK).
) else (
  echo [OK] Autostart da tat san.
)
exit /b 0

REM =====================================================================
:cmd_tunnel
REM =====================================================================
call :manager_running
if errorlevel 1 (
  echo [LOI] Manager chua chay. Chay: %~nx0 start
  exit /b 1
)
if /i "%~2"=="start" (
  "%PS%" -NoProfile -Command "try { $r=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:%MGR_PORT%/api/instances/default/tunnel/start' -ContentType 'application/json' -Body '{}' -TimeoutSec 60; if ($r.ok) { Write-Host ('Tunnel da bat: ' + $r.mode + ' ' + $r.url) } else { Write-Host ('LOI: ' + $r.error); exit 1 } } catch { Write-Host ('LOI: ' + $_.Exception.Message); exit 1 }"
  exit /b 0
)
if /i "%~2"=="stop" (
  "%PS%" -NoProfile -Command "try { $r=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:%MGR_PORT%/api/instances/default/tunnel/stop' -ContentType 'application/json' -Body '{}' -TimeoutSec 60; if ($r.ok) { Write-Host 'Tunnel da dung.' } else { Write-Host ('LOI: ' + $r.error); exit 1 } } catch { Write-Host ('LOI: ' + $_.Exception.Message); exit 1 }"
  exit /b 0
)
echo Lenh tunnel khong hop le: %~2  ^(start^|stop^)
exit /b 1

REM =====================================================================
:ensure_autostart
REM =====================================================================
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\ChatGPT Local Coder Manager.lnk"
if not exist "%~dp0manager\state" mkdir "%~dp0manager\state"
REM LNK tro powershell an -> chay chinh file nay voi lenh "start".
REM Khong dung VBS/wscript (VBScript engine khong dang ky san tren nhieu Windows).
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%LNK%'); $s.TargetPath='%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'; $s.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ' + [char]34 + '& ''%~dp0chatgpt-local-coder.bat'' start' + [char]34; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='ChatGPT Local Coder Manager (hidden)'; $s.Save()"
if not exist "%LNK%" (
  echo [LOI] Khong tao duoc autostart LNK.
  exit /b 1
)
"%PS%" -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%LNK%'); if ($s.Arguments -notmatch 'chatgpt-local-coder\.bat') { exit 1 }"
if errorlevel 1 (
  echo [LOI] LNK autostart tao ra khong tro toi chatgpt-local-coder.bat.
  exit /b 1
)
echo [OK] Autostart da cai: "%LNK%"
exit /b 0

REM =====================================================================
:ensure_build
REM =====================================================================
set "NEED_BUILD=0"
if not exist "%~dp0dist\index.js" (
  set "NEED_BUILD=1"
) else (
  REM Khong duoc dat "%PS%" trong dau ngoac kep o dau lenh backquote:
  REM cmd.exe parse sai va chay khong ra ket qua (false-green). %PS% khong
  REM chua khoang trang tren Windows chuan. NEED_BUILD rong = check loi
  REM -> xem nhu can build (huong an toan).
  for /f "usebackq delims=" %%s in (`%PS% -NoProfile -ExecutionPolicy Bypass -Command "$s=Get-ChildItem -Path '%~dp0src' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; $d=Get-Item -LiteralPath '%~dp0dist\index.js'; if (-not $s -or $s.LastWriteTime -le $d.LastWriteTime) { '0' } else { '1' }"`) do set "NEED_BUILD=%%s"
  if "%NEED_BUILD%"=="" set "NEED_BUILD=1"
)
if "%NEED_BUILD%"=="1" (
  echo [..] Dang build ^(npm run build^)...
  call npm run build
  if errorlevel 1 (
    echo [LOI] Build that bai.
    exit /b 1
  )
) else (
  echo [OK] Build da co san.
)
exit /b 0

REM =====================================================================
:check_node
REM =====================================================================
node -v >nul 2>nul
if not errorlevel 1 goto :node_ok
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo  [LOI] Khong tim thay Node.js. Tai ve: https://nodejs.org
  exit /b 1
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
"%ProgramFiles%\nodejs\node.exe" -v >nul 2>nul
if errorlevel 1 (
  echo  [LOI] Node.js khong chay duoc tu "%ProgramFiles%\nodejs".
  exit /b 1
)
:node_ok
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR (
  echo  [LOI] Khong doc duoc Node version.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo  [LOI] Can Node.js 22+, ban dang co %NODE_MAJOR%. Tai moi: https://nodejs.org
  exit /b 1
)
echo  [OK] Node.js %NODE_MAJOR%+ da san sang.
exit /b 0

REM =====================================================================
:manager_running
REM =====================================================================
"%PS%" -NoProfile -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%MGR_PORT%/api/health' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch {} exit 1"
exit /b %errorlevel%
