# Agendamento automático da edição diária

> **VIA ATIVA: WINDOWS (17/08/2026, #5611)** — decisão do editor:
> `Diaria-Edicao-Diaria` precisa rodar no Windows porque depende de acesso
> ao navegador (Claude in Chrome). O timer systemd `diaria-edicao-diaria.timer`
> em `predator` (Linux) foi **desabilitado** na mesma sessão
> (`systemctl --user disable --now`) para evitar duas máquinas armadas na
> mesma janela disparando duas rodadas. O #5611 reverte parte do cutover
> #5115/#5162 (que tinha removido o par `.ps1` do Windows) — mas em vez de
> recuperar aquele `.ps1` literal (que duplicava toda a lógica e antecede a
> proteção de auth do #5608), a via Windows agora é um wrapper fino que
> invoca o mesmo runner TS multiplataforma do Linux
> (`scripts/overnight/run-scheduled-edicao.ts`, criado no #4998). Ver
> §"Setup — Windows" abaixo. O par `.service`/`.timer` do Linux continua no
> repo, pronto para reativação se a via Windows precisar de fallback.

> **REATIVADA (260811, #4998)** — a task tinha sido desregistrada em 260711
> (#3259, decisão do editor); reativada a pedido do editor com dois ajustes:
> horário **16:00** (era 14:00) e um **guard de idempotência**: se a edição do
> dia já foi iniciada (manualmente pelo editor ou por uma run anterior desta
> mesma task), o runner pula sem invocar `claude`. Ver §"Guard de
> idempotência" abaixo.

Issue: [#2068](https://github.com/vjpixel/diaria-studio/issues/2068), reativação [#4998](https://github.com/vjpixel/diaria-studio/issues/4998), volta pro Windows [#5611](https://github.com/vjpixel/diaria-studio/issues/5611)

O agendador (Windows Task Scheduler, via ativa desde #5611; par Linux/systemd disponível mas desabilitado) roda `/diaria-edicao {AAMMDD} --skip newsletter,linkedin,facebook` de domingo a quinta-feira às **16:00 (horário local = BRT)**, produzindo a edição do dia seguinte (D+1) — **a não ser que essa edição já tenha sido iniciada** (guard de idempotência, ver abaixo). A run completa Stages 0–4 (pesquisa → escrita → imagens → revisão pré-publicação) e encerra **sem publicar nada** — todos os canais ficam `pending_manual` no consent. O editor dispara a publicação manualmente via `/diaria-5-publicacao {AAMMDD}` na manhã seguinte.

---

## Guard de idempotência (#4998)

Antes de invocar `claude`, o runner checa se `data/editions/{AAMMDD}/` já existe. Se existir — a edição já foi iniciada, seja pelo editor rodando `/diaria-edicao`/`/diaria-1-pesquisa` manualmente mais cedo no dia, seja por uma run agendada anterior — o runner **pula sem invocar `claude`**, loga `SKIP` em `data/overnight-schedule.log` e `data/run-log.jsonl`, e sai com exit 0.

Isso é deliberadamente diferente de "deixar o orchestrator resumir": a resumabilidade normal de `/diaria-edicao` (CLAUDE.md, "Retomar edição interrompida") já cobre bem o caso de uma run que ficou pela metade — mas o pedido aqui é não *disparar* uma nova invocação de `claude` quando não há motivo, economizando o custo/tempo de bootar uma sessão inteira só para o orchestrator constatar que não há nada a fazer.

---

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/overnight/run-scheduled-edicao.ts` | Runner real — calcula AAMMDD, checa o guard, invoca `claude -p`, grava logs. Multiplataforma (Node puro); é o mesmo em ambas as vias |
| `scripts/overnight/run-scheduled-edicao.ps1` | **Windows** — wrapper fino: resolve `CLAUDE_BIN` (ver §"Setup — Windows") e invoca `npx tsx run-scheduled-edicao.ts`. Nenhuma lógica de negócio aqui |
| `scripts/overnight/setup-edicao-schedule.ps1` | **Windows** — registra/remove a task `Diaria-Edicao-Diaria` no Task Scheduler |
| `scripts/overnight/setup-edicao-schedule-systemd.ts` | **Linux** — gera o par `.service`/`.timer` (não arma — ver §Linux abaixo) |
| `scripts/lib/edicao-systemd-units.ts` | **Linux** — módulo puro que monta o conteúdo dos units systemd |
| `scripts/lib/resolve-claude-bin.ts` | Resolve o binário `claude` a partir de um contexto sem o PATH do shell interativo (#5549) — escape-hatch `CLAUDE_BIN` usado pelo wrapper Windows |
| `scripts/lib/next-edition-date.ts` | Lib TS — cálculo D+1 em `America/Sao_Paulo` (testável) |
| Testes | `test/next-edition-date.test.ts`, `test/edicao-systemd-units.test.ts`, `test/run-scheduled-edicao.test.ts` | Cobertura do cálculo de data, geração de units e guard de idempotência |

O par Windows original (`run-scheduled-edicao.ps1` + `setup-edicao-schedule.ps1`, que duplicava a lógica inteira em PowerShell) foi removido no #5115 (cutover final, 260812). **Restaurado no #5611 (17/08/2026)** com um desenho diferente: os `.ps1` atuais são wrappers finos que delegam 100% da lógica para `run-scheduled-edicao.ts` — a mesma fonte usada pelo Linux — em vez de duplicá-la.

---

## Setup — Windows (Task Scheduler) — VIA ATIVA (#5611)

`setup-edicao-schedule.ps1` registra a task diretamente (sem passo de geração
separado — ao contrário do par Linux, não há um "gerador" intermediário; o
`.ps1` de setup já registra a task real).

```powershell
# Registrar (ou atualizar) a task — rodar no clone PERMANENTE, nunca num
# worktree temporário (o path do runner fica embutido na Action da task):
powershell -NoProfile -ExecutionPolicy Bypass `
    -File .\scripts\overnight\setup-edicao-schedule.ps1

# Remover:
powershell -NoProfile -ExecutionPolicy Bypass `
    -File .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister
```

### Verificar

```powershell
Get-ScheduledTask -TaskName 'Diaria-Edicao-Diaria' | Get-ScheduledTaskInfo
```

### Pré-requisito: `claude` no PATH da sessão do Task Scheduler

`run-scheduled-edicao.ps1` (o wrapper invocado pela task) resolve
`CLAUDE_BIN` via `Get-Command claude` e injeta o path absoluto no ambiente
antes de chamar `npx tsx run-scheduled-edicao.ts` — necessário porque
`resolveClaudeBin()` (`scripts/lib/resolve-claude-bin.ts`, #5549) varre o
PATH procurando o nome literal `claude` sem extensão, e no Windows o
executável instalado é `claude.exe`/`claude.cmd` (confirmado ao vivo,
#5611: a varredura sem `CLAUDE_BIN` falha mesmo com `claude.exe` presente e
resolvível via `Get-Command`). Se `claude` não estiver no PATH da sessão do
usuário que a task roda, o wrapper avisa e a falha aparece com mensagem
acionável em `data/overnight-schedule.log`.

### Credenciais (`.env`)

Diferente do Linux (`EnvironmentFile=-.env` explícito no unit systemd), no
Windows as credenciais (`CLARICE_API_KEY` etc.) vêm das variáveis de
ambiente **persistidas por usuário** (`[Environment]::SetEnvironmentVariable(...,
"User")`, ver `CLAUDE.md` §Setup passo 1) — o Task Scheduler, rodando no
contexto do mesmo usuário, já as herda automaticamente. Nenhum passo extra
de carregamento de `.env` é necessário nesta via.

### Guard de auth (#5608) — herdado automaticamente

O filtro `CLAUDE_CLI_STRIPPED_ENV_VARS` (remove `ANTHROPIC_API_KEY` e afins
do ambiente do processo filho antes de invocar `claude`, para a sessão
agendada nunca trocar o login claude.ai pela API paga) vive dentro de
`run-scheduled-edicao.ts` e vale para as duas vias sem duplicação — é
justamente por isso que o wrapper Windows delega para esse runner em vez de
reimplementar a lógica em PowerShell (o `.ps1` original, pré-#5115, não
tinha essa proteção porque antecede o #5608).

---

## Setup — Linux (systemd `--user`) — desabilitado (ver banner no topo)

Mesmo padrão de dois passos já usado pelo resto do repo (gerar → armar manualmente, ver `docs/overnight-watchdog-setup.md`): o gerador **só escreve arquivos em disco**, nunca chama `systemctl`.

```bash
# Gera o par .service/.timer em .systemd-units/ (com nvm use/fnm use do .nvmrc já ativado):
npx tsx scripts/overnight/setup-edicao-schedule-systemd.ts

# Armar (ação manual, imprimida pelo gerador acima):
mkdir -p ~/.config/systemd/user
cp .systemd-units/diaria-edicao-diaria.service .systemd-units/diaria-edicao-diaria.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now diaria-edicao-diaria.timer
```

### Verificar

```bash
systemctl --user list-timers diaria-edicao-diaria.timer
journalctl --user -u diaria-edicao-diaria.service -n 50
```

### Remover

```bash
systemctl --user disable --now diaria-edicao-diaria.timer
rm ~/.config/systemd/user/diaria-edicao-diaria.service ~/.config/systemd/user/diaria-edicao-diaria.timer
systemctl --user daemon-reload
```

---

## Comportamento em execução

### Fluxo normal

1. O agendador dispara às 16:00 (dom-qui).
2. Runner calcula `AAMMDD = amanhã em BRT` via `scripts/lib/next-edition-date.ts`.
3. **Guard de idempotência**: se `data/editions/{AAMMDD}/` já existe, loga `SKIP` e encerra (exit 0) sem invocar `claude`.
4. Senão, invoca: `claude --print --permission-mode acceptEdits --max-turns 120 --output-format text --no-session-persistence /diaria-edicao {AAMMDD} --skip newsletter,linkedin,facebook`.
5. Orchestrator executa Stages 0–3 (pesquisa → escrita → imagens) em modo auto-approve.
6. No Stage 4 (Revisão), executa o pré-render completo (HTML + imagens + upload Worker + close-poll) + resumo consolidado. Com `--skip newsletter,linkedin,facebook`, o Stage 5 (Publicação) vai usar `build-publish-consent.ts --skip "newsletter,linkedin,facebook"` (path 1 de §5b) — sem gate interativo, sem fallback default-auto (#1326/#2068). Todos os canais ficam `pending_manual` no `_internal/05-publish-consent.json`. (#1694: Stage 4 escreve sentinel `.step-4-done.json`; Stage 5 lê isso como prereq.)
7. A run termina naturalmente após o Stage 4 (Revisão). O Stage 5 (Publicação) não é disparado — requer input do editor. Não aguarda confirmação nem fica travada no gate.
8. Logs gravados em `data/run-log.jsonl` e `data/overnight-schedule.log`.
9. Editor revisa os outputs (Stage 1-4 + pré-render) e dispara `/diaria-5-publicacao {AAMMDD}` quando pronto.

### Por que `--skip` em vez de deixar o pre-gate expirar?

`--skip newsletter,linkedin,facebook` é o mecanismo correto. Sem ele, o Stage 5 (Publicação) chega ao gate interativo e, como não há resposta em modo headless, o default do invariante #1326 é **tudo automático** — disparando os 3 canais sem supervisão. Com `--skip`, o consent é gravado deterministicamente como `pending_manual` em todos os canais, e a run termina limpa. (#1694: o `--skip` é encaminhado pelo orchestrator ao Stage 5; o Stage 4 tem seu próprio gate de revisão que no scheduled run é auto-aprovado por `auto_approve = true` para stages 1-4.)

### Por que `--max-turns 120`?

O pipeline completo (Stages 0–4 + pré-render) tipicamente usa 50–90 turnos. `120` dá margem para slowdowns sem bloquear indefinidamente. É um safety net — a run termina naturalmente antes de atingir o limite na maioria dos casos.

Nota: o auto-reporter ao final do Stage 5 pode apresentar gate humano (issues GitHub). Em headless ele não recebe resposta e a run expira pelo `--max-turns`; isso é benigno — tudo que importa (consent, pré-render) já foi gravado antes do auto-reporter.

---

## Logs

### `data/run-log.jsonl`

Log estruturado da pipeline (compartilhado com todas as runs manuais). Entradas do scheduler têm `"agent": "scheduled-edicao"`. Visualizar via:

```
/diaria-log
```

### `data/overnight-schedule.log`

Log simples linha-por-linha desta feature, compartilhado entre o runner Windows e o Linux. Formato:

```
2026-04-26T14:00:01-03:00 | START edition=260427 pid=12345
2026-04-26T14:00:02-03:00 | SKIP  edition=260427 reason=already-started end=2026-04-26T14:00:02-03:00
2026-04-26T16:32:11-03:00 | OK    edition=260427 exit=0 end=2026-04-26T16:32:11-03:00
```

---

## Troubleshooting

### `claude` não encontrado no PATH da task

O agendador pode usar um PATH diferente do terminal interativo. Solução:

- **Windows**: `run-scheduled-edicao.ps1` já resolve isso sozinho — roda `Get-Command claude` e injeta `CLAUDE_BIN` no ambiente do processo filho antes de invocar o runner TS (necessário: `resolveClaudeBin()` varre o PATH só pelo nome literal `claude` sem extensão, e no Windows o executável é `claude.exe`/`claude.cmd`, então a varredura nunca resolve sozinha aqui). Se mesmo assim falhar, é porque `claude` não está no PATH da sessão do usuário que a task Task Scheduler roda — confirme `(Get-Command claude).Source` **nessa mesma sessão** (não só no terminal interativo onde você testa) e adicione ao PATH do usuário se ausente.
- **Linux**: `ExecStart=` roda com o `PATH` do systemd `--user` (normalmente herdado do login shell via `systemctl --user import-environment`, ou definido no unit). Se `claude` não for encontrado, adicionar `Environment=PATH=...` ao `.service` ou garantir que o PATH do usuário já inclui o diretório de instalação do Claude Code no momento do `systemctl --user daemon-reload`.

### MCPs indisponíveis em sessão headless

Os MCPs `claude.ai` (beehiiv, gmail) são carregados via `.mcp.json` + keychain OAuth. Em sessão headless, eles ficam disponíveis se o usuário estiver autenticado no Claude Code.

Se MCPs estiverem indisponíveis:
- **Stage 0 (beehiiv + gmail):** falha — orquestrador faz halt fail-fast (#738), exibe banner de erro, run encerra.
- **Stage 2 (clarice MCP):** falha — halt fail-fast.
- **Stages 1, 3:** não dependem de MCP, continuam normalmente.

O erro aparece em `data/run-log.jsonl` com `level: "error"` e na última linha de `data/overnight-schedule.log` com `FAIL`.

Para corrigir: reabrir Claude Code interativamente e autenticar os MCPs antes da próxima run agendada.

### Verificar autenticação do Claude

```
claude auth status
```

### Run travada / não completou

Verificar o `--max-turns` atual vs. complexidade da pipeline. Se logs mostram que o Stage 3 não foi iniciado em 2h, aumentar `--max-turns` no runner.

### `ExecStart=` do unit systemd embute o Node errado

Mesmo achado ao vivo do watchdog (#4857, incidente #4823): `buildEdicaoSystemdUnitFiles` embute `process.execPath` — o Node que **rodou o gerador**, literalmente, no `ExecStart=`. Gerar com `nvm use`/`fnm use` do `.nvmrc` já ativado; senão o unit fica preso a um Node desatualizado. `setup-edicao-schedule-systemd.ts` avisa (não bloqueia) se detectar isso.

---

## Fuso horário

O horário de disparo é sempre pensado em BRT: `OnCalendar=` inclui
`America/Sao_Paulo` explicitamente (`scripts/lib/edicao-systemd-units.ts`) —
independe do fuso do sistema (`predator` roda em `Etc/UTC`).

O cálculo de D+1 usa explicitamente `America/Sao_Paulo` via `Intl.DateTimeFormat` em ambas as plataformas (independente do fuso da máquina).

---

## Dias cobertos

| Dia da semana (disparo, 16:00 BRT) | Edição gerada (D+1) |
|---|---|
| Domingo | Segunda-feira |
| Segunda | Terça-feira |
| Terça | Quarta-feira |
| Quarta | Quinta-feira |
| Quinta | Sexta-feira |

Sexta, sábado e domingo **não** têm disparo automático (sem edições nesses dias).

---

## Alarme de staleness (`Diaria-Edicao-Diaria-Staleness-Alarm`, #5563) — PAUSADO

O alarme de staleness (task separada, diária 18:20 BRT, ver `docs/scheduled-tasks-registry.md`) lê `data/overnight-schedule.log` — arquivo dentro de `data/`, sincronizado por OneDrive entre as máquinas do projeto, então em princípio funcionaria igual não importa qual máquina gravou a última entrada. Mas ele **não checa se algum timer está de fato armado**, só se o log tem uma entrada pra edição de amanhã — com o timer Linux desabilitado (banner no topo) e a task Windows ainda sem confirmação de arme real (§Setup — Windows), o alarme dispararia `alarm-never-fired` todo dia sobre um estado hoje intencional (nenhuma via disparando ainda).

Por isso ele foi desabilitado junto com o timer Linux, na mesma sessão de 17/08/2026, e **fica pausado até o editor confirmar que a task `Diaria-Edicao-Diaria` do Windows está de fato registrada e habilitada** (`Get-ScheduledTask -TaskName 'Diaria-Edicao-Diaria' | Get-ScheduledTaskInfo`, ver §Setup — Windows). Reativar depois disso é só `systemctl --user enable --now diaria-edicao-diaria-staleness-alarm.timer` em `predator` — o alarme em si não precisa de nenhuma mudança de código para funcionar cross-platform (ele já lê o log compartilhado, não distingue qual runner gravou a linha).
