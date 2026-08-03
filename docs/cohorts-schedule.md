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
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) # 0 = sem limite (#4451/260803, ver racional abaixo)
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
| `-ExecutionTimeLimit (New-TimeSpan -Hours 0)` | **Sem limite** (#4451/260803 — mesmo padrão de `scripts/studio/setup-studio-service.ps1`/`setup-remote-tunnel.ps1` para processos de longa duração). O valor antigo (1h) datava de quando o crawl levava ~22 min com universo de ~21,5k contatos (260624/#2555) — ficou stale sem ser reconciliado quando o universo cresceu pra ~129k: o Windows matava o processo em 1h TODA execução, independente de progresso, o que (junto com `startedAt` do checkpoint nunca sendo atualizado em resume) travava o acúmulo em ~2 disparos diários/~12-14k contatos — causa raiz real do crawl parado em ~7.000/129.251 desde 260729, não só o `MAX_RESUME_AGE_H` antigo (18h). Um limite fixo em horas ficaria obsoleto de novo assim que o universo crescesse mais; sem limite, quem governa o runtime é só o checkpoint (`MAX_RESUME_AGE_H`) e a natureza diária da task. |

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
  interrompido é retomado sem re-gastar GETs no run seguinte (resume se < 30h
  desde a ÚLTIMA atividade, `MAX_RESUME_AGE_H` — aumentado de 18h em
  #4451/260803, o crawl completo leva ~21,5h ESTIMADAS — 129.251 ÷ ~100
  req/min, nunca mediu de verdade porque nunca completou — e o valor antigo
  expirava o checkpoint antes de terminar). A margem de 30h é sobre o
  INTERVALO ENTRE disparos diários da task (1×/dia às 21h), não sobre um
  crawl contínuo: desde #4451 parte 2, `cp.lastResumedAt` é atualizado a cada
  resume bem-sucedido (não só na criação do checkpoint), então o progresso
  sobrevive a N disparos diários consecutivos enquanto o gap entre atividades
  ficar < 30h — antes disso, um checkpoint só sobrevivia ~2 disparos diários
  contados desde a tentativa original, bem menos que os ~22 necessários pra
  completar o crawl em rodadas parciais. Combinado com o
  `-ExecutionTimeLimit` agora sem limite (ver tabela acima), o caso feliz é
  um único disparo completar o crawl inteiro numa execução só — o resume
  multi-dia cobre só os casos em que a máquina cai no meio (sleep/reboot/
  desligamento). Forçar do zero: `--fresh`. Crawl da conta inteira
  (fallback): `--all`.

## Estado (data/ é gitignored)

`data/clarice-subscribers/cohorts/` guarda `checkpoint.json` (some no sucesso),
`status.json` e os logs. Mora no OneDrive junto com o resto de `data/`.

## Redesenho v2 em andamento — Fase 1 + Fase 2 feitas, cutover pendente (#4451)

O crawl per-contato acima (v1) tem um limite estrutural: o universo cresceu
pra ~129k contatos, o que exige ~21,5h ESTIMADAS de crawl contínuo (129.251 ÷
~100 req/min — nunca mediu de verdade porque o crawl nunca completou com
sucesso). O fix de curto prazo (#4451/260803) destrava o caso comum sem
mudar essa realidade estrutural: `-ExecutionTimeLimit` da task deixou de
matar o processo em 1h (agora sem limite) e `MAX_RESUME_AGE_H` do checkpoint
subiu de 18h pra 30h, medido desde a ÚLTIMA atividade (`cp.lastResumedAt`,
atualizado a cada resume — parte 2 do fix) em vez da tentativa original, o
que permite o progresso sobreviver a vários disparos diários consecutivos
quando o crawl não completa numa execução só. `scripts/clarice-engagement-cohorts-v2.ts`
inverte o eixo (export por CAMPANHA via `POST /emailCampaigns/{id}/exportRecipients`
em vez de `GET /contacts/{id}` por contato), com cache permanente por campanha,
janela de re-fetch pra campanhas recentes e o gap de blacklist administrativo
fechado via leitura do store local (`clarice-users.db`, sem custo de API
adicional). `scripts/compare-cohorts.ts` compara o output das duas coortes
campo a campo dentro de uma tolerância.

**SEMPRE dry-run** nesta fase — v2 nunca grava no KV nem toca a task agendada
`DiariaCohortsCrawl` acima. Falta, antes do cutover: rodar v1 e v2 lado a lado
contra a Brevo real (`BREVO_CLARICE_API_KEY`) e comparar via
`scripts/compare-cohorts.ts` — só trocar a task pro v2 depois de baterem
dentro da tolerância. Ver issue #4451 para o plano de execução completo.
