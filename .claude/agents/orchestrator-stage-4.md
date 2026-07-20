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

2. Pre-render do newsletter HTML — seguir steps 1.1-1.3 do `context/publishers/beehiiv-playbook.md` (extract-destaques, upload-images-public, render-newsletter-html + substitute-image-urls). Output: `_internal/newsletter-final.html`.

   **Exit codes de `substitute-image-urls.ts` (#2316, #2335):**

   | Exit | Significado | Ação |
   |------|-------------|------|
   | `0` | Sucesso | Continuar |
   | `1` | Erro de args (CLI) | Verificar comando; abortar |
   | `2` | Placeholders não resolvidas | Abortar — verificar `06-public-images.json` e fluxo de upload |
   | `3` | **HTML stale** — `newsletter-draft.html` mais antigo que `02-reviewed.md` | Re-rodar `render-newsletter-html.ts` primeiro, depois re-rodar `substitute-image-urls.ts`. **Não é fatal** — não tratar como falha de pipeline. |

   > **Exit 3 (#2316):** mensagem stderr: `[substitute-image-urls] ERRO: HTML de input está desatualizado`. Ação: re-renderizar e re-substituir. Ver beehiiv-playbook.md §1.3 para o exit-code table completo.

2b. **Servir preview LOCALMENTE via `serve-preview.ts` (#3546 — substitui o Worker Cloudflare no caminho de REVISÃO).** #3420 tinha revertido pra Worker-hosted (`upload-html-public.ts`) porque #3214/Claude Artifacts quebrava por CSP (bloqueia imagem remota, só `data:` URI). #3546 resolve isso sem depender nem do Worker (cota Workers KV, rede) nem do Artifact (CSP): serve o HTML LOCALMENTE (loopback, `http://127.0.0.1:{porta}/...`) com imagens embutidas em `data:` URI via `embed-images-base64.ts` — não há CSP num servidor local próprio, e não há requisição de rede pra imagem nenhuma. **Nunca chamar `upload-html-public.ts` neste passo** — esse script fica reservado ao upload REAL que a Etapa 5 refaz independentemente no dispatch (`context/publishers/beehiiv-playbook.md` §5.2 Fase 3, sobre `newsletter-final.html` intacto, sem a variante embedded).

    Gerar a variante embedded (`newsletter-final.html` fica intacto, com `{{email}}` preservado pro paste real da Etapa 5):
    ```bash
    npx tsx scripts/embed-images-base64.ts \
      --html {EDITION_DIR}/_internal/newsletter-final.html \
      --images {EDITION_DIR}/06-public-images.json \
      --edition-dir {EDITION_DIR}/ \
      --out {EDITION_DIR}/_internal/newsletter-final-embedded.html
    ```
    `missing` no stdout (exit 1 é só sinal de falha PARCIAL, não fatal) = imagem sem arquivo local — logar warn, preview mantém URL remota só pra essa imagem específica.

    Servir localmente em background (porta efêmera) e persistir `{newsletter_url}` + PID (pra teardown em §4e):
    ```bash
    npx tsx scripts/serve-preview.ts \
      --file {EDITION_DIR}/_internal/newsletter-final-embedded.html --port 0 \
      --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json --field newsletter_url &
    ```
    Rodar com `run_in_background: true` no Bash tool. Ler `newsletter_url` (e `newsletter_url_pid`, guardado pro teardown) de `04-newsletter-url.json` pra popular `{newsletter_url}` no resumo do gate (§4d). Em modo `local` (`scripts/lib/exec-mode.ts`), pode-se navegar o Chrome do editor pra essa URL pra revisão visual assistida: `mcp__claude-in-chrome__tabs_context_mcp` (obter/criar o `tabId` do grupo MCP) → `mcp__claude-in-chrome__navigate` com esse `tabId` e `url: {newsletter_url}`. Em `cloud`, só logar a URL — sem navegação (sem Chrome do editor na sessão, ver issue #3546 "Fora de escopo").

    **#3700 — persistir o `tabId` usado**, no mesmo JSON, pra o teardown de §4d/§4e conseguir fechar a aba (não só matar o servidor — sem isso a aba fica órfã apontando pro loopback morto e o "Continuar de onde parei" do Chrome a reabre a cada restart):
    ```bash
    node -e "const p='{EDITION_DIR}/_internal/04-newsletter-url.json';const j=JSON.parse(require('fs').readFileSync(p,'utf8'));j.newsletter_url_tab_id={tab_id};require('fs').writeFileSync(p,JSON.stringify(j,null,2));"
    ```

3. Pre-render do social preview HTML + servir localmente (mesmo padrão do step 2b acima):
   ```bash
   # #1800: --images é OBRIGATÓRIO — sem ele o preview sai sem imagens.
   npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json

   # Variante embedded (data: URI) — mesmo script/motivo do step 2b.
   npx tsx scripts/embed-images-base64.ts \
     --html {EDITION_DIR}/_internal/social-preview.html \
     --images {EDITION_DIR}/06-public-images.json \
     --edition-dir {EDITION_DIR}/ \
     --out {EDITION_DIR}/_internal/social-preview-embedded.html

   # Servir localmente em background, persistir social_preview_url + PID.
   npx tsx scripts/serve-preview.ts \
     --file {EDITION_DIR}/_internal/social-preview-embedded.html --port 0 \
     --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url &
   ```
   Mesmo padrão do step 2b acima pro `navigate`/`tabId` — se o Chrome do editor for navegado pra `{social_url}`, persistir `social_preview_url_tab_id` em `05-social-preview.json` (mesmo mecanismo, #3700).

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
npx tsx scripts/lint-newsletter-md.ts --check video-links-are-youtube --md {EDITION_DIR}/02-reviewed.md
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

`video-links-are-youtube` (#3202): **GATE-BLOCKING** quando exit 1 — item da seção VÍDEOS com URL fora de `youtube.com`/`youtu.be` (regra editorial nova: `context/editorial-rules.md` — Seção "Vídeos"). A resolução automática roda no Stage 1 (`scripts/resolve-video-youtube.ts`, passo 1m-quinquies — busca `site:youtube.com` + substitui a URL quando há match confiável, ou flaga `video_url_unverified` no gate da Etapa 1 quando não há); este lint é o backstop que garante que nada não-YouTube sobrevive até a publicação, mesmo se a resolução foi pulada ou o editor colou um link não-YouTube manualmente. Caso real (260709): página oficial da OpenAI hospedando a livestream "Introducing GPT-Live" bloqueou o bot (403) e acabou reusada como URL do vídeo, duplicando o link de um destaque. Ação: substituir pela URL do YouTube equivalente (`youtube.com/watch?v=...` ou `youtu.be/...`) em `02-reviewed.md` antes de aprovar, ou remover o item de VÍDEOS.

`title-publisher-suffix` + `title-trailing-period` (#2664/#2672): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com linha + sufixo/título, sem bloquear o gate. A normalização automática roda no Stage 1 (`enrich-inbox-articles.ts` → `normalizeItemTitle`); estes lints são backstop pré-gate para resíduos que escapam (títulos gerados pelo writer LLM ou curados pelo editor). O check de sufixo usa heurística de 1–4 palavras (pode ter falso-positivo em traço editorial legítimo) — por isso WARN, não BLOCK. Ação sugerida ao editor: remover o sufixo de veículo / ponto final em `02-reviewed.md` antes de aprovar.

`no-trailing-ellipsis` (#2881, estendido em #3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho final da descrição. Backstop para a sanitização automática que roda no Stage 1 (`enrich-inbox-articles.ts` → `sanitizeTrailingEllipsis`): muitos veículos truncam a própria meta-description com "…"/"..." e isso vaza pro item de RADAR/USE MELHOR/LANÇAMENTOS como se a frase tivesse sido cortada por nós. Diferente do irmão mais antigo `truncated-secondary-item-summary` (#2596, com carve-outs pra idiomas de suspense/fechamento intencional), este check é deliberadamente estrito: qualquer descrição terminando em reticência é flagrada, sem exceção — os dois podem disparar juntos na mesma linha. #3196: agora ignora um sufixo `(N min)` (estimativa de tempo do USE MELHOR) ao checar o fim da string — antes uma descrição como "Então... (5 min)" "terminava" em "(5 min)", não em "…", e escapava. Ação sugerida ao editor: reescrever a descrição em `02-reviewed.md` antes de aprovar.

`mid-sentence-ellipsis` (#3196): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com seção + linha + trecho da descrição. Backstop irmão de `no-trailing-ellipsis`, mas pro caso da reticência aparecer no MEIO da descrição (não só no fim) — sintoma de outlet (ex: G1) truncando a própria meta-description no meio da frase. Heurística ampla sem allowlist (mesma justificativa #2715): também pode disparar em reticência estilística legítima no meio de uma frase — o editor decide caso a caso. Ação sugerida: reescrever a descrição em `02-reviewed.md` antes de aprovar, se de fato for truncamento da fonte.

`stacked-intro-callouts` (#2729): **WARN-ONLY** — exibir matches como ⚠️ no `{violations_block}` com as linhas dos blocos empilhados. Detecta ≥2 blocos `**(🎉|📣)…**` na região de intro (antes do 1º `**DESTAQUE`) — `extractIntroCallout` (#2727) é greedy e funde os 2 blocos num só, vazando `**` internos como texto literal e perdendo o separador "Divulgação" do bloco patrocinado. `inject-champions-callout.ts` (Stage 3) já pula a auto-injeção quando um callout preexiste, mas isso não cobre colagem manual de 2 blocos pelo editor — daí o lint como backstop. Ação sugerida: mesclar os 2 CTAs num único bloco, ou mover o 2º para uma lacuna entre destaques (box de divulgação).

`orphan-box-in-gap` (#3204, estendido pro slot 3 em #3476): **GATE-BLOCKING** quando exit 1. Backstop pós marcador-agnóstico — `newsletter-parse.ts`'s `locateBoxInGap`/`locateBoxAfterLastDestaque` (Stage 4 pre-render, via `render-newsletter-html.ts`) já detecta o box de divulgação numa lacuna D1/D2, D2/D3, OU na região pós-último-destaque (slot 3, entre D3/D2 e USE MELHOR/É IA?) por POSIÇÃO (qualquer bloco `---`-isolado após o próprio destaque), não por um allowlist de marcadores emoji — um marcador novo (📖, 🎥, 🎁, 🔧, ...) não precisa mais de nenhuma mudança de código. Este lint cobre os 2 jeitos de isso AINDA falhar silenciosamente: (a) um bloco com CARA de box (bold-line inteiro `**...**` OU parágrafo emoji-led) colado DENTRO da seção do destaque anterior, sem `---` isolando-o — não vira box, é absorvido no corpo/why do destaque (caso 260609); (b) uma lacuna/região com MAIS de 1 bloco `---`-isolado extra — ambíguo, só o 1º vira box, o(s) demais seria(m) descartado(s) em silêncio. Ação sugerida ao editor: isolar o box em sua PRÓPRIA seção, entre o `---` que fecha o destaque/box anterior e o `---` que abre o próximo — exatamente 1 bloco extra por lacuna/região. Gate só pode ser aprovado (`sim`) após lint verde (exit 0).

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

  **Re-humanizar antes de aprovar** (quando exit 2, independente de tics) — seguir o mesmo fluxo SCOPED/FULL-FILE de **§4d.1 passo 6** (re-humanização scoped #3446): a saída do `--check` acima já traz `{ legacy, changed_sections }` no stdout — usar direto, sem rodar o check de novo.

**4c.3 — Imagens geradas:**
- Listar `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` com tamanhos (bytes).
- URL pública no Worker KV: `{newsletter_url}` (capturada em §4b step 2b).

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

**4c.6b — Auto-fix de DIVERGENT determinístico (#2598, estendido a social em #3224):**

Após o subagente gravar `_internal/fact-check.json`, aplicar correções automáticas de claims `DIVERGENT` com `suggested_fix` presente — antes de montar o gate:

```bash
npx tsx scripts/apply-factcheck-autofix.ts --edition-dir {EDITION_DIR}/
```

Exit code handling:
- `0` → capturar stdout e JSON `_internal/fact-check-autofix.json`.
- `1` → logar warn; continuar sem auto-fix (não bloqueia gate).

**⚠️ Re-render obrigatório quando `applied > 0` (#2617):** o pré-render de §4b gerou `newsletter-final.html` ANTES do autofix. Se `fact-check-autofix.json` mostra `summary.applied > 0`, re-rodar render + substitute para garantir que o HTML reflita o texto corrigido, e republicar o preview:

```bash
# Re-render newsletter HTML com o 02-reviewed.md já corrigido
npx tsx scripts/render-newsletter-html.ts {EDITION_DIR}/ --format html --out {EDITION_DIR}/_internal/newsletter-draft.html
npx tsx scripts/substitute-image-urls.ts \
  --html {EDITION_DIR}/_internal/newsletter-draft.html \
  --out {EDITION_DIR}/_internal/newsletter-final.html \
  --images {EDITION_DIR}/06-public-images.json
```

Exit codes de `substitute-image-urls.ts` (#2316, #2335) — mesma tabela de §4b.

**⚠️ Atualizar `{newsletter_url}` após o re-render:** o conteúdo mudou → o preview local servido em §4b step 2b fica STALE. Re-servir ANTES de montar o gate (§4c.7) — senão o editor abre o preview antigo (texto PRÉ-correção) e aprova conteúdo que não revisou. **Re-servir localmente (#3546 — mesmo padrão do §4b step 2b: encerrar o servidor antigo, re-gerar a variante embedded, subir um novo):**
```bash
# Encerra o servidor de preview anterior (PID gravado em 04-newsletter-url.json).
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/04-newsletter-url.json','utf8')).newsletter_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/embed-images-base64.ts \
  --html {EDITION_DIR}/_internal/newsletter-final.html \
  --images {EDITION_DIR}/06-public-images.json \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/newsletter-final-embedded.html

npx tsx scripts/serve-preview.ts \
  --file {EDITION_DIR}/_internal/newsletter-final-embedded.html --port 0 \
  --persist-to {EDITION_DIR}/_internal/04-newsletter-url.json --field newsletter_url &
```
Rodar o `serve-preview.ts` final com `run_in_background: true`. Re-ler `newsletter_url` de `04-newsletter-url.json` e atualizar a variável `{newsletter_url}` do gate.

**⚠️ Re-render do social quando `social_modified === true` (#3224):** claims com `sources` incluindo `"social"` agora também são corrigidos em `03-social.md` (nos blocos `## dN`, LinkedIn e Facebook — ver "O que é auto-corrigido" abaixo). O script já regrava `_internal/.humanizer-social-done.json` internamente com `bypassReason` explícito (reusa `writeSentinel` de `check-humanizer-social.ts`, mesmo mecanismo do #2529) — **não é preciso rodar `check-humanizer-social.ts --write` manualmente**. Mas o pré-render de §4b step 3 (`social-preview.html`) foi gerado ANTES do autofix, então se `_internal/fact-check-autofix.json` mostra `social_modified: true`, re-renderizar e republicar:

```bash
# Re-render social HTML com o 03-social.md já corrigido
npx tsx scripts/render-social-html.ts --md {EDITION_DIR}/03-social.md --out {EDITION_DIR}/_internal/social-preview.html --images {EDITION_DIR}/06-public-images.json

# Encerra o servidor de preview social anterior (PID gravado em 05-social-preview.json).
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/05-social-preview.json','utf8')).social_preview_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/embed-images-base64.ts \
  --html {EDITION_DIR}/_internal/social-preview.html \
  --images {EDITION_DIR}/06-public-images.json \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/social-preview-embedded.html

# Serve localmente (atualiza a URL/PID persistidos em 05-social-preview.json com o novo conteúdo)
npx tsx scripts/serve-preview.ts \
  --file {EDITION_DIR}/_internal/social-preview-embedded.html --port 0 \
  --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url &
```
(#3546 — mesmo padrão stop-old → embed → serve-new de §4b step 3 / §4c.6b acima.)

Confirmar que o sentinel bate com o social já corrigido antes de seguir pro gate (deve dar exit 0 — o próprio script já regravou):
```bash
npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
```
Se por algum motivo o exit não for 0 aqui (ex: `writeSentinel` falhou e o script apenas logou warn — ver stderr de `apply-factcheck-autofix.ts`), tratar como o exit 2 padrão de §4c.2b (re-humanizar e re-selar antes do gate).

**4c.6c — Re-validar lints estruturais pós-autofix (#3306):**

O autofix acima usa `replaceAll` no escopo do destaque/seção (#3274/#3275) — o `suggested_fix` é texto bruto do fact-checker LLM, sem consciência de markdown/estrutura. Uma correção pode reescrever mais do que o esperado e quebrar um invariante que os lints de §4c.2/§4c.2b passaram intactos ANTES do autofix rodar. Nenhum desses lints roda de novo depois — só o sentinel de hash do humanizador acima (que confere que o social foi re-humanizado, não que a estrutura ficou íntegra). Este passo fecha essa lacuna, re-rodando os lints estruturais que operam sobre texto de destaque.

Rodar SOMENTE os lints relevantes ao arquivo que o autofix de fato tocou:

- Se `_internal/fact-check-autofix.json` mostra `summary.applied > 0` (newsletter pode ter sido corrigida):
  ```bash
  npx tsx scripts/lint-newsletter-md.ts --check callout-placement --md {EDITION_DIR}/02-reviewed.md
  ```
  (mesma `lintCalloutPlacement` de #3282, já usada por `orphan-box-in-gap` em §4c.2 — aqui chamada direto pra checar só a estrutura do callout, sem repetir a checagem de gaps órfãos.)

- Se `_internal/fact-check-autofix.json` mostra `social_modified === true` (03-social.md foi corrigido):
  ```bash
  npx tsx scripts/lint-social-md.ts --check post_pixel-matches-d1 --md {EDITION_DIR}/03-social.md
  npx tsx scripts/lint-social-md.ts --check linkedin-page-link --md {EDITION_DIR}/03-social.md
  npx tsx scripts/lint-social-md.ts --check platform-headers-unicos --md {EDITION_DIR}/03-social.md
  ```

Exit code handling — **GATE-BLOCKING**, mesmo padrão que `check-humanizer-social.ts --check` já usa logo acima: se falhar, tratar como o exit 2 padrão de §4c.2b (re-corrigir e re-selar antes do gate, nunca deixar a violação vazar pro resumo do editor):
- `0` em todos os lints rodados → continuar.
- `1` em qualquer um → **GATE-BLOCKING.** O autofix quebrou um invariante estrutural que sobrevivia intacto antes da correção. NÃO montar o gate ainda. Ação:
  1. Ler o output do lint (linha + contexto da violação) e o `entry` correspondente em `_internal/fact-check-autofix.json` (mesmo `destaque`/`suggested_fix`) para identificar qual correção causou a quebra.
  2. Corrigir cirurgicamente (#495 — `Edit` com `old_string` mínimo, nunca substituir blocos grandes) o arquivo afetado, preservando o valor factual já corrigido mas restaurando a estrutura esperada pelo lint (callout isolado por `---`, ou bloco `post_pixel`/link do LinkedIn realinhado).
  3. Re-rodar o lint que falhou até sair `0`.
  4. Se a correção cirúrgica tocou `03-social.md`: re-humanizar + re-selar sentinel (mesmo fluxo do exit 2 de §4c.2b, incluindo os lints de qualidade social) antes de prosseguir.
  5. Re-renderizar o(s) arquivo(s) tocado(s) (newsletter e/ou social, §4b steps 2/3) e re-upload pro Worker Cloudflare (§4c.6b) antes de seguir pro gate — capturar a nova URL (content-hash muda a cada re-upload).

**Comportamento em `auto_approve = true` (`--no-gates`):** mesma execução e mesmo bloqueio — GATE-BLOCKING vale igual mesmo sem apresentação visual do gate; o orchestrator não pode prosseguir pra Etapa 5 com um invariante estrutural quebrado só porque o gate humano foi pulado.

**O que é auto-corrigido:**
- Apenas claims `DIVERGENT` com `suggested_fix` (valor correto determinístico extraído verbatim da fonte).
- `02-reviewed.md` (newsletter) e/ou `03-social.md` (social), conforme `entry.sources` do claim — `["newsletter"]`, `["social"]` ou `["newsletter","social"]` (#3224). Em social, a correção é scoped aos blocos `## dN` e aplicada em AMBOS os canais (LinkedIn + Facebook) quando o texto aparece nos dois — e, pra destaque 1, também em `## post_pixel` (post pessoal standalone do Pixel, sempre sobre D1, #3274), já que é seção IRMÃ de `## d1` sujeita à mesma claim. Sucesso parcial é possível e fica registrado em `files_modified` + `note` da entry (ex: achou na newsletter mas não em social).
- Nunca `claim_type: "superlative"` — ineditismo/tom é revisão editorial, não auto-fix.
- Nunca `NOT_FOUND_IN_SOURCE` — ausência de suporte não implica valor correto.
- Nunca o destaque do `intentional_error` declarado em `_internal/intentional-error.json` (#3222) — preserva o erro intencional proposital (vale para newsletter E social).
- Substituição scoped ao bloco do destaque correto — evita clobberar erros intencionais de outros destaques com mesmo texto.
- Correção em `03-social.md` regrava automaticamente o sentinel do humanizador com `bypassReason` (evita falso-alarme de "social editado sem re-humanizar" no próximo `check-humanizer-social.ts --check`).

**No gate:** apresentar como "já corrigido (diff X→Y) — confirme ou reverta". Se `fact-check-autofix.json` mostra `summary.applied > 0`, incluir bloco no gate (antes do `{fact_check_block}`):

```
━━━ FACT-CHECK AUTO-CORRIGIDO (#2598/#3224) ━━━━━
  ✅ {N} correção(ões) aplicada(s) automaticamente:
    D{N} [{tipo}] "{texto_original}" → "{suggested_fix}" ({arquivo(s)})
  Para reverter: editar o arquivo e usar a opção "ajustar" no gate.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`{arquivo(s)}` = `entry.files_modified.join(", ")` — agora pode ser `newsletter`, `social`, ou `newsletter, social` (antes só `newsletter`, já que social era sempre skipped). Isso já deixa explícito no gate quando uma correção social foi aplicada, sem bloco separado — se `social_modified === true`, acrescentar uma linha informativa: `📱 Social também corrigido — preview social republicado.`

**Comportamento em `auto_approve = true` (`--no-gates`):** executar normalmente (aplica as correções, grava `_internal/fact-check-autofix.json`, re-renderiza/republica newsletter e social se aplicável); o gate é pulado.

### 4d. Gate humano (#1694)

**GATE HUMANO — RESUMO CONSOLIDADO (#1694):**

Apresentar ao editor numa visualização limpa:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 REVISÃO EDITORIAL — Edição {AAMMDD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📰 Newsletter HTML:   {newsletter_url}
📱 Social preview:   {social_url}

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
  editar  → halt; editor edita localmente (ou via Studio) → responde "sim" quando pronto
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

**Teardown dos preview servers locais (#3546) e das abas do Chrome (#3700) — rodar em QUALQUER branch TERMINAL do gate (`sim`, `editar`, `abortar`); NUNCA em `ajustar`** (que já encerra→re-serve a cada re-render nos passos de §4d.1, mantendo o gate vivo com um preview atual):

Em modo `local`, fechar as abas ANTES de matar os processos. Causa raiz da #3700: `--stop-pid` só derruba o processo do servidor — nunca a aba do Chrome que `navigate` abriu em §4b. Sem fechar a aba, ela sobrevive apontando pro loopback morto e o "Continuar de onde parei" do Chrome a reabre a cada restart. Passos (best-effort, nunca bloqueante):
1. `mcp__claude-in-chrome__tabs_context_mcp` — listar as abas do grupo MCP atual.
2. Para cada aba cujo `tabId` bata com `newsletter_url_tab_id` (`04-newsletter-url.json`) ou `social_preview_url_tab_id` (`05-social-preview.json`), OU cuja URL aponte pra `127.0.0.1` **excluindo explicitamente a porta `4174` (porta fixa default do Studio, `scripts/studio-ui/server.ts` — excluir sempre, mesmo sem Studio rodando nesta sessão; nunca varrer `127.0.0.1` sem esse filtro, #3727)** (fallback — pega aba de um re-serve anterior sem `tabId` persistido, ex: fluxo `ajustar` de §4d.1; os preview servers do próprio pipeline usam porta efêmera OS-assigned via `serve-preview.ts --port 0`, nunca `4174`, então a exclusão nunca esconde uma aba de preview legítima): (a) **página-cortina** — `mcp__claude-in-chrome__navigate` com `url: "about:blank"` nesse `tabId`, garante que o session restore não reabra o loopback morto mesmo se o close falhar; (b) `mcp__claude-in-chrome__tabs_close_mcp` nesse `tabId`.
3. Nenhuma aba encontrada, ou MCP indisponível/aba já fechada pelo editor: pular sem erro. Em `cloud`: pular inteiramente (nenhuma aba foi aberta em §4b).

   **Exceção consciente ao #738 (CLAUDE.md)** — #3732: o `claude-in-chrome` indisponível/desconectado AQUI (só neste passo de teardown pós-gate, nunca no fluxo principal de §4b/§4c) não renderiza halt banner nem aguarda resposta. Racional: o gate humano já foi respondido (`sim`/`editar`/`abortar` — o editor já aprovou ou encerrou) antes deste passo rodar; falhar a limpeza de uma aba órfã não deveria reverter ou travar uma aprovação que o editor já deu. O #738 nunca listou este passo de teardown como dependente do Chrome MCP (a lista de dependências por stage cita Stage 5, não Stage 4). Mesmo padrão de exceção documentada já usado pro Gmail MCP no relatório final de `/diaria-overnight` (`.claude/skills/diaria-overnight/SKILL.md`, regra 4 da seção de relatório) — não citar esta exceção como precedente fora deste passo específico de teardown.

```bash
NEWS_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/04-newsletter-url.json','utf8')).newsletter_url_pid||'')}catch(e){}")
[ -n "$NEWS_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$NEWS_PID"
SOCIAL_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/05-social-preview.json','utf8')).social_preview_url_pid||'')}catch(e){}")
[ -n "$SOCIAL_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$SOCIAL_PID"
```
Best-effort — `serve-preview.ts --stop-pid` já não é fatal quando o PID não existe mais (processo já morto, sessão reiniciada); nunca bloquear o encerramento do gate por causa disso. Mesma regra vale pro fechamento de aba acima (passos 1-3).

**"editar":** rodar o teardown acima, depois `update-stage-status --stage 4 --status pending` + halt banner. NÃO escrever sentinel. Editor edita localmente (ou via Studio) e re-roda quando pronto (um novo preview local é servido do zero na próxima passada por §4b). Adequado para revisões longas ou fora do terminal.

**"ajustar":** ver §4d.1 abaixo — edição inline no chat, orchestrator aplica e volta ao gate. Adequado para tweaks rápidos. **Não** rodar o teardown aqui.

**"abortar":** rodar o teardown acima, logar warn `"gate_revisao_abortado"`, encerrar sem sentinel.

### 4d.1 — Edição inline ("ajustar") (#1694)

O editor dita a mudança em linguagem natural (ex: "muda o título do D2 para X", "tira o link do D3", "troca lança por apresenta no corpo do D1").

**Fluxo:**

1. **Arquivos já estão localmente atualizados** — sem round-trip externo a aguardar antes de editar (Studio, se usado pelo editor pra revisão fora do terminal, grava direto no arquivo local).
2. **Aplicar edição cirúrgica** em `02-reviewed.md` seguindo #495: substituições linha-a-linha mínimas via `Edit` com `old_string` mínimo. Nunca substituir blocos grandes.
3. **Cascata de título (crítico):** se a mudança alterar um TÍTULO de destaque:
   - O orchestrator **avisa** o editor: "Essa mudança afeta a imagem e os posts sociais do D{N} — vou re-gerar os passos afetados."
   - Re-rodar: re-render do HTML (§4b steps 1-3), regenerar imagem do destaque (`scripts/image-generate.ts --edition {AAMMDD} --highlight d{N}`), e regenerar post social do D{N} (`social-linkedin` / `social-facebook` para aquele destaque).
   - Edição de **corpo ou link** (sem mudar título) não cascateia — só re-render do HTML basta.
   - **Em ambos os casos, re-servir o HTML localmente** (§4b step 2b / §4c.6b — stop-old → `embed-images-base64.ts` → `serve-preview.ts`, captura URL nova e atualiza `04-newsletter-url.json`) antes de re-apresentar o gate, senão o editor revisa conteúdo desatualizado.

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

6. **Re-humanizar SCOPED e gravar sentinel se `03-social.md` foi tocado (#2279/#2290/#2373, re-humanização scoped #3446):** qualquer ajuste que altere `03-social.md` (reorder de destaques, edição de post social inline) dispara re-humanização — mas **só das seções de fato alteradas**, não do arquivo inteiro. Re-humanizar tudo a cada ajuste era o 2º maior ofensor de tokens do pipeline (~600 linhas de prompt do humanizador por invocação completa × 2-4 ajustes/edição, #3379).

   **6.1 — Detectar seções alteradas** — o check abaixo sai exit 2 (esperado, `03-social.md` já mudou); ler a linha JSON do stdout `{ legacy, changed_sections }`:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
      ```
      - **`legacy: true`** (sentinel gravado antes do #3446 — sem baseline por-seção confiável): pular pro **fluxo FULL-FILE** (6.2' abaixo).
      - **`legacy: false`**: `changed_sections` traz os blocos exatos tocados (`main_d{N}`, `post_pixel` — **#3627**: `comment_pixel_d{N}` deixou de ser gerado, então nunca mais aparece aqui na prática; a função tolera a ausência sem mudança de código). Seguir o **fluxo SCOPED** (6.2-6.4).

   **Fluxo SCOPED (`legacy: false`):**

   **6.2** — Snapshot pré-humanização: `cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/.stage4-pre-scoped-humanize.md`.
   **6.3** — **Rodar o humanizador SCOPED** — invocar a Skill pedindo explicitamente que **só** os blocos de `changed_sections` sejam reescritos (traduzir cada nome pra prosa: `main_d{N}` = texto principal de `## d{N}`; `post_pixel` = bloco `## post_pixel`). Instruir explicitamente para copiar todo o resto verbatim, sem tocar. Rodar `mcp__clarice__correct_text` no `## post_pixel` **só se `"post_pixel"` estiver em `changed_sections`**.
   **6.4** — **Verificar que o escopo foi respeitado:**
      ```bash
      npx tsx scripts/verify-scoped-humanization.ts \
        --pre {EDITION_DIR}/_internal/.stage4-pre-scoped-humanize.md \
        --post {EDITION_DIR}/03-social.md \
        --sections {changed_sections join vírgula}
      ```
      - Exit 0 → seguir pro passo 6.6.
      - Exit 1 com `untouchedTargets` (humanizador ignorou um bloco pedido): re-invocar a Skill humanizador só pra esse(s) bloco(s) e re-verificar. Persistindo após 1 retry, cair no **fluxo FULL-FILE**.
      - Exit 1 com `unexpectedChanges` (humanizador tocou algo fora do pedido): não é inseguro, só gastou mais tokens que o ideal — logar warn (`scope_not_respected: {unexpectedChanges}`) e seguir pro passo 6.6 normalmente.

   **Fluxo FULL-FILE (fallback — `legacy: true`, ou escalonamento do passo 6.4 acima):**

   **6.2'** — Rodar o humanizador em `03-social.md` inteiro (passagem completa via Skill humanizador) — comportamento pré-#3446, preservado como rede de segurança. Rodar `mcp__clarice__correct_text` no `## post_pixel` (revisão ortográfica).

   **Os dois fluxos convergem aqui:**

   **6.6 — Gravar o sentinel** com `--bypass-reason` descritivo (grava também os `section_hashes` atualizados automaticamente — #3446, baseline pro próximo ajuste):
      ```bash
      npx tsx scripts/check-humanizer-social.ts --write \
        --bypass-reason "humanizador re-rodou ({scoped: changed_sections | full-file}) após ajuste {descrição} no Stage 4" \
        --edition-dir {EDITION_DIR}/
      ```
      O `--write` SEM `--bypass-reason` falhará com exit 3 se o hash divergir — essa é a trava que impede bypasse acidental (#2373). Nunca usar `--write` como atalho para limpar o lint sem re-humanizar.
   **6.7** — Re-rodar lints de qualidade social (mesmo fluxo do exit-2 em §4c.2b — comparam contra o baseline ORIGINAL de Stage 2, válido em ambos os fluxos):
      ```bash
      npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
        --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md \
        --md {EDITION_DIR}/03-social.md
      npx tsx scripts/lint-social-md.ts --check relative-time --md {EDITION_DIR}/03-social.md
      npx tsx scripts/lint-social-md.ts --check linkedin-schema --md {EDITION_DIR}/03-social.md
      npx tsx scripts/lint-social-md.ts --check platform-headers-unicos --md {EDITION_DIR}/03-social.md
      ```
   **6.8** — Re-rodar check para confirmar exit 0 antes de voltar ao gate:
      ```bash
      npx tsx scripts/check-humanizer-social.ts --check --edition-dir {EDITION_DIR}/
      ```
   **6.9** — Re-renderizar (`render-social-html.ts`, §4b step 3) e re-servir localmente (mesmo padrão stop-old → `embed-images-base64.ts` → `serve-preview.ts --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url` de §4c.6c) antes de voltar ao gate. O arquivo republicado é sempre o `03-social.md` COMPLETO (seções scoped-humanizadas + seções intactas) — o preview reflete o estado atual inteiro em ambos os fluxos.

7. **Voltar ao §4d** (re-apresentar o resumo consolidado atualizado) — loop até o editor responder `sim` ou `abortar`. `ajustar` pode ser repetido N vezes.

**Distinção `editar` vs `ajustar`:**
- `editar`: edição fora do fluxo de chat (local ou via Studio) — adequado para revisões longas, múltiplas seções, ou quando o editor não está no terminal.
- `ajustar`: inline no chat — adequado para tweaks rápidos (título, palavra, link), orchestrator aplica na hora.
- Ambos voltam ao gate; `sim` só depois de aprovação explícita.

### 4e. Escrever sentinel de conclusão (#978, adaptado de #1694)

**Após aprovação do gate** (ou imediatamente em `auto_approve = true` após §4b):

**Teardown dos preview servers locais (#3546) e das abas do Chrome (#3700)** — rodar aqui também no caminho `auto_approve = true` (gate pulado inteiramente, mas os servidores/abas de §4b sobem do mesmo jeito no pré-render). Se o editor já respondeu `sim` no gate humano, o teardown (fechamento de aba incluído — mesmo procedimento de §4d, passos 1-3) já rodou em §4d — idempotente, seguro repetir (mesmo bloco):
```bash
NEWS_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/04-newsletter-url.json','utf8')).newsletter_url_pid||'')}catch(e){}")
[ -n "$NEWS_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$NEWS_PID"
SOCIAL_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('{EDITION_DIR}/_internal/05-social-preview.json','utf8')).social_preview_url_pid||'')}catch(e){}")
[ -n "$SOCIAL_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$SOCIAL_PID"
```

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

**Marcar Stage 4 `done` AQUI (#1783):**
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status done
```

**Capturar custo/tokens reais (#3441):**
```bash
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 4
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
