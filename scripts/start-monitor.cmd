@echo off
rem Start Dropwatch Monitor locally and restart it if it exits unexpectedly.
rem Double-click this file, or run it from any folder. Stop with Ctrl+C, then answer Y.
rem Settings come from .env in the project folder; the watchlist and history live in data\monitor\.
cd /d "%~dp0.."
title Dropwatch Monitor
:run
echo [%date% %time%] Starting Dropwatch Monitor (http://127.0.0.1:4200)
call npm run monitor
echo [%date% %time%] Monitor exited with code %errorlevel%. Restarting in 30 seconds (Ctrl+C to stop).
timeout /t 30 /nobreak >nul
goto run
