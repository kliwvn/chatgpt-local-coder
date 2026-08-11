@echo off
setlocal EnableExtensions
title ChatGPT Local Coder - Setup
cd /d "%~dp0"

echo.
echo  ============================================
echo   ChatGPT Local Coder - Cai dat mot cham
echo  ============================================
echo.

REM ---- 1. Kiem tra Node.js (>= 22) ----
rem Probe node directly (node -v) instead of `where node`: `where` reports
rem failure from restricted-PATH contexts even when the standard install is
rem present and runnable, which aborted setup before it ever reached the
rem autostart step.
node -v >nul 2>nul
if not errorlevel 1 goto :node_ok
rem Node not on PATH - use the absolute standard install path. A `set PATH`
rem inside a parenthesized block does not take effect until the block ends
rem (cmd expands variables at parse time), so set it at top level and probe
rem the absolute exe rather than re-probing `node` by name.
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo  [LOI] Khong tim thay Node.js. Tai ve: https://nodejs.org
  echo        (Node thong thuong o "%ProgramFiles%\nodejs")
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

REM ---- 2. Cai thu vien (npm install) neu thieu ----
if not exist "%~dp0node_modules" (
  echo  [..] Dang cai thu vien ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo  [LOI] npm install that bai. Xem loi o tren.
    exit /b 1
  )
) else (
  echo  [OK] Thu vien da co san.
)

REM ---- 3. Build TypeScript neu thieu hoac cu hon source ----
REM Manager tu choi khoi dong Gateway khi "Runtime source is newer than
REM dist" (buildDrift): kiem tra mtime de build dung luc, khong chi khi
REM dist khong ton tai. Freshness check chay qua file .ps1 de tranh dau
REM ngoac don bi cmd parse nham trong for /f.
set "NEED_BUILD=0"
if not exist "%~dp0dist\index.js" (
  set "NEED_BUILD=1"
) else (
  for /f "usebackq delims=" %%s in (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-dist-fresh.ps1" "%~dp0src" "%~dp0dist\index.js"`) do set "NEED_BUILD=%%s"
)
if "%NEED_BUILD%"=="1" (
  echo  [..] Dang build ^(npm run build^)...
  call npm run build
  if errorlevel 1 (
    echo  [LOI] Build that bai. Xem loi o tren.
    exit /b 1
  )
) else (
  echo  [OK] Build da co san.
)

REM ---- 4. Cai autostart (Startup folder) ----
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\ChatGPT Local Coder Manager.lnk"

REM manager\state bi gitignore nen khong co tren may moi - phai tao truoc
REM khi ghi launcher (redirect vao thu muc khong ton tai se loi).
if not exist "%~dp0manager\state" mkdir "%~dp0manager\state"

REM Luon tai tao launcher moi lan chay: neu shortcut Startup cu van con, no
REM phai tro dung path cua thu muc copy moi (khong duoc giu path may cu).
REM Dung PowerShell thay vi VBS/wscript: VBScript engine khong dang ky san
REM tren nhieu Windows hien dai ("There is no script engine for file
REM extension '.vbs'") lam chet toan bo chuoi autostart.
call :create_lnk
if not exist "%LAUNCHER%" (
  echo  [LOI] Khong tao duoc manager-hidden.ps1.
  exit /b 1
)
if exist "%LNK%" (
  echo  [OK] Autostart da duoc cai.
) else (
  echo  [LOI] Khong cai duoc autostart. Tu tao shortcut vao Startup.
)
goto :after_autostart


:create_lnk
set "LAUNCHER=%~dp0manager\state\manager-hidden.ps1"
>  "%LAUNCHER%" echo $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "`"%~dp0manager.bat`"" -WorkingDirectory "%~dp0" -WindowStyle Hidden -PassThru
>> "%LAUNCHER%" echo Start-Sleep -Seconds 2
>> "%LAUNCHER%" echo if ($proc.HasExited) { exit 1 }
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%LNK%'); $s.TargetPath='%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'; $s.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%LAUNCHER%\"'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='ChatGPT Local Coder Manager (hidden)'; $s.Save()"
exit /b 0

:after_autostart
REM ---- 5. Khoi dong manager (neu chua chay) + mo dashboard ----
echo  [..] Dang kiem tra manager tai http://127.0.0.1:3300 ...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3300/api/health' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo  [..] Manager chua chay - dang khoi dong ^(an^)...
  start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0manager\state\manager-hidden.ps1"
  ping -n 4 127.0.0.1 >nul
) else (
  echo  [OK] Manager da chay san.
)

echo.
echo  ============================================
echo   Cai dat hoan tat!
echo   Mo dashboard: http://127.0.0.1:3300
echo  ============================================
echo.
if "%SETUP_NO_OPEN%"=="1" (
  echo  [TEST] BO QUA mo browser.
) else (
  start "" "http://127.0.0.1:3300"
)
exit /b 0
