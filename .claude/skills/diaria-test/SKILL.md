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

### 4. Stage final — Coleta de erros e auto-reporter (#519)

**Roda independente de sucesso/falha dos stages anteriores** — captura tudo o que merece virar issue. O `/diaria-test` existe pra surfar regressões; este stage fecha o loop.

1. Coletar sinais com a flag `--include-test-warnings` (capta também error/warn genéricos do run-log da edição):

   ```bash
   npx tsx scripts/collect-edition-signals.ts \
     --edition-dir data/editions/{AAMMDD}/ \
     --include-test-warnings
   ```

2. Ler `data/editions/{AAMMDD}/_internal/issues-draft.json`:
   - **Se `signals_count === 0`:** logar info ("nada a reportar — edição de teste limpa") e finalizar.
   - **Se `signals_count > 0`:** dispatchar `auto-reporter` com `test_mode: true`:

     ```
     Agent({
       subagent_type: "auto-reporter",
       description: "Auto-criar issues do test run {AAMMDD}",
       prompt: "Coletar issues-draft.json em data/editions/{AAMMDD}/_internal/. test_mode=true (auto-aprovar criação sem gate humano). repo=vjpixel/diaria-studio. edition_dir=data/editions/{AAMMDD}/."
     })
     ```

3. Em `test_mode`, o `auto-reporter` pula o gate humano, dedup contra issues abertas, cria/comenta issues e tagga as criadas com `from-diaria-test` (ver `.claude/agents/auto-reporter.md`).

4. No resumo final ao usuário, incluir bloco:

   ```
   📋 Auto-reporter (test_mode):
      {issues_created} issues novas: #NN, #NN
      {issues_commented} issues comentadas: #NN
   ```

   (omitir se zero.)

## Output

Mesmo de `/diaria-edicao`: todos os arquivos em `data/editions/{AAMMDD}/`. Adicional: issues GitHub abertas com label `from-diaria-test` quando o run captou regressões.
