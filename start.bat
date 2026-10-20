@echo off
rem D.E.N.N.I.S. - run from source on Windows. Double-click this file.
rem First run installs dependencies (a few hundred MB, a few minutes).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS version from https://nodejs.org
  echo   or run:  winget install OpenJS.NodeJS.LTS
  echo   then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo   First run: installing dependencies. This takes a few minutes and is not stuck.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed - the reason is above.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
