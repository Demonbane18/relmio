@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "RELMIO_EXIT_CODE=1"
call :main
set "RELMIO_EXIT_CODE=%errorlevel%"

:cleanup
if defined RELMIO_TEMPORARY_DIRECTORY if exist "%RELMIO_TEMPORARY_DIRECTORY%\" (
  call :remove_temporary_directory "%RELMIO_TEMPORARY_DIRECTORY%"
  if errorlevel 1 (
    call :failure "Could not remove the temporary Node.js runtime. Close programs scanning temporary files and remove the Relmio folder from your temporary-files directory."
    if "%RELMIO_EXIT_CODE%"=="0" set "RELMIO_EXIT_CODE=1"
  )
)
if defined RELMIO_SELF_DELETE if /i "%RELMIO_SELF_DELETE%"=="%~f0" (
  start "" /b "%ComSpec%" /d /q /c ""%SystemRoot%\System32\ping.exe" 127.0.0.1 -n 2 >nul 2>&1 & del /q ^"%~f0^" >nul 2>&1"
)
endlocal & exit /b %RELMIO_EXIT_CODE%

:main
set "RELMIO_SYSTEM32=%SystemRoot%\System32"
set "RELMIO_CURL=%RELMIO_SYSTEM32%\curl.exe"
set "RELMIO_CERTUTIL=%RELMIO_SYSTEM32%\certutil.exe"
set "RELMIO_TAR=%RELMIO_SYSTEM32%\tar.exe"
set "RELMIO_WHERE=%RELMIO_SYSTEM32%\where.exe"
set "RELMIO_FINDSTR=%RELMIO_SYSTEM32%\findstr.exe"
set "RELMIO_TEMPORARY_DIRECTORY="

call :findnode
if not errorlevel 1 goto :use_installed_node
if defined RELMIO_NODE_REJECT_REASON call :message "%RELMIO_NODE_REJECT_REASON%"
goto :portable_runtime

:use_installed_node
call :message "Using installed Node.js %RELMIO_INSTALLED_NODE_VERSION% runtime; starting Relmio without a download."
set "RELMIO_FOREGROUND_WIZARD=1"
call "%RELMIO_INSTALLED_NPX%" --yes --ignore-scripts relmio@latest
set "RELMIO_CHILD_EXIT_CODE=%errorlevel%"
set "RELMIO_FOREGROUND_WIZARD="
exit /b %RELMIO_CHILD_EXIT_CODE%

:portable_runtime
call :needtool "%RELMIO_CURL%" "curl.exe is required to download the temporary Node.js runtime."
if errorlevel 1 exit /b 1
call :needtool "%RELMIO_CERTUTIL%" "certutil.exe is required to verify the temporary Node.js runtime."
if errorlevel 1 exit /b 1
call :needtool "%RELMIO_TAR%" "tar.exe is required to extract the temporary Node.js runtime."
if errorlevel 1 exit /b 1
call :needtool "%RELMIO_WHERE%" "where.exe is required to find an installed Node.js runtime."
if errorlevel 1 exit /b 1
call :needtool "%RELMIO_FINDSTR%" "findstr.exe is required to validate Node.js version and checksum output."
if errorlevel 1 exit /b 1

set "RELMIO_ARCHITECTURE=%PROCESSOR_ARCHITEW6432%"
if not defined RELMIO_ARCHITECTURE set "RELMIO_ARCHITECTURE=%PROCESSOR_ARCHITECTURE%"
if /i "%RELMIO_ARCHITECTURE%"=="AMD64" set "RELMIO_NODE_ARCHITECTURE=x64"
if /i "%RELMIO_ARCHITECTURE%"=="ARM64" set "RELMIO_NODE_ARCHITECTURE=arm64"
if not defined RELMIO_NODE_ARCHITECTURE (
  call :failure "Unsupported CPU architecture. Relmio supports Windows x64 and ARM64."
  exit /b 1
)

set "RELMIO_TEMPORARY_DIRECTORY=%TEMP%\relmio-%RANDOM%%RANDOM%%RANDOM%"
mkdir "%RELMIO_TEMPORARY_DIRECTORY%" >nul 2>&1
if errorlevel 1 (
  call :failure "Could not create a temporary directory for the Node.js runtime."
  exit /b 1
)

