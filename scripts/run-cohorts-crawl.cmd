@echo off
REM run-cohorts-crawl.cmd (#2426) — wrapper para a Task agendada do Windows que
REM roda o crawl de coortes de engajamento (clarice-engagement-cohorts.ts) e grava
REM o resultado no KV do clarice-dashboard. Genérico: usa o diretório do próprio
REM .cmd (%~dp0) para achar a raiz do repo; requer `node` no PATH + data/ montado.
REM Registrar (1x por máquina) via schtasks — ver docs/cohorts-schedule.md.
setlocal
cd /d "%~dp0.."
REM node absoluto quando presente (Task Scheduler pode ter PATH reduzido); senão PATH.
set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "data\clarice-subscribers\cohorts" mkdir "data\clarice-subscribers\cohorts"
echo [%date% %time%] ^>^>^> iniciando crawl de coortes>> "data\clarice-subscribers\cohorts\task.log"
"%NODE_EXE%" --import tsx scripts\clarice-engagement-cohorts.ts>> "data\clarice-subscribers\cohorts\task.log" 2>&1
echo [%date% %time%] ^<^<^< fim (exit %ERRORLEVEL%)>> "data\clarice-subscribers\cohorts\task.log"
endlocal
