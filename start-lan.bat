@echo off
rem svwb-stats launcher that also accepts input from phones on the same LAN.
rem Double-click this file instead of start.bat when you want to record
rem matches from your phone. See the "phone" section of README.md.
rem
rem Messages are ASCII only for the same reason as in start.bat: cmd.exe
rem parses .bat files under the console code page and can mangle multibyte
rem text. The Japanese guide lives in README.md.
setlocal
cd /d "%~dp0"

echo.
echo   LAN mode: any device on this network can read and edit your records.
echo   There is no password. Use it on a network you trust ^(home Wi-Fi^).
echo.
echo   Windows will ask whether to allow Python through the firewall.
echo   Tick "Private networks" and allow it, or your phone cannot connect.
echo.
echo   If the phone still cannot connect, opening TCP port 8787 usually
echo   fixes it. See the troubleshooting part of README.md.
echo.

rem The Python detection lives in start.bat; %* is forwarded to svwb.py.
call "%~dp0start.bat" --host 0.0.0.0
