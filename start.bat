@echo off
rem Pipe Spool Tool - Windows launcher. First run creates a virtual environment
rem and installs the dependencies (needs Python 3.10 - 3.13 on PATH).
cd /d "%~dp0"
if not exist .venv (
  echo Creating Python environment, this takes a few minutes the first time...
  python -m venv .venv || goto :error
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt || goto :error
)
.venv\Scripts\python run.py %*
goto :eof
:error
echo.
echo Setup failed. Check that Python 3.10-3.13 is installed and on PATH.
pause
