# Agendamento do crawl de coortes de engajamento (#2426)

A tabela de **Coortes de engajamento** do clarice-dashboard é um snapshot
pré-computado: o dashboard só lê o KV; quem popula é
`scripts/clarice-engagement-cohorts.ts` (crawl per-contato na Brevo → KV). Sem
rodar o script de novo, a tabela fica congelada (a seção mostra "Pré-computado às
… BRT" pra deixar a idade do dado explícita).

Decisão (2026-06-19): rodar **diariamente às 21:00 BRT** via **agendador local do
Windows** — o crawl depende das secrets do `.env` desta máquina
(`BREVO_CLARICE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_TOKEN`),
que uma rotina em nuvem não teria. Requer a máquina ligada e o usuário logado às 21h.

## Wrapper

`scripts/run-cohorts-crawl.cmd` — genérico (acha a raiz do repo via `%~dp0`),
preferindo `C:\Program Files\nodejs\node.exe` com fallback pro `node` do PATH (Task
Scheduler às vezes tem PATH reduzido). Cria o diretório de estado se preciso e
acrescenta stdout/stderr a `data/clarice-subscribers/cohorts/task.log`.

## Registrar a Task (1× por máquina)

```powershell
$action  = New-ScheduledTaskAction  -Execute 'C:\Users\pixel\Projects\diaria-studio\scripts\run-cohorts-crawl.cmd'
$trigger = New-ScheduledTaskTrigger -Daily -At 9pm
Register-ScheduledTask -TaskName 'DiariaCohortsCrawl' -Action $action -Trigger $trigger `
  -Description 'Crawl diario de coortes de engajamento Clarice -> KV clarice-dashboard (#2426)' -Force
```

Ajustar o path do `-Execute` ao clone local. O `-At 9pm` é horário local da
máquina (timezone BRT = "E. South America Standard Time").

## Operação

- **Disparar manualmente:** `Start-ScheduledTask -TaskName 'DiariaCohortsCrawl'`
  (ou rodar o script direto: `npx tsx scripts/clarice-engagement-cohorts.ts`).
- **Próxima execução:** `Get-ScheduledTask DiariaCohortsCrawl | Get-ScheduledTaskInfo`.
- **Status do último run:** `data/clarice-subscribers/cohorts/status.json`
  (`success | partial | failed` + contagens + duração).
- **Logs:** `data/clarice-subscribers/cohorts/run.log` (do script) e `task.log`
  (do wrapper).
- **Rate-limit / interrupção:** o script faz checkpoint incremental; um run
  interrompido é retomado sem re-gastar GETs no run seguinte (resume se < 18h).
  Forçar do zero: `--fresh`. Crawl da conta inteira (fallback): `--all`.

## Estado (data/ é gitignored)

`data/clarice-subscribers/cohorts/` guarda `checkpoint.json` (some no sucesso),
`status.json` e os logs. Mora no OneDrive junto com o resto de `data/`.
