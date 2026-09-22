@echo off
cd /d "%~dp0backend"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
