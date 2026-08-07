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
where node >nul 2>nul
if errorlevel 1 (
  echo  [LOI] Chua cai Node.js! Tai ve: https://nodejs.org
  echo        Sau khi cai xong, chay lai file nay.
  pause
  exit /b 1
)
for /f "usebackq delims=" %%v in (`node -p "parseInt(process.versions.node.split('.')[0],10)"`) do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo  [LOI] Khong doc duoc Node version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo  [LOI] Can Node.js 22+, ban dang co %NODE_MAJOR%. Tai moi: https://nodejs.org
  pause
  exit /b 1
)
echo  [OK] Node.js %NODE_MAJOR%+ da san sang.

REM ---- 2. Cai thu vien (npm install) neu thieu ----
if not exist node_modules (
  echo  [..] Dang cai thu vien ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo  [LOI] npm install that bai. Xem loi o tren.
    pause
    exit /b 1
  )
) else (
  echo  [OK] Thu vien da co san.
)

REM ---- 3. Build TypeScript neu thieu dist ----
if not exist dist\index.js (
  echo  [..] Dang build ^(npm run build^)...
  call npm run build
  if errorlevel 1 (
    echo  [LOI] Build that bai. Xem loi o tren.
    pause
    exit /b 1
  )
) else (
  echo  [OK] Build da co san.
)

REM ---- 4. Cai autostart (Startup folder) ----
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\ChatGPT Local Coder Manager.lnk"

if exist "%LNK%" (
  echo  [OK] Autostart da duoc cai san.
) else (
  echo  [..] Dang cai autostart khi dang nhap...
  call :create_lnk
  if exist "%LNK%" (
    echo  [OK] Da cai autostart.
  ) else (
    echo  [LOI] Khong cai duoc autostart. Tu tao shortcut manager.bat vao Startup.
  )
)
goto :after_autostart

:create_lnk
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%LNK%'); $s.TargetPath='%~dp0manager.bat'; $s.WorkingDirectory='%~dp0'; $s.Description='ChatGPT Local Coder Manager'; $s.Save()"
exit /b 0

:after_autostart
REM ---- 5. Khoi dong manager (neu chua chay) + mo dashboard ----
echo  [..] Dang kiem tra manager tai http://127.0.0.1:3300 ...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3300/api/health' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo  [..] Manager chua chay - dang khoi dong...
  start "" /min "%~dp0manager.bat"
  timeout /t 3 /nobreak >nul
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