set "RELMIO_NODE_VERSION=v24.22.1"
set "RELMIO_ARCHIVE_NAME=node-%RELMIO_NODE_VERSION%-win-%RELMIO_NODE_ARCHITECTURE%.zip"
set "RELMIO_EXPECTED_CHECKSUM="
if /i "%RELMIO_NODE_ARCHITECTURE%"=="x64" set "RELMIO_EXPECTED_CHECKSUM=d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5"
if /i "%RELMIO_NODE_ARCHITECTURE%"=="arm64" set "RELMIO_EXPECTED_CHECKSUM=a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171"
if not defined RELMIO_EXPECTED_CHECKSUM (
  call :failure "No reviewed Node.js checksum is available for this architecture."
  exit /b 1
)
set "RELMIO_ARCHIVE_PATH=%RELMIO_TEMPORARY_DIRECTORY%\%RELMIO_ARCHIVE_NAME%"
set "RELMIO_ARCHIVE_URL=https://nodejs.org/download/release/%RELMIO_NODE_VERSION%/%RELMIO_ARCHIVE_NAME%"
call :message "[1/4] Installing a temporary Node.js 24 runtime. Please wait; this does not install Node.js system-wide."
call :message "[2/4] Downloading the reviewed official Node.js runtime. Please wait..."
call :download "%RELMIO_ARCHIVE_URL%" "%RELMIO_ARCHIVE_PATH%"
if errorlevel 1 (
  call :failure "Could not download the official Node.js runtime. Check your HTTPS connection and try again."
  exit /b 1
)

call :message "[3/4] Verifying the Node.js SHA-256 checksum. Please wait..."
set "RELMIO_HASH_OUTPUT=%RELMIO_TEMPORARY_DIRECTORY%\runtime-sha256.txt"
"%RELMIO_CERTUTIL%" -hashfile "%RELMIO_ARCHIVE_PATH%" SHA256 > "%RELMIO_HASH_OUTPUT%"
if errorlevel 1 (
  call :failure "certutil.exe could not calculate the Node.js SHA-256 checksum; nothing was executed."
  exit /b 1
)
set "RELMIO_ACTUAL_CHECKSUM="
set "RELMIO_HASH_MATCHES=0"
for /f "usebackq tokens=1" %%A in ("%RELMIO_HASH_OUTPUT%") do (
  call :checksum "%%A"
  if not errorlevel 1 (
    set /a RELMIO_HASH_MATCHES+=1
    set "RELMIO_ACTUAL_CHECKSUM=%%A"
  )
)
if not "%RELMIO_HASH_MATCHES%"=="1" (
  call :failure "certutil.exe returned an invalid Node.js SHA-256 checksum; nothing was executed."
  exit /b 1
)
call :checksum "%RELMIO_ACTUAL_CHECKSUM%"
if errorlevel 1 (
  call :failure "certutil.exe returned an invalid Node.js SHA-256 checksum; nothing was executed."
  exit /b 1
)
if /i not "%RELMIO_ACTUAL_CHECKSUM%"=="%RELMIO_EXPECTED_CHECKSUM%" (
  call :failure "Node.js download checksum did not match; nothing was executed."
  exit /b 1
)

call :message "Verified Node.js download."
call :message "[4/4] Extracting the verified temporary Node.js 24 runtime. Please wait..."
"%RELMIO_TAR%" -xf "%RELMIO_ARCHIVE_PATH%" -C "%RELMIO_TEMPORARY_DIRECTORY%"
if errorlevel 1 (
  call :failure "tar.exe could not extract the verified Node.js runtime."
  exit /b 1
)

