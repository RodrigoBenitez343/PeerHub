@echo off
rem Launch Ghost Drive from this folder. Refuses to start a second instance:
rem the app always binds its own port (strictPort), so a listening port means
rem one is already up - the OS frees it when that window closes, crash or not.
rem Optional args replace the default command, e.g. "run.bat npm run build".

setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=5173"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
	echo [ghost-drive] port %PORT% is already in use - Ghost Drive or another app is running there.
	echo Close it first, or change PORT at the top of this file.
	exit /b 1
)

if not exist "node_modules" (
	echo [ghost-drive] node_modules missing, installing dependencies ...
	call npm install
	if errorlevel 1 exit /b 1
)

if "%~1"=="" (
	call npm run dev -- --port %PORT% --strictPort
) else (
	call %*
)

exit /b %ERRORLEVEL%
