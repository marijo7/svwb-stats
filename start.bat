@echo off
rem svwb-stats launcher for Windows. Double-click this file to start the app.
rem
rem Messages below are intentionally ASCII only: a .bat file with multibyte
rem text is parsed by cmd.exe under the console code page and can break
rem depending on the machine. The Japanese guide lives in README.md.
setlocal
cd /d "%~dp0"

rem Prefer the Python launcher (py), then fall back to python / python3.
rem When Python is missing, "python" is the Microsoft Store alias stub and
rem fails this check, so it is never selected by mistake.
rem
rem The probe is "import sys" and nothing more. Anything with > or ( ) or ,
rem inside the quotes risks being eaten by cmd.exe's parser; the actual
rem version requirement is enforced by svwb.py itself.
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY (python -c "import sys" >nul 2>&1 && set "PY=python")
if not defined PY (python3 -c "import sys" >nul 2>&1 && set "PY=python3")

if not defined PY (
    echo.
    echo   Python 3.9 or newer was not found.
    echo.
    echo   Open the Start menu, search for "Python 3", and install it from
    echo   the Microsoft Store. Then double-click this file again.
    echo.
    echo   See the "Windows" section of README.md for details.
    echo.
    pause
    exit /b 1
)

echo Starting svwb-stats. Close this window ^(or press Ctrl-C^) to stop.
echo.
%PY% svwb.py serve --open
echo.
echo Server stopped.
pause
