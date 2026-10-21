@echo off
setlocal
cd /d "%~dp0"

set "PLUGIN_DIR=%~dp0"
set "PROFILE_DIR=%USERPROFILE%\.dsh\profiles\web"
for %%I in ("%PROFILE_DIR%") do set "PROFILE_DIR=%%~fI"
set "HARNESS_ROOT="
for %%I in ("%PLUGIN_DIR%..\..\deepseek-harness") do set "HARNESS_CANDIDATE=%%~fI"
if exist "%HARNESS_CANDIDATE%\package.json" set "HARNESS_ROOT=%HARNESS_CANDIDATE%"
if not defined HARNESS_ROOT (
  for %%I in ("%PLUGIN_DIR%..\deepseek-harness") do set "HARNESS_CANDIDATE=%%~fI"
  if exist "%HARNESS_CANDIDATE%\package.json" set "HARNESS_ROOT=%HARNESS_CANDIDATE%"
)
if not defined HARNESS_ROOT (
  echo WARNING: source harness was not found in the plugin's nearby folders.
  echo The script will retain the plugin's existing dshTarget.
)
if not exist "%PLUGIN_DIR%\package.json" (
  echo ERROR: plugin package.json is missing.
  exit /b 1
)
if not exist "%PROFILE_DIR%\package.json" (
  echo ERROR: web profile not found: "%PROFILE_DIR%"
  exit /b 1
)

rem Never replace profile node_modules while dsh web is running.
netstat -ano | findstr /R /C:":3080 .*LISTENING" >nul
if not errorlevel 1 (
  echo ERROR: dsh web is listening on port 3080.
  echo Stop dsh web normally, then rerun this script.
  exit /b 1
)

node "%PLUGIN_DIR%scripts\deploy-local.mjs" "%PLUGIN_DIR%\." "%PROFILE_DIR%"
if errorlevel 1 (
  echo ERROR: deployment preparation failed.
  exit /b 1
)

echo [1/4] Installing profile dependencies...
pushd "%PROFILE_DIR%"
pnpm install --config.minimum-release-age=0 --ignore-scripts
set "INSTALL_RC=%ERRORLEVEL%"
popd
if not "%INSTALL_RC%"=="0" (
  echo ERROR: pnpm install failed. Close dsh web and retry.
  exit /b %INSTALL_RC%
)

echo [2/4] Verifying plugin entry import...
pushd "%PROFILE_DIR%"
node -e "import('dsh-purge').then(m=>{if(typeof m.apply!=='function')process.exit(2);console.log('dsh-purge import OK')}).catch(e=>{console.error(e);process.exit(1)})"
set "IMPORT_RC=%ERRORLEVEL%"
popd
if not "%IMPORT_RC%"=="0" (
  echo ERROR: plugin import check failed.
  exit /b %IMPORT_RC%
)

if defined HARNESS_ROOT (
  echo [3/4] Checking source DSH profile composition...
  pushd "%HARNESS_ROOT%"
  call pnpm run dsh --profile web --dump-config > "%TEMP%\dsh-purge-deploy-dump.log" 2>&1
  set "DUMP_RC=%ERRORLEVEL%"
  popd
  if not "%DUMP_RC%"=="0" (
    echo ERROR: dsh dump-config failed. See "%TEMP%\dsh-purge-deploy-dump.log"
    type "%TEMP%\dsh-purge-deploy-dump.log"
    exit /b %DUMP_RC%
  )
  findstr /C:"name: dsh-purge" "%TEMP%\dsh-purge-deploy-dump.log" >nul
  if errorlevel 1 (
    echo ERROR: dsh-purge bundle is not present in effective config.
    type "%TEMP%\dsh-purge-deploy-dump.log"
    exit /b 1
  )
  echo Effective DSH configuration includes dsh-purge.
) else (
  echo [3/4] Source harness check skipped; no HARNESS_ROOT.
)

echo [4/4] Deployment prepared and verified.
echo Fully stop and restart dsh web to load the new plugin code.
echo This script does not kill or restart your running DSH process.
exit /b 0
