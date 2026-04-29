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

## Passo 2 — Pré-requisitos e execução do playbook

1. Verificar pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente — não precisa estar atualizado.
2. **Executar o playbook diretamente no top-level (#207).** Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa em sequência **§ 0 Setup** (que inclui refresh de `past-editions.md` via `scripts/refresh-past-editions.ts` e inbox drain via `scripts/inbox-drain.ts`) + **§ 1 Stage 1 — Research**. **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `source-researcher`, `discovery-searcher`, `eai-composer`, `research-reviewer`, `scorer` em paralelo conforme o playbook prescreve.

   Variáveis pra alimentar o playbook:
   - `edition_date = $1` (AAMMDD)
   - `edition_iso = 20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}`
   - `window_days = {valor confirmado no Passo 1}`
   - `stop_after_stage = 1` (parar após o gate do Stage 1)

   O playbook executa: refresh de `past-editions.md` → inbox drain → paralelismo (source-researcher × N + discovery-searcher × M + eai-composer background) → `scripts/verify-accessibility.ts` → `scripts/enrich-inbox-articles.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `scripts/topic-cluster.ts` → `scripts/filter-date-window.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` → drive push → GATE.

## Output

`data/editions/{AAMMDD}/_internal/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `_internal/01-approved.json`.
