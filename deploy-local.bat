@echo off
chcp 65001 >nul
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
  echo [警告] 附近没找到 deepseek-harness 源码目录。
  echo        插件 dshTarget 保持原样，不做改动。
)
if not exist "%PLUGIN_DIR%\package.json" (
  echo [错误] 缺少插件 package.json。
  pause
  exit /b 1
)
if not exist "%PROFILE_DIR%\package.json" (
  echo [错误] 找不到 web profile："%PROFILE_DIR%"
  pause
  exit /b 1
)

rem 在线部署：只更新源码链接和 lockfile，
rem 不碰 node_modules（DSH 可能正在加载本插件）。
echo [1/4] 更新本地 profile 清单...
node "%PLUGIN_DIR%scripts\deploy-local.mjs" "%PLUGIN_DIR%\." "%PROFILE_DIR%"
if errorlevel 1 (
  echo [错误] 部署准备失败。
  pause
  exit /b 1
)

echo [2/4] 仅刷新 profile lockfile...
pushd "%PROFILE_DIR%"
call pnpm install --config.minimum-release-age=0 --lockfile-only
set "LOCK_RC=%ERRORLEVEL%"
popd
if not "%LOCK_RC%"=="0" (
  echo [错误] profile lockfile 更新失败。
  pause
  exit /b %LOCK_RC%
)

echo [3/4] 校验插件入口能否正常导入...
pushd "%PLUGIN_DIR%"
node -e "import('./lib/index.js').then(m=>{if(typeof m.apply!=='function')process.exit(2);console.log('source dsh-purge import OK')}).catch(e=>{console.error(e);process.exit(1)})"
set "IMPORT_RC=%ERRORLEVEL%"
popd
if not "%IMPORT_RC%"=="0" (
  echo [错误] 插件入口导入校验失败。
  pause
  exit /b %IMPORT_RC%
)

if defined HARNESS_ROOT (
  echo [4/4] 检查 DSH profile 实际加载情况...
  pushd "%HARNESS_ROOT%"
  call pnpm run dsh --profile web --dump-config > "%TEMP%\dsh-purge-deploy-dump.log" 2>&1
  set "DUMP_RC=%ERRORLEVEL%"
  popd
  if errorlevel 1 (
    findstr /C:"name: dsh-purge" "%TEMP%\dsh-purge-deploy-dump.log" >nul
    if errorlevel 1 (
      echo [错误] dsh dump-config 失败，且 dsh-purge 未出现在生效配置里。
      type "%TEMP%\dsh-purge-deploy-dump.log"
      pause
      exit /b %DUMP_RC%
    )
    echo [警告] dump-config 报了一些与 dsh-purge 无关的既有 profile patch 错误。
    echo        dsh-purge 已在生效配置中，详见："%TEMP%\dsh-purge-deploy-dump.log"
  )
  findstr /C:"name: dsh-purge" "%TEMP%\dsh-purge-deploy-dump.log" >nul
  if errorlevel 1 (
    echo [错误] 生效配置里缺少 dsh-purge。
    type "%TEMP%\dsh-purge-deploy-dump.log"
    pause
    exit /b 1
  )
  echo     生效配置已包含 dsh-purge。
  echo     方便时重启 dsh web 即可加载新版本。
) else (
  echo [4/4] 跳过 DSH 配置检查（未找到源码目录）。
)

echo.
echo ============================================
echo  部署成功！DSH 当前仍在用旧副本，
echo  方便时重启 dsh web 即可生效新版本。
echo ============================================
pause
exit /b 0