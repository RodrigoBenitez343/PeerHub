@echo off
rem Launch PeerHub from this folder, in development mode (Vite + the Electron window).
rem Refuses to start a second instance: Vite binds the port below with --strictPort,
rem so a listening port means one is already up - the OS frees it when that window
rem closes, crash or not.
rem Optional args replace the default command, e.g. "run.bat npm run build".

setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=5173"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
	echo [peerhub] port %PORT% is already in use - PeerHub or another app is running there.
	echo Close it first, or change PORT at the top of this file.
	exit /b 1
)

if not exist "node_modules" (
	echo [peerhub] node_modules missing, installing dependencies ...
	call npm install
	if errorlevel 1 exit /b 1
)

if "%~1"=="" (
	call npm run desktop:dev
) else (
	call %*
)

exit /b %ERRORLEVEL%
