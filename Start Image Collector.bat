@echo off
setlocal
title Page Image Collector

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required to run Page Image Collector.
  echo Install the current LTS release from: https://nodejs.org/
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"
if not exist node_modules\express (
  echo Setting up Page Image Collector for the first time...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Setup could not finish. Check your internet connection, then try again.
    echo No browser was downloaded; this app uses your installed Chrome or Edge.
    echo.
    pause
    exit /b 1
  )
)

node server.js
if errorlevel 1 (
  echo.
  echo The app stopped unexpectedly. See the message above for what to fix.
  pause
)
