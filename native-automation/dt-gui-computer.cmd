@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if defined DT_GUI_COMPUTER_NODE (
  set "NODE_BIN=%DT_GUI_COMPUTER_NODE%"
) else if exist "%SCRIPT_DIR%..\runtime\node.exe" (
  set "NODE_BIN=%SCRIPT_DIR%..\runtime\node.exe"
) else if exist "%SCRIPT_DIR%..\desktop\runtime\node.exe" (
  set "NODE_BIN=%SCRIPT_DIR%..\desktop\runtime\node.exe"
) else (
  set "NODE_BIN=node.exe"
)
"%NODE_BIN%" "%SCRIPT_DIR%dist\cli.js" %*
exit /b %ERRORLEVEL%
