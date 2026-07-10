---
name: orchestrator-stage-4
description: Detalhe da Etapa 4 (revisão editorial assistida — resumo consolidado + gate humano pré-publicação) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 4 — Revisão editorial assistida (#1694)

Antes de publicar, o orchestrator monta um **resumo consolidado da edição final** e apresenta ao editor num gate humano explícito. Aprovado → segue para Etapa 5 (Publicação). O pre-render técnico (HTML + imagens + upload + close-poll, o antigo §4a-pre-gate) ocorre neste stage, tornando a revisão visual e completa.

**`--no-gates` behavior:** quando `auto_approve = true` (via `--no-gates`), o orchestrator executa o pré-render completo e pula **apenas o gate humano** — o resumo é gerado mas não apresentado. Prossegue automaticamente para Etapa 5.

**`{EDITION_DIR}` (#2463/#3025):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Resolver **uma vez**, logo após ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` à mão:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pré-condição: sentinel Stage 3

<!-- outputs must match the `write` call at the end of orchestrator-stage-3.md §Escrever sentinel de conclusão do Stage 3 -->

**#2316: 2-destaque editions** — antes de rodar o sentinel, verificar quantos destaques a edição tem:
```bash
npx tsx scripts/extract-destaques.ts {EDITION_DIR}/02-reviewed.md 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String(d.destaques.length))"
```
Se 2 destaques: usar `--outputs` sem `04-d3-*.jpg` (os arquivos D3 não existem). Se 3 destaques: comando padrão abaixo.

**3 destaques (padrão):**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg,04-d3-2x1.jpg,04-d3-1x1.jpg"
```

**2 destaques:**
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-2x1.jpg,04-d2-1x1.jpg"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 3 não completou (sentinel ausente). Re-rodar `/diaria-3-imagens {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 3 ausentes. Re-rodar Etapa 3." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message "stage3_sentinel_missing_legacy"`), continuar.

### 4a. Pré-requisitos + sync

**Marcar Stage 4 `running` no início (#1783).** Garante o `start` pra que o `done` do §4i feche a duração no relatório. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status running
```

**⚠️ MCP fail-fast (#738):** Durante qualquer passo desta etapa, se um `<system-reminder>` do runtime indicar que um MCP ficou offline, **parar imediatamente**, logar via:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator \
  --level warn --message "mcp_disconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_disconnect"}'
```
E renderizar halt banner pra alertar o editor (#737):
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "4 — Revisão" \
  --reason "mcp__{server_name} desconectado" \
  --action "responda 'retry' para continuar ou 'abort' para encerrar Etapa 4"
```
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message 'etapa 4 revisao started'
  ```
- **Sync pull antes de começar** (todos os arquivos que entram na revisão + pre-render):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir {EDITION_DIR}/ --stage 4 --files 02-reviewed.md,01-eia-A.jpg,01-eia-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
  ```
  Editor pode ter refinado texto/imagens no Drive.

### 4b. Pré-render técnico

**Pré-render completo sempre roda** (independente de `auto_approve`) — garante que `newsletter-final.html` e previews estejam prontos pra revisão e pra publicação. Com `--no-gates` o gate é pulado, mas o pré-render nunca é.

0. **capture-livros-promo — ANTES do upload (#2071).** Re-captura o screenshot da página de livros se o conteúdo mudou (md5 diferente):
   ```bash
   npx tsx scripts/capture-livros-promo.ts --edition-dir {EDITION_DIR}/
   ```
   Exit code handling: `0` = imagem nova em `04-livros-promo.jpg`; `2` = md5 igual, nada a fazer; `1` = falha — logar warn + continuar (asset opcional).

1. **upload-images-public — TODOS modos** (cobre pre-render completo):
   ```bash
   npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode newsletter
   npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
   ```

2. Pre-render do newsletter HTML — seguir steps 1-5 do `context/publishers/beehiiv-playbook.md` **sem** o Chrome MCP / Beehiiv interaction. Output: `_internal/newsletter-final.html` + URL no draft worker. **Capturar a `url` do JSON stdout de `upload-html-public.ts`** — Worker usa key `html:{AAMMDD}-{contentHash}` (#1494, hash dos primeiros 6 chars de md5 do HTML). Sem o hash, fetch retorna 404 (review #1612 regression).

   **Exit codes de `substitute-image-urls.ts` (#2316, #2335):**

   | Exit | Significado | Ação |
   |------|-------------|------|
   | `0` | Sucesso | Continuar |
   | `1` | Erro de args (CLI) | Verificar comando; abortar |
   | `2` | Placeholders não resolvidas | Abortar — verificar `06-public-images.json` e fluxo de upload |
   | `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | Re-rodar `render-newsletter-html.ts` primeiro, depois re-rodar `substitute-image-urls.ts`. **Não é fatal** — não tratar como falha de pipeline. |

   > **Exit 3 (#2316):** mensagem stderr: `[substitute-image-urls] ERRO: HTML de input está desatualizado`. Ação: re-renderizar e re-substituir. Ver beehiiv-playbook.md §1.3 para o exit-code table completo.

3. Pre-render do social preview HTML:
   ```bash
   # #1800: --images é OBRIGATÓRIO — sem ele o preview sai sem imagens.
   npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json
   # #1734: --persist-to grava a URL durável (com hash) em 05-social-preview.json.
   npx tsx scripts/upload-html-public.ts --edition {AAMMDD}-social --html {EDITION_DIR}/_internal/social-preview.html --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url
   ```

4. close-poll (set gabarito — idempotente):
   ```bash
   npx tsx scripts/close-poll.ts --edition {AAMMDD}
   ```

5. **Pre-dispatch invariants (#1007 Fase 1).** Validar que `06-public-images.json` está populado e env vars críticas estão setadas:
   ```bash
   npx tsx scripts/check-invariants.ts --stage 4 --edition-dir {EDITION_DIR}/
   ```
   Exit 1 = pausar com violations no stderr. Editor corrige e re-roda.

### 4c. Montar resumo consolidado da edição

Coletar e organizar todas as informações da edição final para apresentar ao editor. **Reusar os validate-*/lint-* existentes** para gerar o relatório — nada novo aqui, apenas consolidação.

**4c.1 — Destaques + títulos + links:**
- Ler `_internal/01-approved.json` para os destaques aprovados (D1, D2, D3) com `url`, `category`, `score`.
- Ler `02-reviewed.md` para extrair os títulos escolhidos (1 por destaque após poda) e os URLs no corpo final.
- Verificar acessibilidade dos 3 URLs principais (simples HEAD request, ~3s):
  ```bash
  npx tsx scripts/verify-accessibility.ts --urls "{url1},{url2},{url3}" --out /dev/null
  ```
  Capturar `verify_verdict` (accessible/inaccessible/timeout) para cada URL. Inacessível = mostrar ⚠️ no resumo mas não bloquear.

**4c.2 — Lints consolidados:**
```bash
npx tsx scripts/validate-lancamentos.ts {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --md {EDITION_DIR}/02-reviewed.md --approved {EDITION_DIR}/_internal/01-approved.json
npx tsx scripts/lint-newsletter-md.ts --check secondary-items-have-summary --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check no-untranslated-summary --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check title-publisher-suffix --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check title-trailing-period --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check no-trailing-ellipsis --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check mid-sentence-ellipsis --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check stacked-intro-callouts --md {EDITION_DIR}/02-reviewed.md
npx tsx scripts/lint-newsletter-md.ts --check orphan-box-in-gap --md {EDITION_DIR}/02-reviewed.md
```
Capturar violations. Críticas (P1) = mostrar ❌ no resumo com ação sugerida.

`secondary-items-have-summary` (#2545): **GATE-BLOCKING** quando exit 1 — item de LANÇAMENTOS/RADAR/USE MELHOR sem descrição renderiza título pelado no email. Ação: editar `02-reviewed.md` e adicionar descrição plain text (1 frase) abaixo de cada item pelado, ou re-rodar Etapa 1 (se a causa foi cache-miss no enrich).

`no-untranslated-summary` (#3196): **GATE-BLOCKING** quando exit 1 — item de LANÇAMENTOS/RADAR/USE MELHOR com marcador literal `[TRADUZIR]` OU descrição detectada como inglês pela heurística de stopwords (mesmo sem o marcador, caso o humanizador tenha removido o prefixo sem traduzir o texto). `stitch-newsletter.ts` injeta `[TRADUZIR] ` em descrições EN e depende do humanizador (LLM) pra traduzir — sem este lint, o item vazava pro gate/publicação intacto (incidente 260709). Ação: traduzir a descrição pra PT-BR em `02-reviewed.md` e remover o prefixo `[TRADUZIR] ` antes de aprovar.

`title-publisher-suffix` + `title-trailing-period` (#2664/#2672): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com linha + sufixo/título, sem bloquear o gate. A normalização automática roda no Stage 1 (`enrich-inbox-articles.ts` → `normalizeItemTitle`); estes lints são backstop pré-gate para resíduos que escapam (títulos gerados pelo writer LLM ou curados pelo editor). O check de sufixo usa heurística de 1–4 palavras (pode ter falso-positivo em traço editorial legítimo) — por isso WARN, não BLOCK. Ação sugerida ao editor: remover o sufixo de veículo / ponto final em `02-reviewed.md` antes de aprovar.

`no-trailing-ellipsis` (#2881, estendido em #3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho final da descrição. Backstop para a sanitização automática que roda no Stage 1 (`enrich-inbox-articles.ts` → `sanitizeTrailingEllipsis`): muitos veículos truncam a própria meta-description com "…"/"..." e isso vaza pro item de RADAR/USE MELHOR/LANÇAMENTOS como se a frase tivesse sido cortada por nós. Diferente do irmão mais antigo `truncated-secondary-item-summary` (#2596, com carve-outs pra idiomas de suspense/fechamento intencional), este check é deliberadamente estrito: qualquer descrição terminando em reticência é flagrada, sem exceção — os dois podem disparar juntos na mesma linha. #3196: agora ignora um sufixo `(N min)` (estimativa de tempo do USE MELHOR) ao checar o fim da string — antes uma descrição como "Então... (5 min)" "terminava" em "(5 min)", não em "…", e escapava. Ação sugerida ao editor: reescrever a descrição em `02-reviewed.md` antes de aprovar.

`mid-sentence-ellipsis` (#3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho da descrição. Backstop irmão de `no-trailing-ellipsis`, mas pro caso da reticência aparecer no MEIO da descrição (não só no fim) — sintoma de outlet (ex: G1) truncando a própria meta-description no meio da frase. Heurística ampla sem allowlist (mesma justificativa #2715): também pode disparar em reticência estilística legítima no meio de uma frase — o editor decide caso a caso. Ação sugerida: reescrever a descrição em `02-reviewed.md` antes de aprovar, se de fato for truncamento da fonte.

`stacked-intro-callouts` (#2729): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com as linhas dos blocos empilhados. Detecta ≥2 blocos `**(🎉|📣)…**` na região de intro (antes do 1º `**DESTAQUE`) — `extractIntroCallout` (#2727) é greedy e funde os 2 blocos num só, vazando `**` internos como texto literal e perdendo o separador "Divulgação" do bloco patrocinado. `inject-champions-callout.ts` (Stage 3) já pula a auto-injeção quando um callout preexiste, mas isso não cobre colagem manual de 2 blocos pelo editor no Drive — daí o lint como backstop. Ação sugerida: mesclar os 2 CTAs num único bloco, ou mover o 2º para uma lacuna entre destaques (box de divulgação).

`orphan-box-in-gap` (#3204): **GATE-BLOCKING** quando exit 1. Backstop pós marcador-agnóstico — `newsletter-parse.ts`'s `locateBoxInGap` (Stage 4 pre-render, via `render-newsletter-html.ts`) já detecta o box de divulgação numa lacuna D1/D2 ou D2/D3 por POSIÇÃO (qualquer bloco `---`-isolado após o próprio destaque), não por um allowlist de marcadores emoji — um marcador novo (📖, 🎥, 🎁, ...) não precisa mais de nenhuma mudança de código. Este lint cobre os 2 jeitos de isso AINDA falhar silenciosamente: (a) um bloco com CARA de box (bold-line inteiro `**...**` OU parágrafo emoji-led) colado DENTRO da seção do destaque anterior, sem `---` isolando-o — não vira box, é absorvido no corpo/why do destaque (caso 260609); (b) uma lacuna com MAIS de 1 bloco `---`-isolado extra — ambíguo, só o 1º vira box, o(s) demais seria(m) descartado(s) em silêncio. Ação sugerida ao editor: isolar o box em sua PRÓPRIA seção, entre o `---` que fecha o destaque anterior e o `---` que abre o próximo — exatamente 1 bloco extra por lacuna. Gate só pode ser aprovado (`sim`) após lint verde (exit 0).

**4c.2b — Lint social + consistência post_pixel + sentinel humanizador (#2145, #2279):**
```bash
npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md {EDITION_DIR}/03-social.md
```
Compara tokens (Jaccard) do `## post_pixel` com o main de cada `## d{N}`. Falha quando post_pixel é claramente mais parecido com outro destaque que com o D1 vigente. Sinal de que houve reordenação pós-Stage-2 sem re-sincronizar o post pessoal. **Exit 1 = GATE-BLOCKING** (igual aos outros lints invariantes de §4c.2) — ❌ mostrar no resumo com ação: "post_pixel stale — re-sincronizar com D1 atual antes de aprovar". Gate só pode ser aprovado (`sim`) após lint verde (exit 0).

**Antítese-revelação social (#2526) — WARN-ONLY:**
```bash
npx tsx scripts/lint-social-md.ts --check no-antithesis-reveal --md {EDITION_DIR}/03-social.md
```
Detecta construções de "negar pra revelar" que soam a IA (ex: "não é X, é Y", "de verdade, não só", "o que me chama atenção não é..."). **Exit 0 mesmo com matches** — exibir como ⚠️ no `{violations_block}` com linha + trecho, sem bloquear o gate.

**Gancho editorial emendado social (#2658) — WARN-ONLY:**
```bash
npx tsx scripts/lint-social-md.ts --check no-trailing-editorial-hook --md {EDITION_DIR}/03-social.md
```
Primo de #2526: detecta ", e [gancho editorial]" emendado no fim de uma frase (ex: "...entrou em prévia, e a escolha de focos diz mais sobre estratégia do que os benchmarks costumam revelar"). **Exit 0 mesmo com matches** — exibir como ⚠️ no `{violations_block}` com linha + trecho, sem bloquear o gate. (#2715 — antes desta chamada explícita, o check só rodava como invariante `stage: 2` sem nenhum ponto de apresentação ao editor, e o campo `trailing_hook_matches` de `check-humanizer-social.ts` só era impresso no caminho raro de hash-mismatch pós-humanizador; agora roda sempre, no caminho comum.)

**Guard determinístico do humanizador social (#2279, #2529):**
```bash
npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
```
Exit code handling:
- `0` → humanizador rodou e `03-social.md` não foi editado depois. Continuar.
- `1` → **GATE-BLOCKING:** sentinel ausente — humanizador não rodou no social ou sentinel não foi gravado. Ação: re-rodar humanizador, depois `--write`, antes de aprovar.
- `2` → **GATE-BLOCKING:** `03-social.md` foi editado/reordenado após humanização (hash diverge — caso real: edição inline em §4d.1 ou reorder de destaques).

  **#2529 — Tic lint automático no exit 2:** quando o hash diverge, o guard roda automaticamente `lintAntithesisReveal` sobre o `03-social.md` atual e emite WARNs adicionais no stderr. Se o stderr contiver `⚠️  TICS DE IA DETECTADOS`, incluir esses tics no bloco `{violations_block}` do gate como `⚠️ Social editado pós-humanizador acusa tics de IA (lista abaixo) — considere re-humanizar`. Se o stderr contiver apenas `ℹ️  Lint de tics: nenhum tic detectado`, a edição pode ter sido só remoção de tic — apresentar essa informação ao editor para auxiliar a decisão. O evento é sempre logado no run-log automaticamente.

  **Re-humanizar antes de aprovar** (quando exit 2, independente de tics):
  ```
  Skill("humanizador", "Leia {EDITION_DIR}/03-social.md, humanize o texto removendo marcas de IA … Salve no mesmo arquivo.")
  ```
  Após humanização: (a) re-rodar lints do §2c que cobrem qualidade social:
  ```bash
  npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
    --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md \
    --md {EDITION_DIR}/03-social.md
  npx tsx scripts/lint-social-md.ts --check relative-time --md {EDITION_DIR}/03-social.md
  npx tsx scripts/lint-social-md.ts --check linkedin-schema --md {EDITION_DIR}/03-social.md
  ```
  (b) gravar sentinel: `npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/`
  (c) re-rodar o check; só prosseguir quando exit 0.

**4c.3 — Imagens geradas:**
- Listar `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` com tamanhos (bytes).
- URL pública no Worker KV: `{newsletter_url}` (capturada em §4b step 2).

**4c.4 — Social preview:**
- Social preview URL: `{social_url}` (de `_internal/05-social-preview.json`).
- Ler `03-social.md` para exibir os títulos dos 6 posts (3 LinkedIn + 3 Facebook) em tabela.

**4c.5 — Diffs vs fonte (#1694 — novo no Stage 4):**
- Comparar os títulos finais em `02-reviewed.md` com os títulos originais em `_internal/01-approved.json` para mostrar se houve mudança editorial.
- Informativo — sem bloqueio.

**4c.6 — Fact-check de claims (#2455):**

Disparar o subagente `fact-checker` em paralelo com (ou logo após) os lints acima:

```bash
# 1. Validar pré-condições e obter parâmetros para o subagente:
npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/
```

Em seguida, despachar o subagente `fact-checker` via Agent tool com os parâmetros:
```
Agent("fact-checker", {
  newsletter_path: "{EDITION_DIR}/02-reviewed.md",
  social_path: "{EDITION_DIR}/03-social.md",
  approved_json_path: "{EDITION_DIR}/_internal/01-approved.json",
  out_path: "{EDITION_DIR}/_internal/fact-check.json"
})
```

Após o subagente concluir (gravar `_internal/fact-check.json`), formatar o gate summary:
```bash
# 2. Formatar seção para o gate (lê o fact-check.json gravado pelo subagente):
npx tsx scripts/run-fact-checker.ts --edition-dir {EDITION_DIR}/ \
  --input-json {EDITION_DIR}/_internal/fact-check.json
```

**Exit code handling:**
- `0` → capturar stdout (seção formatada) e incluir na seção `━━━ FACT-CHECK` do gate.
- `1` → fact-checker não rodou (pré-condição falhou ou arquivo ausente) → mostrar `⚠️ Fact-check indisponível: {motivo do stderr}` no gate. **Não bloquear** — fact-check é assistido, não gate-blocking.

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (grava `_internal/fact-check.json`), mas pular a apresentação no gate (que é pulado inteiramente). O arquivo fica disponível para auditoria pós-edição.

**4c.6b — Auto-fix de DIVERGENT determinístico (#2598):**

Após o subagente gravar `_internal/fact-check.json`, aplicar correções automáticas de claims `DIVERGENT` com `suggested_fix` presente — antes de montar o gate:

```bash
npx tsx scripts/apply-factcheck-autofix.ts --edition-dir {EDITION_DIR}/
```

Exit code handling:
- `0` → capturar stdout e JSON `_internal/fact-check-autofix.json`.
- `1` → logar warn; continuar sem auto-fix (não bloqueia gate).

**⚠️ Re-render obrigatório quando `applied > 0` (#2617):** o pré-render de §4b gerou `newsletter-final.html` ANTES do autofix. Se `fact-check-autofix.json` mostra `summary.applied > 0`, re-rodar render + substitute + upload para garantir que o HTML publicado contenha o texto corrigido:

```bash
# Re-render newsletter HTML com o 02-reviewed.md já corrigido
npx tsx scripts/render-newsletter-html.ts {EDITION_DIR}/ --format html --out {EDITION_DIR}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts \
  --html {EDITION_DIR}/_internal/newsletter-draft.html \
  --out {EDITION_DIR}/_internal/newsletter-final.html \
  --images {EDITION_DIR}/06-public-images.json
# Re-upload HTML (atualiza a URL do Worker com o novo conteúdo)
# --no-wrap é OBRIGATÓRIO (#2550): sobe o fragmento bruto, igual ao §4b/beehiiv-playbook.md.
# Sem ele o Worker hospeda o HTML embrulhado no preview-wrapper → paste no Beehiiv quebra.
npx tsx scripts/upload-html-public.ts --edition {AAMMDD} --no-wrap \
  --html {EDITION_DIR}/_internal/newsletter-final.html \
  --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json \
  --field newsletter_url
```

Exit codes de `substitute-image-urls.ts` (#2316, #2335) — mesma tabela de §4b.

**⚠️ Atualizar `{newsletter_url}` após o re-upload:** o re-upload gera um novo hash de conteúdo (#1494) → nova URL. A URL capturada em §4b step 2 fica STALE. Re-ler `_internal/04-newsletter-url.json` e atualizar a variável `{newsletter_url}` ANTES de montar o gate (§4c.7) — senão o editor abre o preview da URL antiga (texto PRÉ-correção) e aprova conteúdo que não revisou.

**O que é auto-corrigido:**
- Apenas claims `DIVERGENT` com `suggested_fix` (valor correto determinístico extraído verbatim da fonte).
- Apenas `02-reviewed.md` (newsletter) — `03-social.md` NÃO é tocado para preservar o sentinel do humanizador.
- Nunca `claim_type: "superlative"` — ineditismo/tom é revisão editorial, não auto-fix.
- Nunca `NOT_FOUND_IN_SOURCE` — ausência de suporte não implica valor correto.
- Nunca o destaque do `intentional_error` declarado em `_internal/intentional-error.json` (#3222) — preserva o erro intencional proposital.
- Substituição scoped ao bloco do destaque correto — evita clobberar erros intencionais de outros destaques com mesmo texto.
- Claims em `sources: ["social"]` only → logados como `skipped` (precisa correção manual em 03-social.md, seguindo §4d.1 passo 6 para re-humanizar e re-selar sentinel).

**No gate:** apresentar como "já corrigido (diff X→Y) — confirme ou reverta". Se `fact-check-autofix.json` mostra `summary.applied > 0`, incluir bloco no gate (antes do `{fact_check_block}`):

```
━━━ FACT-CHECK AUTO-CORRIGIDO (#2598) ━━━━━━━━━━
  ✅ {N} correção(ões) aplicada(s) automaticamente:
    D{N} [{tipo}] "{texto_original}" → "{suggested_fix}" ({arquivo(s)})
  Para reverter: editar o arquivo e usar a opção "ajustar" no gate.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (aplica as correções, grava `_internal/fact-check-autofix.json`); o gate é pulado.

### 4d. Gate humano (#1694)

**Sync push antes do gate (#507):** Subir outputs pra o editor revisar no Drive antes de aprovar:
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir {EDITION_DIR}/ --stage 4 --files 02-reviewed.md,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg,01-eia-A.jpg,01-eia-B.jpg
```

**GATE HUMANO — RESUMO CONSOLIDADO (#1694):**

Apresentar ao editor numa visualização limpa:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 REVISÃO EDITORIAL — Edição {AAMMDD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📰 Newsletter HTML:   {newsletter_url}
📱 Social preview:   {social_url}
📁 Drive:            Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/

━━━ DESTAQUES ━━━━━━━━━━━━━━━━━━━━━━

D1  "{título_d1}"  [{verify_verdict_d1}]
    {url_d1}

D2  "{título_d2}"  [{verify_verdict_d2}]
    {url_d2}

D3  "{título_d3}"  [{verify_verdict_d3}]
    {url_d3}

━━━ SOCIAL (6 posts) ━━━━━━━━━━━━━━━━

LinkedIn  D1  "{hook_d1_linkedin}"
LinkedIn  D2  "{hook_d2_linkedin}"
LinkedIn  D3  "{hook_d3_linkedin}"
Facebook  D1  "{hook_d1_facebook}"
Facebook  D2  "{hook_d2_facebook}"
Facebook  D3  "{hook_d3_facebook}"

━━━ IMAGENS ━━━━━━━━━━━━━━━━━━━━━━━━

✓ D1 cover 2:1    04-d1-2x1.jpg ({size_kb} KB)
✓ D1 inline 1:1   04-d1-1x1.jpg ({size_kb} KB)
✓ D2 inline 1:1   04-d2-1x1.jpg ({size_kb} KB)
✓ D3 inline 1:1   04-d3-1x1.jpg ({size_kb} KB)
✓ É IA? A         01-eia-A.jpg
✓ É IA? B         01-eia-B.jpg

━━━ LINTS ━━━━━━━━━━━━━━━━━━━━━━━━━━

{violations_block ou "✅ Nenhuma violação detectada"}

{fact_check_block}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aprovar e prosseguir para Publicação (Etapa 5)?

  sim     → segue para /diaria-5-publicacao (dispatch automático)
  editar  → halt; editor edita no Drive → pull → responde "sim" quando pronto
  ajustar → editor dita a mudança no chat; orchestrator aplica e re-apresenta o resumo
  abortar → encerra sem publicar (sentinel não escrito)
  Qualquer outra resposta → repetir prompt (fail-closed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Regras de apresentação:
- `{verify_verdict}` = `✅ acessível` / `⚠️ inacessível` / `⏱ timeout`.
- `{violations_block}` = uma linha por violation com ❌ (crítico) ou ⚠️ (warning) + mensagem.
- `{fact_check_block}` = saída do `formatGateSummary` de `scripts/run-fact-checker.ts --input-json` (§4c.6). Se fact-checker falhou ou `fact-check.json` não existe: `⚠️ Fact-check indisponível — verificar manualmente antes de publicar.` **Nunca bloquear o gate por ausência do fact-check.** Decisão final é sempre do editor.
- Títulos dos posts sociais: primeira linha não-vazia de cada post no `03-social.md` (o "hook").
- Se pré-render falhou em algum passo (newsletter HTML, social HTML), indicar `⚠️ preview indisponível` com motivo.

Logar a resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
  --message "gate revisao response: {sim|editar|ajustar|abortar}"
```

**"editar":** rodar `update-stage-status --stage 4 --status pending` + halt banner. NÃO escrever sentinel. Editor edita no Drive e re-roda quando pronto. Adequado para revisões longas ou fora do terminal.

**"ajustar":** ver §4d.1 abaixo — edição inline no chat, orchestrator aplica e volta ao gate. Adequado para tweaks rápidos.

**"abortar":** logar warn `"gate_revisao_abortado"`, encerrar sem sentinel.

### 4d.1 — Edição inline ("ajustar") (#1694)

O editor dita a mudança em linguagem natural (ex: "muda o título do D2 para X", "tira o link do D3", "troca lança por apresenta no corpo do D1").

**Fluxo:**

1. **Pull antes de editar** (#494): `drive-sync --mode pull --stage 4 --files 02-reviewed.md` (e `03-social.md` se a mudança afetar social).
2. **Aplicar edição cirúrgica** em `02-reviewed.md` seguindo #495: substituições linha-a-linha mínimas via `Edit` com `old_string` mínimo. Nunca substituir blocos grandes.
3. **Cascata de título (crítico):** se a mudança alterar um TÍTULO de destaque:
   - O orchestrator **avisa** o editor: "Essa mudança afeta a imagem e os posts sociais do D{N} — vou re-gerar os passos afetados."
   - Re-rodar: re-render do HTML (§4b steps 1-3), regenerar imagem do destaque (`scripts/image-generate.ts --edition {AAMMDD} --highlight d{N}`), e regenerar post social do D{N} (`social-linkedin` / `social-facebook` para aquele destaque).
   - Edição de **corpo ou link** (sem mudar título) não cascateia — só re-render do HTML basta.

4. **Reordenação/swap de destaques (#2145 — post_pixel stale):** se a mudança reordenar os destaques (ex: troca D1↔D3) ou trocar qual destaque ocupa a posição D1:
   - O `## post_pixel` foi gerado sobre o D1 **original** (Stage 2) e **não é remapeado automaticamente** junto com os blocos `## d{N}`.
   - O orchestrator **avisa** o editor imediatamente: "Reordenação detectada — o `## post_pixel` pode estar referenciando o D1 antigo. Re-verificar e re-sincronizar antes de aprovar."
   - Re-rodar lint: `npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md {EDITION_DIR}/03-social.md`.
   - Se falhar (exit 1): o post_pixel precisa ser atualizado manualmente — reescrever o bloco `## post_pixel` em `03-social.md` para refletir o D1 atual, depois re-rodar o lint até exit 0. **Não há modo de re-dispatch parcial** — o `social-linkedin` não aceita `--only post_pixel` e um re-dispatch completo clobberia os posts de d1/d2/d3 já aprovados. Edição manual do bloco é a única via segura.
   - Lint verde (exit 0) = post_pixel já alinhado com o D1 atual → sem bloqueio.

5. **Logar:**
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
     --message "gate revisao: ajustar inline aplicado ({descrição curta})"
   ```

6. **Re-humanizar e gravar sentinel se `03-social.md` foi tocado (#2279/#2290/#2373):** qualquer ajuste que altere `03-social.md` (reorder de destaques, edição de post social inline) OBRIGATORIAMENTE:
   1. **Rodar o humanizador** em `03-social.md` (passagem completa via Skill humanizador).
   2. **Rodar `mcp__clarice__correct_text`** no `## post_pixel` (revisão ortográfica).
   3. **Só então gravar o sentinel** com `--bypass-reason` descritivo:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --write \
        --bypass-reason "humanizador re-rodou após ajuste {descrição} no Stage 4" \
        --edition-dir {EDITION_DIR}/
      ```
      O `--write` SEM `--bypass-reason` falhará com exit 3 se o hash divergir — essa é a trava que impede bypasse acidental (#2373). Nunca usar `--write` como atalho para limpar o lint sem re-humanizar.
   4. Re-rodar lints de qualidade social (mesmo fluxo do exit-2 em §4c.2b):
      ```bash
      npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
        --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md \
        --md {EDITION_DIR}/03-social.md
      npx tsx scripts/lint-social-md.ts --check relative-time --md {EDITION_DIR}/03-social.md
      npx tsx scripts/lint-social-md.ts --check linkedin-schema --md {EDITION_DIR}/03-social.md
      ```
   5. Re-rodar check para confirmar exit 0 antes de voltar ao gate:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
      ```

7. **Voltar ao §4d** (re-apresentar o resumo consolidado atualizado) — loop até o editor responder `sim` ou `abortar`. `ajustar` pode ser repetido N vezes.

**Distinção `editar` vs `ajustar`:**
- `editar`: round-trip via Drive — adequado para revisões longas, múltiplas seções, ou quando o editor não está no terminal.
- `ajustar`: inline no chat — adequado para tweaks rápidos (título, palavra, link), orchestrator aplica na hora.
- Ambos voltam ao gate; `sim` só depois de aprovação explícita.

### 4e. Escrever sentinel de conclusão (#978, adaptado de #1694)

**Após aprovação do gate** (ou imediatamente em `auto_approve = true` após §4b):

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

**Marcar Stage 4 `done` AQUI (#1783):**
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status done
```

- Falha do sentinel → logar warn. Não bloquear.
- O sentinel de Stage 4 garante que resume-aware (Stage 0b) detecta que a Revisão completou e pula direto para a Etapa 5.

---

## Fluxo pós-gate

Após aprovação do gate (ou auto-approve com `--no-gates`), o orchestrator prossegue imediatamente para a **Etapa 5 — Publicação** (leia `orchestrator-stage-5.md`).

O pré-render do Stage 4 já populou todos os artefatos que o Stage 5 precisa:
- `_internal/newsletter-final.html` (HTML pronto)
- `_internal/05-social-preview.json` (URL do preview social)
- `06-public-images.json` (URLs públicas das imagens)
- `_internal/.close-poll-done.json` (gabarito setado)

O Stage 5 **não repete** pré-render — vai direto para o dispatch.
