# Agendamento automático da edição diária

Issue: [#2068](https://github.com/vjpixel/diaria-studio/issues/2068)

O Task Scheduler do Windows roda `/diaria-edicao {AAMMDD} --skip newsletter,linkedin,facebook` de domingo a quinta-feira às 14:00 (horário local = BRT), produzindo a edição do dia seguinte (D+1). A run completa Stages 0–3 + pré-render do Stage 4 e encerra **sem publicar nada** — todos os canais ficam `pending_manual` no consent. O editor dispara a publicação manualmente via `/diaria-4-publicar {AAMMDD}` na manhã seguinte.

---

## Arquivos

| Arquivo | Função |
|---|---|
| `scripts/overnight/run-scheduled-edicao.ps1` | Runner — calcula AAMMDD, invoca `claude -p`, grava logs |
| `scripts/overnight/setup-edicao-schedule.ps1` | Setup — registra/atualiza/remove a task no Task Scheduler |
| `scripts/lib/next-edition-date.ts` | Lib TS — cálculo D+1 em `America/Sao_Paulo` (testável) |
| `test/next-edition-date.test.ts` | Testes unitários do cálculo de data |

---

## Setup (após o merge do PR)

**Requisito:** executar no clone permanente do repo, não em worktrees temporários.

```powershell
# No diretório raiz do repo:
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\overnight\setup-edicao-schedule.ps1
```

Isso cria a task `Diaria-Edicao-Diaria` no Task Scheduler local. Idempotente — re-executar atualiza a task.

### Verificar a task registrada

```powershell
Get-ScheduledTask -TaskName "Diaria-Edicao-Diaria" | Get-ScheduledTaskInfo
```

### Testar manualmente (sem executar a pipeline de verdade)

Para confirmar que o runner encontra os paths corretamente:

```powershell
# Apenas checar cálculo de data (sem invocar claude):
node --import tsx --input-type=module --eval `
    "import { nextEditionDate } from './scripts/lib/next-edition-date.ts'; console.log(nextEditionDate());"
```

### Remover a task

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\overnight\setup-edicao-schedule.ps1 -Unregister
```

---

## Comportamento em execução

### Fluxo normal

1. Task Scheduler dispara às 14:00.
2. Runner calcula `AAMMDD = amanhã em BRT` via `scripts/lib/next-edition-date.ts` (fallback puro PowerShell se node falhar).
3. Invoca: `claude --print --permission-mode acceptEdits --max-turns 120 --output-format text --no-session-persistence /diaria-edicao {AAMMDD} --skip newsletter,linkedin,facebook`.
4. Orchestrator executa Stages 0–3 (pesquisa → escrita → imagens) em modo auto-approve.
5. No Stage 4, executa o pré-render completo (HTML + imagens + upload Worker + close-poll). `--skip newsletter,linkedin,facebook` faz o orchestrator chamar `build-publish-consent.ts --skip "newsletter,linkedin,facebook"` (path 1 de §4b) — sem gate interativo, sem fallback default-auto (#1326/#2068). Todos os canais ficam `pending_manual` no `_internal/05-publish-consent.json`.
6. A run termina naturalmente após o pré-render do Stage 4. Não aguarda confirmação nem fica travada no gate.
7. Logs gravados em `data/run-log.jsonl` e `data/overnight-schedule.log`.
8. Editor revisa os outputs (Stage 1-3 + pré-render) e dispara `/diaria-4-publicar {AAMMDD}` quando pronto. O gate interativo normal do `/diaria-4-publicar` sobrescreve o consent do scheduled run.

### Por que `--skip` em vez de deixar o pre-gate expirar?

`--skip newsletter,linkedin,facebook` é o mecanismo correto. Sem ele, o Stage 4 chega ao pre-gate interativo e, como não há resposta em modo headless, o default do invariante #1326 é **tudo automático** — disparando os 3 canais sem supervisão. Com `--skip`, o consent é gravado deterministicamente como `pending_manual` em todos os canais, e a run termina limpa.

### Por que `--max-turns 120`?

O pipeline completo (Stages 0–3 + pré-render Stage 4) tipicamente usa 50–90 turnos. `120` dá margem para slowdowns sem bloquear indefinidamente. É um safety net — a run termina naturalmente antes de atingir o limite na maioria dos casos.

Nota: o auto-reporter ao final do Stage 4 pode apresentar gate humano (issues GitHub). Em headless ele não recebe resposta e a run expira pelo `--max-turns`; isso é benigno — tudo que importa (consent, pré-render) já foi gravado antes do auto-reporter.

---

## Logs

### `data/run-log.jsonl`

Log estruturado da pipeline (compartilhado com todas as runs manuais). Entradas do scheduler têm `"agent": "scheduled-edicao"`. Visualizar via:

```
/diaria-log
```

### `data/overnight-schedule.log`

Log simples linha-por-linha desta feature. Formato:

```
2026-04-26T14:00:01-03:00 | START edition=260427 pid=12345
2026-04-26T16:32:11-03:00 | OK    edition=260427 exit=0 end=2026-04-26T16:32:11-03:00
```

---

## Troubleshooting

### `claude` não encontrado no PATH da task

O Task Scheduler pode usar um PATH diferente do terminal interativo. Solução:

1. Encontrar o path completo: `(Get-Command claude).Source` no terminal onde `claude` funciona.
2. Editar a action da task pelo Task Scheduler GUI para usar o path absoluto.

Ou adicionar o diretório do `claude` ao PATH do sistema (não do usuário).

### MCPs indisponíveis em sessão headless

Os MCPs `claude.ai` (beehiiv, gmail) são carregados via `.mcp.json` + keychain OAuth. Em sessão headless, eles ficam disponíveis se o usuário estiver autenticado no Claude Code.

Se MCPs estiverem indisponíveis:
- **Stage 0 (beehiiv + gmail):** falha — orquestrador faz halt fail-fast (#738), exibe banner de erro, run encerra.
- **Stage 2 (clarice MCP):** falha — halt fail-fast.
- **Stages 1, 3:** não dependem de MCP, continuam normalmente.

O erro aparece em `data/run-log.jsonl` com `level: "error"` e na última linha de `data/overnight-schedule.log` com `FAIL`.

Para corrigir: reabrir Claude Code interativamente e autenticar os MCPs antes da próxima run agendada.

### Verificar autenticação do Claude

```powershell
claude auth status
```

### Run travada / não completou

Verificar o `--max-turns` atual vs. complexidade da pipeline. Se logs mostram que o Stage 3 não foi iniciado em 2h, aumentar `--max-turns` no runner.

---

## Fuso horário

A task usa o fuso local da máquina. Se a máquina não estiver em BRT (UTC-3), ajustar o horário de disparo no `setup-edicao-schedule.ps1`. O cálculo de D+1 usa explicitamente `America/Sao_Paulo` via `Intl.DateTimeFormat` (independente do fuso da máquina).

---

## Dias cobertos

| Dia da semana (disparo) | Edição gerada (D+1) |
|---|---|
| Domingo (dom) | Segunda-feira |
| Segunda (seg) | Terça-feira |
| Terça (ter) | Quarta-feira |
| Quarta (qua) | Quinta-feira |
| Quinta (qui) | Sexta-feira |

Sexta, sábado e domingo **não** têm disparo automático (sem edições nesses dias).
