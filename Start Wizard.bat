@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.22.1 or newer, or Node.js 26.12.1 or newer, is required.
  echo Install it from https://nodejs.org/ and double-click this file again.
  pause
  exit /b 1
)

node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); const ok=(major===24&&(minor>22||(minor===22&&patch>=1)))||(major===26&&(minor>12||(minor===12&&patch>=1))); process.exit(ok?0:1)"
if errorlevel 1 (
  echo Your Node.js version is too old. Node.js 24.22.1 or newer, or Node.js 26.12.1 or newer, is required.
  echo Update it from https://nodejs.org/ and double-click this file again.
  pause
  exit /b 1
)

:node_ready
if not exist "node_modules\ssh2" (
  echo Preparing the local setup wizard...
  call npm ci --ignore-scripts
  if errorlevel 1 (
    echo The wizard could not install its local dependency.
    pause
    exit /b 1
  )
)

call npm start
set "WIZARD_STATUS=%ERRORLEVEL%"

if not "%WIZARD_STATUS%"=="0" (
  echo The local wizard stopped.
  pause
)

exit /b %WIZARD_STATUS%