set "RELMIO_RUNTIME_DIRECTORY=%RELMIO_TEMPORARY_DIRECTORY%\%RELMIO_ARCHIVE_NAME:.zip=%"
set "RELMIO_NODE_BINARY=%RELMIO_RUNTIME_DIRECTORY%\node.exe"
set "RELMIO_NPX_CLI=%RELMIO_RUNTIME_DIRECTORY%\node_modules\npm\bin\npx-cli.js"
if not exist "%RELMIO_NODE_BINARY%" (
  call :failure "The verified Node.js archive did not contain its runtime."
  exit /b 1
)
if not exist "%RELMIO_NPX_CLI%" (
  call :failure "The verified Node.js archive did not contain npm."
  exit /b 1
)

call :message "Starting the newest Relmio wizard."
set "PATH=%RELMIO_RUNTIME_DIRECTORY%;%PATH%"
set "RELMIO_FOREGROUND_WIZARD=1"
"%RELMIO_NODE_BINARY%" "%RELMIO_NPX_CLI%" --yes --ignore-scripts relmio@latest
set "RELMIO_CHILD_EXIT_CODE=%errorlevel%"
set "RELMIO_FOREGROUND_WIZARD="
exit /b %RELMIO_CHILD_EXIT_CODE%

:findnode
set "RELMIO_INSTALLED_NODE="
set "RELMIO_INSTALLED_NPX="
set "RELMIO_INSTALLED_NODE_VERSION="
if not exist "%RELMIO_WHERE%" exit /b 1
for /f "usebackq delims=" %%P in (`"%RELMIO_WHERE%" node.exe 2^>nul`) do (
  call :nodeok "%%~fP"
  if not errorlevel 1 (
    set "RELMIO_INSTALLED_NODE=%%~fP"
    call set "RELMIO_INSTALLED_NODE_VERSION=%%RELMIO_SUPPORTED_NODE_VERSION%%"
    goto :find_installed_npx
  )
)
exit /b 1

:find_installed_npx
for /f "usebackq delims=" %%P in (`"%RELMIO_WHERE%" npx.cmd 2^>nul`) do (
  set "RELMIO_INSTALLED_NPX=%%~fP"
  goto :installed_runtime_found
)
exit /b 1

:installed_runtime_found
if not defined RELMIO_INSTALLED_NODE exit /b 1
if not defined RELMIO_INSTALLED_NPX exit /b 1
exit /b 0

