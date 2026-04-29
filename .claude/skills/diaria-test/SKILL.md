---
name: diaria-test
description: Roda a pipeline completa da Diar.ia sem gates humanos para benchmark de performance — auto-aprova tudo, agenda social 10 dias à frente, pula Drive sync. Uso — `/diaria-test [AAMMDD]`.
---

# /diaria-test

Roda a pipeline completa da Diar.ia **sem gates humanos** para benchmark de performance.
Todo conteúdo social é agendado 10 dias à frente para que o editor possa deletar antes da publicação real.

## Argumentos

- `<date>` (opcional) = data da edição no formato `AAMMDD` (ex: `260423`). Default: hoje.

## O que muda em relação a `/diaria-edicao`

| Aspecto | `/diaria-edicao` | `/diaria-test` |
|---------|------------------|----------------|
| Gates humanos | Pausa em cada stage | **Auto-approve** — não para nunca |
| Social schedule | `day_offset` do config (0) | **`day_offset = 10`** — agenda 10 dias à frente |
| Newsletter | Rascunho + email de teste | Rascunho + email de teste (igual) |
| Drive sync | Push + pull normal | **Desabilitado** (sem poluir Drive com teste) |
| Janela de publicação | Pergunta ao usuário | **Default automático** (seg/ter=4, qua-sex=3) |
| Timing | Inferido de file mtimes | **`stage-timing.ts` roda no final** |

## Processo

### 1. Setup

1. Se `<date>` não foi passado, usar hoje (como AAMMDD):
   ```bash
   node -e "process.stdout.write(new Date().toISOString().slice(2,10).replace(/-/g,''))"
   ```
2. Converter `<date>` (AAMMDD) para ISO e calcular `window_days` default (sem perguntar ao usuário):
   ```bash
   node -e "const s='<date>';const d=new Date('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6));const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
3. Verificar pré-requisitos silenciosamente:
   - `context/sources.md` existe e >200 bytes
   - `context/editorial-rules.md` existe e >200 bytes
   - Se algum faltar, abortar com erro (não perguntar — é um teste).

### 2. Executar o playbook diretamente no top-level (#207)

**Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa o playbook stage-a-stage diretamente.** **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar todos os subagentes que cada stage prescreve (`source-researcher`, `writer`, `social-*`, `publish-*`, etc).

Variáveis pra alimentar o playbook:
- `edition_date = <date>` (AAMMDD)
- `edition_iso = 20${date.slice(0,2)}-${date.slice(2,4)}-${date.slice(4,6)}`
- `window_days = {valor calculado}`
- `test_mode = true` → auto-aprovar todos os gates, **desabilitar Drive sync** (pular blocos de push/pull), copiar `_internal/01-categorized.json` → `_internal/01-approved.json` direto sem edição humana
- `schedule_day_offset = 10` → social posts agendados 10 dias à frente

**Não relayar gates ao usuário.** Em `test_mode`, auto-aprovar tudo conforme Princípio 2 do playbook.

### 3. Ao completar

1. Rodar `stage-timing.ts` no diretório da edição:
   ```bash
   npx tsx scripts/stage-timing.ts --edition {AAMMDD}
   ```
2. Mostrar ao usuário:
   - Tabela de timing por stage
   - Total wall clock
   - Lembrete: "Social posts agendados para {date+10}. Delete do Facebook/LinkedIn antes dessa data."
   - Link para o rascunho no Beehiiv (de `05-published.json`)

## Output

Mesmo de `/diaria-edicao`: todos os arquivos em `data/editions/{AAMMDD}/`.
