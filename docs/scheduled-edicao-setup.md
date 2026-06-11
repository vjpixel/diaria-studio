# Agendamento automático da edição diária

Issue: [#2068](https://github.com/vjpixel/diaria-studio/issues/2068)

O Task Scheduler do Windows roda `/diaria-edicao {AAMMDD}` de domingo a quinta-feira às 14:00 (horário local = BRT), produzindo a edição do dia seguinte (D+1). A pipeline para automaticamente no **pre-gate do Stage 4** — o editor revisa e dispara a publicação manualmente via `/diaria-4-publicar`.

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
3. Invoca: `claude --print --permission-mode acceptEdits --max-turns 120 --output-format text --no-session-persistence /diaria-edicao {AAMMDD}`.
4. Orchestrator executa Stages 0–3 (pesquisa → escrita → imagens → pré-render) em modo auto-approve.
5. Ao chegar no pre-gate do Stage 4, o orquestrador emite a pergunta de aprovação — mas em modo headless (`-p`) não há TTY para responder. A run encerra ao atingir `--max-turns 120` ou naturalmente se o Stage 3 completar antes.
6. Logs gravados em `data/run-log.jsonl` e `data/overnight-schedule.log`.
7. Editor recebe notificação (ou consulta os logs) e dispara `/diaria-4-publicar` quando pronto.

### Por que `--max-turns 120`?

O pipeline completo de Stages 0–3 tipicamente usa 40–80 turnos (cada subagente dispatch + resposta = ~2 turnos). `120` dá margem para slowdowns sem bloquear infinitamente.

Se o Stage 3 completar normalmente, o orquestrador vai pedir confirmação para Stage 4 — como não há resposta possível, o LLM pode aguardar e a run eventualmente expira pelo `--max-turns`. Isso é comportamento esperado.

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
