@echo off
REM run-diaria-dashboard-push.cmd (#2471) — wrapper para a Task agendada do Windows que
REM agrega as fontes de dados locais e faz push pro KV do Worker `diaria-dashboard`.
REM Genérico: usa o diretório do próprio .cmd (%~dp0) para achar a raiz do repo;
REM requer `node` no PATH + data/ montado + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN.
REM Registrar (1x por máquina) via schtasks — ver docs/dashboard-schedule.md.
setlocal
cd /d "%~dp0.."
REM node absoluto quando presente (Task Scheduler pode ter PATH reduzido); senão PATH.
set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "data\dashboard-push" mkdir "data\dashboard-push"
echo [%date% %time%] ^>^>^> iniciando push dashboard>> "data\dashboard-push\task.log"
REM #3042: regenera data\link-ctr-table.csv ANTES do push — sem isso o CSV fica
REM stale indefinidamente (nenhuma outra task o reconstrói) e o join de CTR de
REM Use Melhor/top-links/audience degrada silenciosamente. Fail-soft de propósito:
REM build-link-ctr.ts escreve o CSV com um único writeFileSync no final (tudo em
REM memória até lá), então uma falha aqui NÃO corrompe o CSV existente — só o
REM deixa tão fresco quanto estava. Por isso não abortamos o push se este passo
REM falhar; só logamos o exit code pra visibilidade.
echo [%date% %time%] --- rebuild link-ctr-table.csv --->> "data\dashboard-push\task.log"
"%NODE_EXE%" --import tsx scripts\build-link-ctr.ts >> "data\dashboard-push\task.log" 2>&1
echo [%date% %time%] link-ctr-table.csv rebuild exit %ERRORLEVEL% (fail-soft, prosseguindo)>> "data\dashboard-push\task.log"
REM Espaço antes do >> é OBRIGATÓRIO: o namespace ID termina em dígito ("...de3"),
REM e em CMD "3>>" é redirect do file-descriptor 3 (não append de stdout). Sem o
REM espaço, stdout/stderr do node sumiriam (iriam pro fd 3, não pro task.log).
"%NODE_EXE%" --import tsx scripts\build-diaria-dashboard-data.ts --push --kv-namespace-id 4610c3016818483cab141f459a963de3 >> "data\dashboard-push\task.log" 2>&1
REM captura o exit do node ANTES do echo (que reseta %ERRORLEVEL% p/ 0) e propaga
REM via `endlocal & exit /b` — senão a Task Scheduler veria sempre "sucesso" (#2426 review).
set "NODE_EXIT=%ERRORLEVEL%"
echo [%date% %time%] ^<^<^< fim (exit %NODE_EXIT%)>> "data\dashboard-push\task.log"
endlocal & exit /b %NODE_EXIT%