:nodeok
setlocal DisableDelayedExpansion
set "RELMIO_NODE_VERSION="
for /f "usebackq delims=" %%V in (`"%~1" --version 2^>nul`) do if not defined RELMIO_NODE_VERSION set "RELMIO_NODE_VERSION=%%V"
if not defined RELMIO_NODE_VERSION endlocal & exit /b 1
echo(%RELMIO_NODE_VERSION%| "%RELMIO_FINDSTR%" /r /x "v[1-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 endlocal & exit /b 1
for /f "tokens=1,2,3 delims=." %%A in ("%RELMIO_NODE_VERSION:~1%") do (
  set "RELMIO_NODE_MAJOR=%%A"
  set "RELMIO_NODE_MINOR=%%B"
  set "RELMIO_NODE_PATCH=%%C"
)
set /a RELMIO_NODE_MAJOR_NUMBER=RELMIO_NODE_MAJOR >nul 2>&1
if errorlevel 1 endlocal & exit /b 1
set /a RELMIO_NODE_MINOR_NUMBER=RELMIO_NODE_MINOR >nul 2>&1
if errorlevel 1 endlocal & exit /b 1
set /a RELMIO_NODE_PATCH_NUMBER=RELMIO_NODE_PATCH >nul 2>&1
if errorlevel 1 endlocal & exit /b 1
set "RELMIO_NODE_REUSABLE=0"
if %RELMIO_NODE_MAJOR_NUMBER% EQU 24 if %RELMIO_NODE_MINOR_NUMBER% GTR 22 set "RELMIO_NODE_REUSABLE=1"
if %RELMIO_NODE_MAJOR_NUMBER% EQU 24 if %RELMIO_NODE_MINOR_NUMBER% EQU 22 if %RELMIO_NODE_PATCH_NUMBER% GEQ 1 set "RELMIO_NODE_REUSABLE=1"
if %RELMIO_NODE_MAJOR_NUMBER% EQU 26 if %RELMIO_NODE_MINOR_NUMBER% GTR 12 set "RELMIO_NODE_REUSABLE=1"
if %RELMIO_NODE_MAJOR_NUMBER% EQU 26 if %RELMIO_NODE_MINOR_NUMBER% EQU 12 if %RELMIO_NODE_PATCH_NUMBER% GEQ 1 set "RELMIO_NODE_REUSABLE=1"
if "%RELMIO_NODE_REUSABLE%"=="1" endlocal & set "RELMIO_SUPPORTED_NODE_VERSION=%RELMIO_NODE_VERSION%" & exit /b 0
set "RELMIO_NODE_REJECT_REASON=Installed Node.js %RELMIO_NODE_VERSION% is not a patched runtime Relmio can reuse; using a verified temporary runtime."
if %RELMIO_NODE_MAJOR_NUMBER% LSS 24 set "RELMIO_NODE_REJECT_REASON=Installed Node.js %RELMIO_NODE_VERSION% is older than the patched 24.22.1; using a verified temporary runtime."
if %RELMIO_NODE_MAJOR_NUMBER% EQU 24 set "RELMIO_NODE_REJECT_REASON=Installed Node.js %RELMIO_NODE_VERSION% is older than the patched 24.22.1; using a verified temporary runtime."
if %RELMIO_NODE_MAJOR_NUMBER% EQU 25 set "RELMIO_NODE_REJECT_REASON=Installed Node.js %RELMIO_NODE_VERSION% is an end-of-life release with no security patch; using a verified temporary runtime."
if %RELMIO_NODE_MAJOR_NUMBER% EQU 26 set "RELMIO_NODE_REJECT_REASON=Installed Node.js %RELMIO_NODE_VERSION% is older than the patched 26.12.1; using a verified temporary runtime."
endlocal & set "RELMIO_NODE_REJECT_REASON=%RELMIO_NODE_REJECT_REASON%" & exit /b 1

:checksum
setlocal DisableDelayedExpansion
set "RELMIO_CHECKSUM=%~1"
if "%RELMIO_CHECKSUM:~63,1%"=="" endlocal & exit /b 1
if not "%RELMIO_CHECKSUM:~64,1%"=="" endlocal & exit /b 1
echo(%RELMIO_CHECKSUM%| "%RELMIO_FINDSTR%" /r /x "[0-9A-Fa-f][0-9A-Fa-f]*" >nul
if errorlevel 1 endlocal & exit /b 1
endlocal & exit /b 0

:archive
setlocal DisableDelayedExpansion
set "RELMIO_CANDIDATE_ARCHIVE=%~1"
set "RELMIO_CANDIDATE_ARCHITECTURE=%~2"
echo(%RELMIO_CANDIDATE_ARCHIVE%| "%RELMIO_FINDSTR%" /r /x "node-v24\.[0-9][0-9]*\.[0-9][0-9]*-win-%RELMIO_CANDIDATE_ARCHITECTURE%\.zip" >nul
if errorlevel 1 endlocal & exit /b 1
endlocal & exit /b 0

:needtool
if exist "%~1" exit /b 0
call :failure "%~2"
exit /b 1

:remove_temporary_directory
setlocal
set "RELMIO_REMOVE_ATTEMPTS=0"
:remove_temporary_directory_retry
rmdir /s /q "%~1" >nul 2>&1
if not exist "%~1\" endlocal & exit /b 0
set /a RELMIO_REMOVE_ATTEMPTS+=1 >nul
if %RELMIO_REMOVE_ATTEMPTS% GEQ 3 endlocal & exit /b 1
"%SystemRoot%\System32\ping.exe" 127.0.0.1 -n 2 -w 1000 >nul 2>&1
goto :remove_temporary_directory_retry

:download
"%RELMIO_CURL%" --fail --silent --show-error --proto "=https" --proto-redir "=https" --max-redirs 0 --connect-timeout 15 --max-time 600 --retry 2 --retry-delay 1 "%~1" -o "%~2"
exit /b %errorlevel%

:message
echo Relmio installer: %~1
exit /b 0

:failure
>&2 echo Relmio installer: %~1
exit /b 1
