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

## Cutover para v2 (#4451, 260811) — task registrada, KV do dashboard ATUALIZA via --push (#5015)

Decisão do editor (260811): trocar a task agendada para o v2 agora, **sem**
o período de sobreposição v1×v2 previsto no item 6 do plano original da
issue (pulado deliberadamente). Achado ao verificar o estado real desta
máquina: `DiariaCohortsCrawl` (a task Windows acima, v1) **nunca existiu**
no registro declarativo (`scripts/lib/scheduled-tasks.ts`) nem como timer
systemd — então não é uma troca de ponteiro de uma task existente, é
**registro do zero** já apontando pro v2. `Diaria-Clarice-Cohorts-Crawl`
(nome escolhido seguindo o padrão hifenizado dominante do registro, `Diaria-X-Y`)
roda `scripts/clarice-engagement-cohorts-v2.ts --push --out data/clarice-subscribers/cohorts/v2-latest.json`
diariamente às 21:00 BRT (mesmo horário histórico do v1 acima, sem colisão
com nenhuma outra daily do registro). O `--push` foi adicionado em #5015
(260811) — antes disso o step só passava `--out` (ver "ATENÇÃO" abaixo, texto
histórico mantido pra registrar o gap que existiu entre 260811 (registro da
task) e o fechamento do #5015 na mesma data).

**Armar de verdade (ação do coordenador/editor, sessão local, fora desta
unidade — #4451):**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Cohorts-Crawl
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-cohorts-crawl.timer
```

**ATENÇÃO (histórico — fechado em #5015, mesmo dia 260811):** por um período
curto dentro do próprio 260811, entre o registro desta task e o fechamento
do #5015, o gap abaixo existiu de fato. `clarice-engagement-cohorts-v2.ts`
era **sempre dry-run por design** (sem flag `--push`/`--kv`): a task só
refrescava o artefato local `--out`, **nunca gravava a chave
`cohorts:engagement`** do KV que `clarice-dashboard` lê — só o v1
(`clarice-engagement-cohorts.ts`, sem `--dry-run`) escrevia nessa chave, e o
v1 não tinha task agendada nesta máquina. **Estado atual, pós-#5015:** v2
ganhou a flag `--push` (`pushCohortsToKV`, mesma proteção anti-clobber do
v1 — nunca sobrescreve `cohorts:engagement` com universe=0), e o step desta
task já passa `--push` (ver comando acima) — o snapshot "Coortes de
engajamento" do dashboard volta a atualizar a cada disparo (21:00 BRT), sem
depender de rodada manual do v1.

## Redesenho v2 — design VALIDADO (#4451, 260810); histórico da decisão de cutover (ver seção acima para o estado atual da task)

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

**Dry-run por padrão; `--push` grava no KV (#5015)** — v2 nasceu sempre
dry-run; isso mudou em #5015 (260811, ver seção "Cutover para v2" acima),
que portou a proteção anti-clobber do v1 atrás da flag `--push`. A task
`Diaria-Clarice-Cohorts-Crawl` já roda com `--push` nos args.

### Comparação empírica v1×v2 (260808/260809) — 2 tentativas, aceitas pelo editor em 260810

A Fase 3 rodou AO VIVO contra a Brevo real (leitura, `exportRecipients` por
campanha) duas vezes, comparando contra o baseline v1 completo de 260807
(universo 142.646, `data/clarice-subscribers/cohorts/.v1-baseline-260807.log`):

- **Tentativa 1 (260808, ~23:52 UTC):** 12/82 campanhas falharam com 429
  (rate limit) — comparação fora da tolerância em 8/9 campos, majoritariamente
  atribuível às campanhas que falharam.
- **Tentativa 2 (260809, ~17:49 UTC):** 0 campanhas falharam (46 em cache +
  37 novas). Comparação AINDA fora da tolerância (2%) em 8/9 campos, mas o
  padrão do desvio é **100% consistente com crescimento orgânico** entre as
  datas de medição — universo, aberturas e exits sobem todos na direção
  esperada ("mais gente recebeu e mais gente abriu 2 dias depois"), nenhum
  campo inverte. Uma comparação limpa exigiria rodar v1 e v2 no MESMO
  instante (v1 leva ~2,5h medidas), custo alto demais para repetir na sessão.

**Decisão do editor (briefing overnight 260810):** aceitar esse padrão de
desvio como evidência suficiente de que o design v2 está correto, sem esperar
a tolerância de 2% ser atingida numa comparação assíncrona — a tolerância foi
calibrada pra pegar divergência de LÓGICA, não deriva temporal de dias entre
as duas leituras. **v2 passa a ser considerado VALIDADO.** v1 continua no
repo como **fallback documentado** (não removido, não desativado).

**O que isso NÃO decide (formalização deliberadamente parcial, na época):**

- **Troca da task pro v2** continuava não feita nesta formalização de
  260810 — decisão separada e futura do editor, explicitamente vetada
  naquela unidade de trabalho. **Atualização 260811: já feita** — ver a
  seção "Cutover para v2" acima (`Diaria-Clarice-Cohorts-Crawl`, registro do
  zero, já que `DiariaCohortsCrawl` v1 nunca chegou a ser registrada nesta
  máquina).
- **Item 2 do fleet review de #4479** ("campanha sem `sentDate` nunca entra no
  cache permanente, checar a distribuição real quando a Fase 3 rodar") **segue
  não verificado** — a Fase 3 que rodou não checou a distribuição de
  `sentDate` ausente entre as campanhas reais; a postura conservadora do
  código (trata ausência como "sempre dentro da janela de re-fetch") continua
  valendo sem confirmação empírica de quão cara ela é no regime permanente.
- **Item 1 do fleet review de #4479** ("`forceRefresh=true` sem fallback pro
  cache antigo em falha de export") continua **sem decisão** — comportamento
  atual (campanha que falha o export dentro da janela de re-fetch é excluída
  do agregado da rodada, mesmo com cache válido em disco) é o documentado e
  testado; trocar para fallback silencioso é uma escolha de comportamento que
  ainda não foi pedida por ninguém, não um bug — ver docstring de
  `getOrFetchCampaignCache`/`isWithinRefetchWindow` em
  `scripts/clarice-engagement-cohorts-v2.ts`.

Ver issue #4451 para o histórico completo (fases 1-3) e os números da
comparação lado a lado.
