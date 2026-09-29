@echo off
set SOURCE_ENABLED=true
rem start.bat        —— 正常启动
rem start.bat dev    —— 开发模式（node --watch 热重载：改 src/、sdk/ 下代码自动重启）
if "%1"=="dev" (
  pnpm run dev
) else (
  pnpm run start
)
