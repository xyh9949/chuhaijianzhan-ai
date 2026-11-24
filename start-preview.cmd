@echo off
cd /d "%~dp0"
if not exist node_modules call npm ci
if errorlevel 1 goto end
if not exist .env.local call npm run setup
if errorlevel 1 goto end
if not exist .next\BUILD_ID call npm run build
if errorlevel 1 goto end
call npm start
:end
pause
