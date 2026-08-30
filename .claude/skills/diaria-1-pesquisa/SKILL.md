---
name: diaria-1-pesquisa
description: Roda apenas a Etapa 1 (pesquisa + verify + dedup + categorize + score). Útil para retry isolado. Uso — `/diaria-1-pesquisa AAMMDD`.
---

# /diaria-1-pesquisa

Executa só a Etapa 1 da pipeline.

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação.
- `--window N` / `--window-days N` (opcional, #1751) = janela em dias (inteiro ≥ 1). Presente → usa N direto, sem perguntar. Ausente → default 4 dias silenciosamente, sem gate.
- `--no-gates` (opcional, #5738) = auto-aprova o gate deste stage. Existe para o runner AGENDADO (`scripts/overnight/run-scheduled-edicao.ts`), que desde o #5738 invoca uma skill `/diaria-N-*` por sessão em modo `--print`: sem esta flag o gate seria apresentado e ninguém responderia, queimando os turnos da sessão sem escrever sentinela. Equivale ao `auto_approve = true` que `/diaria-edicao` já setava internamente para os Stages 1-3 (pre-gate mode, #1523). **Nunca alcança publicação** — Stages 5/6 não estão em `STAGE_PLAN` e o runner nunca os invoca. **Controla só `auto_approve`, não `pre_gate`** (ver flag seguinte, #6719) — as duas perguntas são distintas: "este stage pode auto-aprovar o PRÓPRIO gate?" (`--no-gates`) vs "o editor está presente supervisionando a sessão-mãe?" (`--session-supervised`).
- `--session-supervised` (opcional, #6719) = seta `pre_gate = true` para o playbook, **independente de `--no-gates` também estar presente**. Existe para `/diaria-edicao` (via `scripts/lib/edition-stage-runner.ts` / `run-edition-stages.ts`), que desde o #5744 spawna este Stage 1 num processo `claude` próprio e SEMPRE passa `--no-gates` a ele (é o que permite o subprocesso terminar sem editor para responder ao gate interno) — mesmo quando a invocação original de `/diaria-edicao` tinha o editor presente e sem `--no-gates`. Sem esta flag, `pre_gate` fica sempre `false`/undefined nesse caminho, e `orchestrator-stage-0-preflight.md` § 0-replies (rascunhos do concurso "ache o erro") nunca roda — nem quando o editor está de fato supervisionando. Runner agendado e uso manual standalone nunca passam esta flag (não há editor presente); `pre_gate` continua `false`/undefined nesses casos, comportamento inalterado.

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
2. **Resolução de `window_days` (#1751 — sem gate obrigatório):**
   - Arg `--window N` / `--window-days N` válido (inteiro ≥ 1) → `window_days = N`, recalcular `window_start` (`WINDOW_END − (N−1)`), seguir **sem perguntar**.
   - Sem arg → assumir **default 4 dias silenciosamente**, sem gate.
   - Só perguntar (fallback) quando `--window` veio inválido:

   ```
   Janela de publicacao aceita: {window_start} -> {WINDOW_END} (4 dias)
   --window invalido. Digite ok para o default (4) ou um numero de dias:
   ```

   Interpretar: Enter / "ok" / "sim" → default 4; número N ≥ 1 → `window_days = N`, recalcular; outra coisa → repetir.

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
   - `auto_approve = true` **se e somente se `--no-gates` foi passado** (#5738); ausente a flag, `false` — que é o default de `orchestrator-stage-0-preflight` e mantém o gate do Stage 1 exatamente como sempre foi em invocação manual. É esta linha que faz a flag valer alguma coisa: sem ela, `--no-gates` seria aceito e ignorado.
   - `pre_gate = true` **se e somente se `--session-supervised` foi passado** (#6719) — independente do valor de `--no-gates`/`auto_approve` acima. Ausente a flag, `pre_gate` fica `undefined` (skip de § 0-replies, comportamento pré-existente). É esta linha que faz `orchestrator-stage-0-preflight.md` § 0-replies rodar quando `/diaria-edicao` spawna este Stage 1 com o editor presente na sessão-mãe.

   O playbook executa: refresh de `past-editions.md` → inbox drain → paralelismo (source-researcher × N + discovery-searcher × M + eia-composer background) → `scripts/verify-accessibility.ts` → `scripts/enrich-inbox-articles.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `scripts/topic-cluster.ts` → `scripts/filter-date-window.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` → drive push → **pre-gate validator** → GATE.

## Passo 3 — Pre-gate validator (#581)

Antes de apresentar o gate humano, rodar. **#3530:** `{EDITION_DIR}` já foi resolvido no § 0 Setup (via `find-current-edition.ts --resolve`, mesma sessão) — reusar aqui, nunca montar `data/editions/$1/` à mão (a edição pode estar em layout flat legado OU nested):

```bash
npx tsx scripts/validate-stage-1-output.ts \
  --edition $1 \
  --edition-dir {EDITION_DIR}/
```

Semântica completa (exit codes, output JSON, falha do próprio validator) em **[`docs/validate-stage-1-output-semantics.md`](../../../docs/validate-stage-1-output-semantics.md)** — single source of truth (#832).

## Output

`{EDITION_DIR}/_internal/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `_internal/01-approved.json`.

## Passo 5 — Escrever sentinel de conclusão (#6827)

**Obrigatório, em TODO caso (headless ou com editor presente).** O sentinel `.step-1-done.json` é o que o orchestrator usa pra detectar que o Stage 1 completou — sem ele, a próxima retomada ou o próximo stage não sabe que o trabalho já está feito, e a edição fica presa em "pending" indefinidamente (#6827).

Sempre que o gate for aprovado (ou `--no-gates` auto-aprovar), rodar:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition $1 \
  --step 1 \
  --outputs "01-categorized.md,_internal/01-categorized.json,_internal/01-approved.json"
```

**Ordem:**
1. Se o editor editou o MD no gate: rodar `npx tsx scripts/apply-gate-edits.ts --md {EDITION_DIR}/01-categorized.md --json {EDITION_DIR}/_internal/01-categorized.json --out {EDITION_DIR}/_internal/01-approved.json` antes.
2. Se `--no-gates` (auto_approve): rodar `npx tsx scripts/apply-gate-edits.ts --auto --json {EDITION_DIR}/_internal/01-categorized.json --out {EDITION_DIR}/_internal/01-approved.json` antes.
3. Depois, rodar o `pipeline-sentinel.ts write` acima.
4. Depois, arquivar inbox: `npx tsx scripts/archive-inbox.ts --edition $1 --inbox-md data/inbox.md` (fail-soft).

**Não pule este passo em lugar nenhum** — nem em headless, nem quando o orchestrator playbook §1y já menciona o sentinel. O playbook é prosa; este passo é mecânico, e é o que impede que uma sessão `--print` escale o sentinel (#6827).

## Passo 4 — Fechar task tracking pós-gate (#904)

**Imediatamente após gate aprovado** (quando o sentinel `pipeline-sentinel.ts write --step 1` for executado em 1y do orchestrator), marcar todas as tasks `Stage 1*` (incluindo `Stage 1x — GATE HUMANO`) como `completed` via `TaskUpdate`. Sem isso, o timer da task de gate continua rodando indefinidamente na UI mesmo com Stage 2 já dispatchado.

**No-op se TaskUpdate não estiver disponível** (CLI puro). A invariante completa está em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene".
