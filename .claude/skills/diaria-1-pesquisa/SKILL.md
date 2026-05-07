---
name: diaria-1-pesquisa
description: Roda apenas a Etapa 1 (pesquisa + verify + dedup + categorize + score). Útil para retry isolado. Uso — `/diaria-1-pesquisa AAMMDD`.
---

# /diaria-1-pesquisa

Executa só a Etapa 1 da pipeline.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação.

## Passo 1 — Confirmar janela de publicação aceita (sempre, antes do orchestrator)

**Este é o primeiro output visível ao usuário.** Execute **neste loop principal** (não delegue ao orchestrator — subagentes não conseguem pausar pra input).

Converter `$1` (AAMMDD) para ISO date interno:
```bash
node -e "const s='$1';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))"
```
Armazenar como `$ISO`. Usar `$ISO` em todo Date math abaixo.

1. **Janela = 4 dias corridos terminando hoje UTC** (#315, #576).
   O endpoint superior é a data de execução (hoje UTC), independente de `$ISO`. Garante cobertura de conteúdo publicado no mesmo dia em que rodamos retroativamente.
   ```bash
   node -e "process.stdout.write(new Date().toISOString().slice(0,10))"
   ```
   Armazenar como `WINDOW_END` (ex: `2026-05-05` quando rodamos em 2026-05-05, independente da edition_iso).
   `window_days = 4` (fixo, sem depender do dia da semana).
   ```bash
   node -e "const d=new Date('$WINDOW_END');d.setUTCDate(d.getUTCDate()-3);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `window_start` (ex: `2026-04-25`).
2. Perguntar ao usuário e **aguardar resposta**:

   ```
   Janela de publicacao aceita: {window_start} -> {WINDOW_END} (4 dias)
   Digite ok para confirmar ou outro numero de dias:
   ```

3. Enter / "ok" / "sim" → manter default. Número N ≥ 1 → `window_days = N`, recalcular `window_start`.

## Passo 1b — Defensive cleanup de tasks órfãs (#904)

Antes de criar qualquer task nova, varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de invocações anteriores (`Stage 0*`, `Stage 1*`, `Stage 2*`, etc.). Cobre o caso de skill anterior ter sido interrompida sem fechar suas tasks. **No-op se TaskList/TaskUpdate não estiver disponível** (modo CLI puro fora do harness Claude Code) — a invariante `Task tracking — UI hygiene` em `orchestrator.md` cobre o detalhe.

## Passo 2 — Pré-requisitos e execução do playbook

1. Verificar pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente — não precisa estar atualizado.
2. **Executar o playbook diretamente no top-level (#207).** Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa em sequência **§ 0 Setup** (que inclui refresh de `past-editions.md` via `scripts/refresh-past-editions.ts` e inbox drain via `scripts/inbox-drain.ts`) + **§ 1 Stage 1 — Research**. **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `source-researcher`, `discovery-searcher`, `eia-composer`, `research-reviewer`, `scorer` em paralelo conforme o playbook prescreve.

   Variáveis pra alimentar o playbook:
   - `edition_date = $1` (AAMMDD)
   - `edition_iso = 20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}`
   - `window_days = {valor confirmado no Passo 1}`
   - `stop_after_stage = 1` (parar após o gate do Stage 1)

   O playbook executa: refresh de `past-editions.md` → inbox drain → paralelismo (source-researcher × N + discovery-searcher × M + eia-composer background) → `scripts/verify-accessibility.ts` → `scripts/enrich-inbox-articles.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `scripts/topic-cluster.ts` → `scripts/filter-date-window.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` → drive push → **pre-gate validator** → GATE.

## Passo 3 — Pre-gate validator (#581)

Antes de apresentar o gate humano, rodar:

```bash
npx tsx scripts/validate-stage-1-output.ts \
  --edition $1 \
  --edition-dir data/editions/$1/
```

Semântica completa (exit codes, output JSON, falha do próprio validator) em **[`docs/validate-stage-1-output-semantics.md`](../../../docs/validate-stage-1-output-semantics.md)** — single source of truth (#832).

## Output

`data/editions/{AAMMDD}/_internal/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `_internal/01-approved.json`.

## Passo 4 — Fechar task tracking pós-gate (#904)

**Imediatamente após gate aprovado** (quando o sentinel `pipeline-sentinel.ts write --step 1` for executado em 1y do orchestrator), marcar todas as tasks `Stage 1*` (incluindo `Stage 1x — GATE HUMANO`) como `completed` via `TaskUpdate`. Sem isso, o timer da task de gate continua rodando indefinidamente na UI mesmo com Stage 2 já dispatchado.

**No-op se TaskUpdate não estiver disponível** (CLI puro). A invariante completa está em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene".
