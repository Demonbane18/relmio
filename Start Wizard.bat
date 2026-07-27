@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Install it from https://nodejs.org/ and double-click this file again.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% GEQ 22 goto node_ready
echo Your Node.js version is too old. Version 22 or newer is required.
echo Update it from https://nodejs.org/ and double-click this file again.
pause
exit /b 1

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
