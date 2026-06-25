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
$action   = New-ScheduledTaskAction  -Execute 'C:\Users\pixel\Projects\diaria-studio\scripts\run-cohorts-crawl.cmd'
$trigger  = New-ScheduledTaskTrigger -Daily -At 9pm
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances Queue `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'DiariaCohortsCrawl' -Action $action -Trigger $trigger `
  -Settings $settings `
  -Description 'Crawl diario de coortes de engajamento Clarice -> KV clarice-dashboard (#2426)' -Force
```

Ajustar o path do `-Execute` ao clone local. O `-At 9pm` é horário local da
máquina (timezone BRT = "E. South America Standard Time").

### Racional de cada flag de energia/concorrência (#2555, incidente 260624)

| Flag | Por quê |
|---|---|
| `-StartWhenAvailable` | Se a máquina dormiu ou estava desligada às 21h, roda assim que voltar (catch-up) em vez de pular o dia inteiro. |
| `-AllowStartIfOnBatteries` | Não bloqueia o disparo quando o notebook estiver na bateria (o comportamento padrão seria não iniciar). |
| `-DontStopIfGoingOnBatteries` | Em 260624 o crawl foi morto às 21:07 (`ERROR_PROCESS_ABORTED 0x8007042B`) porque o notebook desplugou; com esta flag, um crawl já iniciado termina mesmo na bateria (~22 min, tradeoff aceito). |
| `-MultipleInstances Queue` | Substitui `IgnoreNew`; evita o estado "Queued" travado quando um run anterior abortou sem registrar término (instância-fantasma). |
| `-ExecutionTimeLimit (New-TimeSpan -Hours 1)` | Limita o runtime máximo a 1 hora (folga para o crawl atual de ~22 min com universo de ~21,5k contatos crescendo). |

## Re-aplicar numa task já registrada

Para atualizar as settings sem apagar e re-criar a task:

```powershell
$t = Get-ScheduledTask -TaskName 'DiariaCohortsCrawl'
$t.Settings.StartWhenAvailable        = $true
$t.Settings.DisallowStartIfOnBatteries = $false
$t.Settings.StopIfGoingOnBatteries    = $false
$t.Settings.MultipleInstances         = 'Queue'
Set-ScheduledTask -TaskName 'DiariaCohortsCrawl' -Settings $t.Settings
```

Útil quando o snippet `Register-ScheduledTask` foi executado antes do hardening
(incidente 260624 / #2555) ou ao migrar para uma nova máquina com task importada
de backup.

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
