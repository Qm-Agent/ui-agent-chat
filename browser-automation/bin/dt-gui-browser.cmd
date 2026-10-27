@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "RUNTIME=node"
if defined DT_GUI_BROWSER_NODE set "RUNTIME=%DT_GUI_BROWSER_NODE%"
:parse_global
if "%~1"=="--node" (
  if "%~2"=="" exit /b 2
  set "RUNTIME=%~2"
  shift
  shift
  goto parse_global
)
if "%~1"=="--runtime-home" (
  if "%~2"=="" exit /b 2
  set "DT_GUI_BROWSER_HOME=%~2"
  shift
  shift
  goto parse_global
)
set ELECTRON_RUN_AS_NODE=1
"%RUNTIME%" "%SCRIPT_DIR%..\cli.mjs" %*
