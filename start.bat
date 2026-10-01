@echo off
if "%1"=="dev" (
  pnpm run dev
) else (
  pnpm run start
)
