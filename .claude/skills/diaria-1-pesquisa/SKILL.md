---
name: diaria-1-pesquisa
description: Roda apenas o Stage 1 (pesquisa + verify + dedup + categorize + score). Útil para retry isolado. Uso: `/diaria-1-pesquisa YYYY-MM-DD`.
---

# /diaria-1-pesquisa

Executa só o Stage 1 da pipeline.

## Argumentos

- `$1` = data da edição (`YYYY-MM-DD`). Pergunte se faltar.

## Passo 1 — Confirmar janela de publicação aceita (sempre, antes do orchestrator)

**Este é o primeiro output visível ao usuário.** Execute **neste loop principal** (não delegue ao orchestrator — subagentes não conseguem pausar pra input).

1. Default de `window_days` por dia da semana:
   ```bash
   node -e "const d=new Date('$1');const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
   Segunda/terça = 4, quarta–sexta = 3.
2. `window_start = $1 − window_days dias`:
   ```bash
   node -e "const d=new Date('$1');d.setUTCDate(d.getUTCDate()-{window_days});process.stdout.write(d.toISOString().slice(0,10))"
   ```
3. Perguntar ao usuário e **aguardar resposta**:

   ```
   📅 Janela de publicação aceita: {window_start} → $1 ({window_days} dias)
   Pressione Enter para confirmar ou digite outro número de dias:
   ```

4. Enter / "ok" / "sim" → manter default. Número N ≥ 1 → `window_days = N`.

## Passo 2 — Pré-requisitos e disparo

1. Verificar pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente pelo orchestrator — não precisa estar atualizado.
2. Disparar `orchestrator` via `Task` com instrução: rodar **Stage 0 (refresh dedup + inbox drain) + Stage 1** e pausar no gate ao final. Passar no prompt:
   - `edition_date = $1`
   - `window_days = {valor confirmado no Passo 1}`
   - `stop_after_stage = 1`

O orchestrator executa o refresh de `past-editions.md`, depois o paralelismo do Stage 1 (source-researcher × N fontes + discovery-searcher × M queries + link-verifier + `scripts/dedup.ts` + `scripts/categorize.ts` + research-reviewer + scorer).

## Output

`data/editions/{YYMMDD}/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `01-approved.json`.
