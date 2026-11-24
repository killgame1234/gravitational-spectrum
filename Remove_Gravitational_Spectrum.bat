@echo off
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" "%~dp0apply_gravitational_spectrum.mjs" --off
echo.
echo [+] Gravitational Spectrum Theme Removed!
ping 127.0.0.1 -n 3 >nul
