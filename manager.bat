@echo off
title Quản Lý ChatGPT Local Coder
cd /d "%~dp0"
start "" /min node manager/server.mjs --no-open
exit /b
