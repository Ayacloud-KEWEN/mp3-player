@echo off
rem 电脑上启动 Lyra（开启生成字幕/翻译工具），然后用浏览器打开 http://localhost:10020
cd /d "%~dp0"
set ENABLE_TOOLS=1
start "" http://localhost:10020
node server.js
