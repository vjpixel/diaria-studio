---
name: diaria-edicao
description: Roda a pipeline completa da Diar.ia (5 etapas). Uso — `/diaria-edicao AAMMDD [--no-gates] [--skip canal[,canal...]]`.
---

# /diaria-edicao

Executa a pipeline completa da Diar.ia. **Modo default: pre-gate** (#1523) — Stages 0-3 rodam auto-approve, o gate humano principal é no Stage 4 (Revisão) antes do dispatch dos publishers. Editor revisa HTML preview + social; aprovado → Stage 5 (Publicação) dispara.

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir amanhã como atalho principal (regra D+1 — edição é sempre o dia seguinte à pesquisa), com hoje como secundário, mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? amanhã ({AAMMDD_amanha}) / hoje ({AAMMDD_hoje}) / outra (informe AAMMDD)"
- `--window N` (ou `--window-days N`, opcional) = janela de publicação em dias (inteiro ≥ 1). Quando presente, usar `window_days = N` direto, **sem perguntar**. Ausente → assumir o default (4 dias) silenciosamente, **sem gate** (#1751).
- `--no-gates` (opcional) = pular TODOS os gates, inclusive o gate de revisão do Stage 4 e a confirmação interativa do Stage 5. Auto-aprova tudo. Social scheduling e demais comportamentos permanecem normais.
- `--skip {canal[,canal...]}` (opcional, CSV) = encaminha lista de canais ao Stage 5 como `skip_channels`. Canais suportados: `newsletter`, `linkedin`, `facebook`. Canais listados ficam `pending_manual` no consent (`build-publish-consent.ts --skip "{lista}"`, path 1 de §5b); o Stage 5 executa pré-render completo mas NÃO dispatcha esses canais. Sem `--skip`, o comportamento default do Stage 5 (#1326) se aplica — se editor não responder ao gate interativo, tudo é automático. Use `--skip newsletter,linkedin,facebook` em runs headless/automáticas (Task Scheduler) para impedir dispatch sem supervisão (#2068).

## Pré-requisitos

Antes de iniciar, verifique:
1. `context/audience-profile.md` existe e não é placeholder. Se for, avise: rode `/diaria-atualiza-audiencia` primeiro (muda lento, rodar semanalmente/mensalmente).
2. `context/sources.md` existe. Se não, rode `npm run sync-sources`.
3. `data/past-editions.md` **não precisa estar atualizado** — o orchestrator regenera automaticamente via Beehiiv MCP no Stage 0.

## Passo 0 — Sincronizar código com origin/master (#2686)

**Antes de qualquer trabalho do Stage 0**, sincronizar o checkout local com `origin/master` para garantir que a edição rode com a versão mais recente do pipeline. Rodadas overnight/develop mergeiam frequentemente; código defasado re-introduz bugs corrigidos.

```bash
npx tsx scripts/sync-code.ts
```

O script imprime JSON com o resultado (campos `outcome`, `branch_before`, `warnings`). **Parsear o JSON do stdout** e extrair os valores individuais — nunca passar o blob inteiro pro `--details`. Logar via `log-event.ts`, escolhendo `--level info` para os 3 outcomes de sucesso e `--level warn` para os demais (coluna `--level` da tabela):

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator \
  --level {info ou warn, conforme a tabela} --informational --message "git-sync: {outcome}" \
  --details '{"outcome":"{outcome}","branch_before":"{branch_before}"}'
```

(`--informational` evita que warns de sync virem issues falsas no auto-reporter, análogo a §0k/§0l do preflight.)

**Comportamento por outcome:**

| outcome | `--level` | ação |
|---|---|---|
| `synced` / `synced_stashed` / `already_up_to_date` | `info` | ✅ prosseguir normalmente |
| `fetch_failed` | `warn` | ⚠️ avisar editor ("offline — edição continua com código local") e prosseguir |
| `ff_failed` | `warn` | ⚠️ avisar editor ("código divergiu de origin — edição continua com cópia local; considere resolver manualmente") e prosseguir |
| `stash_failed` / `stash_pop_failed` | `warn` | ⚠️ avisar editor com a mensagem de warning do resultado e prosseguir |
| `stash_partial_failure` (#3411) | `warn` | ⚠️ stash saiu com erro mas CRIOU um stash apesar disso (ex: falha parcial ao limpar untracked) — recuperado automaticamente via pop; avisar editor com a mensagem e prosseguir |
| `stash_partial_failure_unrecovered` (#3411) | `warn` | 🛑 idem, mas o pop automático TAMBÉM falhou — stash preservado (nunca descartado), avisar editor com URGÊNCIA (mensagem cita o hash do stash para investigação manual) e prosseguir |
| `checkout_failed` | `warn` | ⚠️ avisar editor ("estava em outra branch e não foi possível voltar para master") e prosseguir |
| `sync_in_progress` (#3423) | `warn` | ⚠️ outro `syncCode()` já está rodando neste checkout (lock ativo) — sync desta rodada foi pulado para evitar popar o stash de um processo concorrente; avisar editor ("código pode estar levemente desatualizado, outra sincronização em andamento") e prosseguir |

**Regras invariáveis:**
- **Nunca bloquear a edição por falha de sync** — `proceed` é sempre `true` no resultado. Falha de sync vira warning, nunca halt.
- **Só no início, nunca mid-edição.**
- **Idempotente no resume.** Re-rodar `/diaria-edicao {mesmo AAMMDD}` faz o sync novamente sem efeito colateral indesejado.
- **Nunca forçar merge.** Usa `--ff-only` exclusivamente; divergência vira warn.

## Passo 1 — Confirmar janela de publicação aceita

Converter `$1` (AAMMDD) para ISO date interno:
```bash
node -e "const s='$1';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))"
```
Armazenar o resultado como `$ISO` (ex: `260423` → `2026-04-23`). Usar `$ISO` em todo Date math abaixo.

1. **Janela = 4 dias corridos terminando em D+0** (#315).
   Stage 1 roda em D+0 (dia antes da publicação). Endpoint superior = D+0 = `$ISO − 1 dia`.
   ```bash
   node -e "const d=new Date('$ISO');d.setUTCDate(d.getUTCDate()-1);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `WINDOW_END`. `window_days = 4` fixo.
   ```bash
   node -e "const d=new Date('$WINDOW_END');d.setUTCDate(d.getUTCDate()-3);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `window_start`.

**Resolução de `window_days` (#1751 — sem gate obrigatório):**

1. **Arg `--window N` / `--window-days N` presente:** validar N inteiro ≥ 1. Válido → `window_days = N`, recalcular `window_start` a partir de `WINDOW_END` (`WINDOW_END − (N−1)`). Seguir direto pro Passo 2, **sem perguntar**. Inválido (não-inteiro / < 1) → aí sim perguntar (fallback, ver abaixo).
2. **Sem arg de janela (caso comum):** assumir o **default 4 dias silenciosamente** e seguir pro Passo 2 — **sem o gate de confirmação**. (Antes exigia `ok`; #1751 torna implícito.) Logar a janela efetiva (opcional) em `data/run-log.jsonl` com `source: "default"`.
3. **`--no-gates`:** idêntico — usar os valores calculados sem perguntar.

Logar `window_days` efetiva com `source: "arg" | "default"` pra rastreabilidade (análogo a `_internal/05-publish-consent.json`, #1326), quando viável.

**Fallback (só quando `--window` veio inválido):** exibir e aguardar resposta:

   ```
   Janela de publicacao aceita: {window_start} -> {WINDOW_END} (4 dias)
   --window invalido. Digite ok para o default (4) ou um numero de dias:
   ```

   Interpretar: vazia / "ok" / "sim" → default 4; inteiro N ≥ 1 → `window_days = N`; outra coisa → repetir.

## Passo 2 — Executar o playbook diretamente no top-level (#207)

**Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa o playbook stage-a-stage diretamente.** **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `source-researcher`, `discovery-searcher`, `eia-composer`, `research-reviewer`, `scorer`, `writer`, `title-picker`, `social-writer` (#3991, reverte #3486), `social-curto` (#3992), `auto-reporter` em paralelo conforme cada stage prescreve. **`publish-newsletter` também é executado pelo top-level direto como playbook (#1054)** — não dispatchá-lo via `Agent` porque `javascript_tool` é restrita ao top-level e o paste-into-htmlSnippet falha em subagentes.

Variáveis pra alimentar o playbook (passar mentalmente como contexto, não como prompt de Agent):
- `edition_date = $1` (AAMMDD)
- `edition_iso = 20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}`
- `window_days = {valor confirmado no Passo 1}`
- `auto_approve = true` (Stages 1-3 sempre auto-approve em `/diaria-edicao` — pre-gate mode #1523)
- `pre_gate = true` se `--no-gates` NÃO foi passado (Stage 4 apresenta gate de revisão; Stage 5 apresenta confirmação de canais)
- `skip_channels = {csv passado em --skip, ou vazio}` — encaminhado ao Stage 5 §5b; se não-vazio, Stage 5 usa path 1 (`build-publish-consent.ts --skip "{skip_channels}"`) sem gate interativo, sem fallback default-auto (#1326/#2068)


Sequência de etapas (do playbook em `.claude/agents/orchestrator.md`):
- **§ 0 Setup** — resume detection, Chrome MCP probe, refresh `past-editions.md`, inbox drain, log de início
- **§ 1 Etapa 1 — Pesquisa** (É IA? dispatcha em background) → auto-approve
- **§ 2 Etapa 2 — Escrita** (newsletter + social em paralelo) → auto-approve
- **§ 3 Etapa 3 — Imagens** (É IA? gate + imagens de destaque) → auto-approve
- **§ 4 Etapa 4 — Revisão** (#1694):
  1. Pré-render técnico (HTML + imagens + upload Worker + close-poll)
  2. **GATE HUMANO** — apresenta resumo consolidado: destaques, títulos, links, lints, preview HTML + social ao editor
  3. Aprovado → grava sentinel `.step-4-done.json`
  → aguarda Stage 5
- **§ 5 Etapa 5 — Publicação** (prereq: sentinel Stage 4 aprovado):
  1. Confirmação de canais (interativa ou via `--skip`)
  2. Dispatch publishers paralelos (Beehiiv + Facebook + LinkedIn)
  3. Test email + review loop
  4. Auto-reporter + relatório por email
  → fim

**Modo pre-gate (default):** Stages 1-3 auto-approve. Stage 4 gate de revisão é o único ponto de interação antes do dispatch. `auto_approve = true` internamente para Stages 1-3; Stage 4 consulta editor no gate de revisão; Stage 5 executa em sequência após aprovação.

**Se `--no-gates`:** auto-aprovar TUDO, inclusive o gate do Stage 4 e a confirmação interativa do Stage 5. Pipeline roda fim-a-fim sem interação.

Resume-aware: ao retomar, listar arquivos em `data/editions/{AAMMDD}/` e pular para o stage adequado conforme as condições do § 0 Setup.

## Outputs

Todos em `data/editions/{AAMMDD}/` (ex: `260418/`):
- `01-categorized.md`, `01-eia.md`, `01-eia-A.jpg`, `01-eia-B.jpg` (edições antigas pré-#192: `01-eia-real.jpg`/`01-eia-ia.jpg`)
- `02-reviewed.md`
- `03-social.md`
- `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `05-published.json`
- `06-social-published.json`
- `_internal/` — JSON intermediários, drafts, diffs, prompts
