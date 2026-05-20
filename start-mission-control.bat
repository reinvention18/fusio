@echo off
cd /d "%~dp0"

:: Stop any existing instance
pm2 delete mission-control 2>/dev/null

:: Start with PM2 (auto-restarts if it crashes)
pm2 start ecosystem.config.js

:: Save the process list so it survives reboots
pm2 save

echo.
echo Mission Control started with PM2
echo.
echo Commands:
echo   pm2 status                    - Check status
echo   pm2 logs                      - View logs
echo   pm2 restart mission-control   - Restart
echo   pm2 stop mission-control      - Stop
echo.
