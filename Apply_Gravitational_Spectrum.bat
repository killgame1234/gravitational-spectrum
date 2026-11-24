@echo off
setlocal
set "APP=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"

:: 1. Ensure Antigravity is running with DevTools on port 9222
powershell -NoProfile -Command "try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if errorlevel 1 (
    echo [*] Restarting Antigravity with DevTools port 9222...
    taskkill /F /IM Antigravity.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    set "ELECTRON_RUN_AS_NODE="
    start "" "%APP%" --remote-debugging-port=9222
    powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
    if errorlevel 1 (
        echo [!] Antigravity DevTools port 9222 did not come up in time.
        pause
        exit /b 1
    )
    timeout /t 2 /nobreak >nul
)

:: 2. Start/upgrade the bridge and inject the theme using Electron's embedded Node
set "ELECTRON_RUN_AS_NODE=1"
"%APP%" "%~dp0apply_gravitational_spectrum.mjs"
if errorlevel 1 (
    echo [!] Failed to apply Gravitational Spectrum Theme.
    pause
    exit /b 1
)
echo.
echo [+] Gravitational Spectrum Theme Applied!
timeout /t 3 /nobreak >nul
