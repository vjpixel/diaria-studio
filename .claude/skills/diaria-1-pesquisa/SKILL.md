---
name: diaria-1-pesquisa
description: Roda apenas o Stage 1 (pesquisa + verify + dedup + categorize + score). Útil para retry isolado. Uso — `/diaria-1-pesquisa AAMMDD`.
---

# /diaria-1-pesquisa

Executa só o Stage 1 da pipeline.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação.

## Passo 1 — Confirmar janela de publicação aceita (sempre, antes do orchestrator)

**Este é o primeiro output visível ao usuário.** Execute **neste loop principal** (não delegue ao orchestrator — subagentes não conseguem pausar pra input).

Converter `$1` (AAMMDD) para ISO date interno:
```bash
node -e "const s='$1';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))"
```
Armazenar como `$ISO`. Usar `$ISO` em todo Date math abaixo.

1. Default de `window_days` por dia da semana:
   ```bash
   node -e "const d=new Date('$ISO');const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
   Segunda/terça = 4, quarta–sexta = 3.
2. `window_start = $ISO − window_days dias`:
   ```bash
   node -e "const d=new Date('$ISO');d.setUTCDate(d.getUTCDate()-{window_days});process.stdout.write(d.toISOString().slice(0,10))"
   ```
3. Perguntar ao usuário e **aguardar resposta**:

   ```
   Janela de publicacao aceita: {window_start} -> $1 ({window_days} dias)
   Pressione Enter para confirmar ou digite outro numero de dias:
   ```

4. Enter / "ok" / "sim" → manter default. Número N ≥ 1 → `window_days = N`.

## Passo 2 — Pré-requisitos e disparo

1. Verificar pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente pelo orchestrator — não precisa estar atualizado.
2. Disparar `orchestrator` via `Agent` com instrução: rodar **Stage 0 (refresh dedup + inbox drain) + Stage 1** e pausar no gate ao final. Passar no prompt:
   - `edition_date = $1` (AAMMDD)
   - `window_days = {valor confirmado no Passo 1}`
   - `stop_after_stage = 1`

O orchestrator executa o refresh de `past-editions.md`, depois o paralelismo do Stage 1 (source-researcher × N fontes + discovery-searcher × M queries + link-verifier + `scripts/dedup.ts` + `scripts/categorize.ts` + research-reviewer + scorer).

## Output

`data/editions/{AAMMDD}/_internal/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `_internal/01-approved.json`.
