@echo off
cd /d "%~dp0"
start "" "http://localhost:4204"
set PORT=4204
node server.js
