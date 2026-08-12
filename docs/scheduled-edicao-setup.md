# Agendamento automático da edição diária

> **REATIVADA (260811, #4998)** — a task tinha sido desregistrada em 260711
> (#3259, decisão do editor); reativada a pedido do editor com dois ajustes:
> horário **16:00** (era 14:00) e um **guard de idempotência**: se a edição do
> dia já foi iniciada (manualmente pelo editor ou por uma run anterior desta
> mesma task), o runner pula sem invocar `claude`. Ver §"Guard de
> idempotência" abaixo.

Issue: [#2068](https://github.com/vjpixel/diaria-studio/issues/2068), reativação [#4998](https://github.com/vjpixel/diaria-studio/issues/4998)

O agendador local (systemd `--user`; o `.ps1` do Windows foi removido no #5115, cutover final) roda `/diaria-edicao {AAMMDD} --skip newsletter,linkedin,facebook` de domingo a quinta-feira às **16:00 (horário local = BRT)**, produzindo a edição do dia seguinte (D+1) — **a não ser que essa edição já tenha sido iniciada** (guard de idempotência, ver abaixo). A run completa Stages 0–4 (pesquisa → escrita → imagens → revisão pré-publicação) e encerra **sem publicar nada** — todos os canais ficam `pending_manual` no consent. O editor dispara a publicação manualmente via `/diaria-5-publicacao {AAMMDD}` na manhã seguinte.

---

## Guard de idempotência (#4998)

Antes de invocar `claude`, o runner checa se `data/editions/{AAMMDD}/` já existe. Se existir — a edição já foi iniciada, seja pelo editor rodando `/diaria-edicao`/`/diaria-1-pesquisa` manualmente mais cedo no dia, seja por uma run agendada anterior — o runner **pula sem invocar `claude`**, loga `SKIP` em `data/overnight-schedule.log` e `data/run-log.jsonl`, e sai com exit 0.

Isso é deliberadamente diferente de "deixar o orchestrator resumir": a resumabilidade normal de `/diaria-edicao` (CLAUDE.md, "Retomar edição interrompida") já cobre bem o caso de uma run que ficou pela metade — mas o pedido aqui é não *disparar* uma nova invocação de `claude` quando não há motivo, economizando o custo/tempo de bootar uma sessão inteira só para o orchestrator constatar que não há nada a fazer.

---

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/overnight/run-scheduled-edicao.ts` | Runner — calcula AAMMDD, checa o guard, invoca `claude -p`, grava logs |
| `scripts/overnight/setup-edicao-schedule-systemd.ts` | Gera o par `.service`/`.timer` (não arma — ver §Linux abaixo) |
| `scripts/lib/edicao-systemd-units.ts` | Módulo puro que monta o conteúdo dos units systemd |
| `scripts/lib/next-edition-date.ts` | Lib TS — cálculo D+1 em `America/Sao_Paulo` (testável) |
| Testes | `test/next-edition-date.test.ts`, `test/edicao-systemd-units.test.ts`, `test/run-scheduled-edicao.test.ts` | Cobertura do cálculo de data, geração de units e guard de idempotência |

O antigo par Windows (`scripts/overnight/run-scheduled-edicao.ps1` +
`scripts/overnight/setup-edicao-schedule.ps1`) foi removido no #5115
(cutover final, 260812) — nenhuma tarefa `Diaria-*` roda mais no Windows.

---

## Setup — Linux (systemd `--user`)

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

- **Windows**: encontrar o path completo (`(Get-Command claude).Source` no terminal onde `claude` funciona) e editar a action da task pelo Task Scheduler GUI para usar o path absoluto, ou adicionar o diretório do `claude` ao PATH do sistema (não do usuário).
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
