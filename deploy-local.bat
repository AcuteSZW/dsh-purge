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
  echo WARNING: source harness was not found nearby.
  echo The plugin dshTarget will remain unchanged.
)
if not exist "%PLUGIN_DIR%\package.json" (
  echo ERROR: plugin package.json is missing.
  exit /b 1
)
if not exist "%PROFILE_DIR%\package.json" (
  echo ERROR: web profile not found: "%PROFILE_DIR%"
  exit /b 1
)

rem Online deployment: update the source link and lockfile only.
rem Do not touch node_modules while DSH may have the plugin loaded.
echo [1/4] Updating local profile manifest...
node "%PLUGIN_DIR%scripts\deploy-local.mjs" "%PLUGIN_DIR%\." "%PROFILE_DIR%"
if errorlevel 1 (
  echo ERROR: deployment preparation failed.
  exit /b 1
)

echo [2/4] Refreshing profile lockfile only...
pushd "%PROFILE_DIR%"
call pnpm install --config.minimum-release-age=0 --lockfile-only
set "LOCK_RC=%ERRORLEVEL%"
popd
if not "%LOCK_RC%"=="0" (
  echo ERROR: profile lockfile update failed.
  exit /b %LOCK_RC%
)

echo [3/4] Verifying source plugin entry import...
pushd "%PLUGIN_DIR%"
node -e "import('./lib/index.js').then(m=>{if(typeof m.apply!=='function')process.exit(2);console.log('source dsh-purge import OK')}).catch(e=>{console.error(e);process.exit(1)})"
set "IMPORT_RC=%ERRORLEVEL%"
popd
if not "%IMPORT_RC%"=="0" (
  echo ERROR: source plugin import check failed.
  exit /b %IMPORT_RC%
)

if defined HARNESS_ROOT (
  echo [4/4] Checking source DSH profile composition...
  pushd "%HARNESS_ROOT%"
  call pnpm run dsh --profile web --dump-config > "%TEMP%\dsh-purge-deploy-dump.log" 2>&1
  set "DUMP_RC=%ERRORLEVEL%"
  popd
  if errorlevel 1 (
    findstr /C:"name: dsh-purge" "%TEMP%\dsh-purge-deploy-dump.log" >nul
    if errorlevel 1 (
      echo ERROR: dsh dump-config failed and dsh-purge is absent from the effective config.
      type "%TEMP%\dsh-purge-deploy-dump.log"
      exit /b %DUMP_RC%
    )
    echo WARNING: dump-config reported unrelated existing profile patch errors.
    echo dsh-purge is present in the effective config; see "%TEMP%\dsh-purge-deploy-dump.log"
  )
  findstr /C:"name: dsh-purge" "%TEMP%\dsh-purge-deploy-dump.log" >nul
  if errorlevel 1 (
    echo ERROR: dsh-purge bundle is missing in effective config.
    type "%TEMP%\dsh-purge-deploy-dump.log"
    exit /b 1
  )
  echo Effective DSH configuration includes dsh-purge.
  echo Restart dsh web when convenient to activate it.
) else (
  echo [4/4] Skipping source DSH config check; checkout not found.
)

echo Online deployment is ready. DSH keeps using its loaded copy until restarted.
echo Restart dsh web when convenient to activate the new plugin version.
exit /b 0
