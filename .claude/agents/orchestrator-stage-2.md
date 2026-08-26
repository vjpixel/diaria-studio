---
name: orchestrator-stage-2
description: Detalhe da Etapa 2 (escrita — newsletter + social em paralelo) do orchestrator diar.ia.br. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 2 — Escrita

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 2`, banner `--stage "2 — Escrita"`.

Newsletter e social rodam **em paralelo** a partir de `_internal/01-approved.json` — nenhum depende do outro. O gate ao final é unificado.

**`{EDITION_DIR}` (#2463/#3025/#3530):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Já foi resolvido no Stage 0/1 — se este stage estiver rodando na mesma sessão, reusar o valor. Se estiver rodando isolado (resume, skill separada), resolver de novo (idempotente — encontra o que já está no disco):
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```
**`CLARICE_REST` (#5414):** ler do disco (`npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR} --read`, campo `clariceRest`) em vez de memória de sessão — roda com frequência como sessão nova via `/diaria-2-escrita`. `null` = mesma semântica permissiva de sempre: tentar o fallback Clarice abaixo mesmo assim.

### Pré-condição: sentinel Stage 1

<!-- outputs must match the `write` call at the end of orchestrator-stage-1-research.md §gate approval -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 1 \
  --outputs "01-categorized.md,_internal/01-approved.json"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 1 não completou (sentinel ausente). Re-rodar `/diaria-1-pesquisa {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 1 ausentes. Re-rodar Etapa 1." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "stage1_sentinel_missing_legacy"`), continuar.

### 2a. Writer + social em paralelo

**Limites por bucket (#358, #742, #907) — aplicados antes de passar ao writer via `apply-stage2-caps.ts`:**
- Ler `_internal/01-approved.json` e calcular contagens de cada bucket.
- Destaques: preservar todos (sempre ≤3).
- Lançamentos: top-5 por score (se houver mais de 5, truncar nos 5 de maior score).
  - **Validar lançamentos ANTES do cap (#742, #876):** rodar `validate-lancamentos.ts` na lista de lançamentos do approved JSON para identificar URLs não-oficiais. Remover lançamentos rejeitados ANTES de calcular `lançamentos_final`. Isso garante que slots liberados por lançamentos inválidos sejam compensados em Outras Notícias. **Persistir o resumo** em `_internal/02-lancamentos-removed.json` para que o `sync-intro-count.ts` (§2b) ajuste menções narrativas a "X lançamentos" no intro:
    ```bash
    npx tsx scripts/validate-lancamentos.ts \
      --approved {EDITION_DIR}/_internal/01-approved.json \
      --write-removed {EDITION_DIR}/_internal/02-lancamentos-removed.json
    ```
    Exit 1 (URLs removidas) é esperado quando o approved tem URL não-oficial — não bloquear, só informativo. **#4339:** itens `not_a_tool` (verificação positiva #1968 — sem sinal de produto) não aparecem mais só no resumo — o script já reescreveu `_internal/01-approved.json` in-place, movendo-os de `lancamento[]` pra `radar[]`, ANTES desta chamada retornar. Não é preciso nenhuma ação manual adicional pra esses itens (diferente da URL não-oficial acima, que segue exigindo o passo de remoção explícito descrito nesta seção).
- Radar: `max(5, 12 − destaques − lançamentos_final)` (#1629 — substitui caps separados de Pesquisas + Outras Notícias).
  - `lançamentos_final` deve ser contado **após** o passo de validação acima (lançamentos inválidos já removidos).
  - Se validação de lançamentos removeu N itens, os N slots liberados são preenchidos a partir do pool de `radar` (top por score, respeitando o cap resultante).
- **Aplicar caps via script TS (#907)** — não confiar no writer LLM pra respeitar:
  ```bash
  npx tsx scripts/apply-stage2-caps.ts \
    --in {EDITION_DIR}/_internal/01-approved.json \
    --out {EDITION_DIR}/_internal/01-approved-capped.json
  ```
  Writer recebe `01-approved-capped.json`. Lint pós-writer (`--check section-counts`) valida que o output respeitou os caps; falha = re-disparar writer.

- **Limpar/truncar summaries em inglês (#1490 / #1572).** Antes de stitch, rodar:
  ```bash
  npx tsx scripts/translate-summaries.ts \
    --in {EDITION_DIR}/_internal/01-approved-capped.json \
    --out {EDITION_DIR}/_internal/01-approved-capped.json
  ```
  O script é idempotente (marca `summary_translated: true` após processar). Strip de prefixo arXiv + 1ª frase + truncate em 150 chars; **não faz tradução LLM** — apenas cleanup determinístico pra evitar prefix bruto `[TRADUZIR]` no MD final. Items com `summary_lang: "en"` (categorize.ts #1473) e/ou arXiv abstract são afetados. Stitch adiciona `[TRADUZIR]` na **DESCRIÇÃO** (2ª linha) quando o summary está em EN — **nunca no título** (#1697/#1634: título de seção secundária preserva o nome original do recurso, nunca traduzido). O prefixo da descrição é removido pelo **humanizer** (ETAPA 0, que roda no draft stitched inteiro — seções secundárias incluídas) ou pelo editor no gate. (Obs: `writer-destaque` NÃO toca seções secundárias — só escreve D1/D2/D3.) Sem este step, o `[TRADUZIR]` + summary em inglês cru vazam pro newsletter HTML (histórico: `docs/orchestrator-stage-narrative-history.md#stage-2-translate-leak`).

**Em uma única mensagem**, disparar os agents simultaneamente:

### Modo padrão: writer-destaque paralelo (#1158, #1451, #2343)

**INVARIANTE (#1451 decisão editorial 2026-05-21):** writer paralelo é **default em todas as situações**. Corta wall-clock do Stage 2 de ~30min pra ~10min (Stage 2 era 92% do total do pipeline).

**Pré:** ler `_internal/01-approved-capped.json` direto via `Read` tool e extrair `highlights[]`. Cada highlight tem `{ rank, score, bucket, reason, article }`. **#2343: range válido é {2,3}** — `highlights.length < 2 || highlights.length > 3` → fallback (edge case). Para 2 destaques, dispatch writer-destaque × 2 (D1 + D2). Para 3, dispatch × 3 (D1 + D2 + D3). Construir `peer_titles_per_destaque` inline: para cada destaque N, peer_titles é o array de `highlights[i].article.title` para i ≠ N-1.

`category_label` é a **Category editorial do destaque** — o tema que aparece no header `DESTAQUE N | {emoji} {CATEGORY}` (ex.: EDUCAÇÃO, MERCADO, REGULAÇÃO). Derive de `highlights[N-1].article.category` e **refine pelo tema do artigo** quando a category interna for genérica:
- `lancamento` → "LANÇAMENTO"
- `pesquisa` → "PESQUISA"
- `noticias` → category temática do artigo (ex.: MERCADO, EDUCAÇÃO, REGULAÇÃO) — **não** o literal "NOTÍCIAS"
- `tutorial` → "USE MELHOR"
- `video` → "VÍDEO"

**#6083 (feedback do editor na 260825: "categoria nunca deve ser 'notícias'"):**
"NOTÍCIAS" não carrega informação — qualquer destaque é uma notícia. Escolha
SEMPRE um label específico ao tema da história antes de considerar o genérico.
Lista de referência de primeira escolha (não exaustiva; crie label específico
quando nenhum servir):

| Tema | Label |
|---|---|
| País/bloco como protagonista | 🇧🇷 BRASIL, 🇺🇸 EUA, 🇨🇳 CHINA, 🇪🇺 UE |
| Financiamento/investimento/aquisição | 💰 FINANCIAMENTO |
| Novo modelo/capacidade de modelo | 🤖 MODELOS |
| Regulação/legislação/processos | ⚖️ REGULAÇÃO |
| Artigo científico/achievement de pesquisa | 🔬 PESQUISA |
| Segurança/abuso/deepfake/crime | 🛡️ SEGURANÇA |
| Mercado/negócio/receita | 📈 MERCADO |
| Educação/ensino | 🎓 EDUCAÇÃO |
| Hardware/chips/infra | 🖥️ HARDWARE |
| Trabalho/empregos/profissões | 💼 TRABALHO |
| Saúde/medicina | 🏥 SAÚDE |
| Cultura/mídia/entretenimento | 🎬 CULTURA |

Reserve "NOTÍCIAS" só para quando genuinamente NENHUM tema mais específico se
aplicar — e nunca a 2+ destaques na mesma edição.

⚠️ **Não** derive de `highlights[N-1].bucket` (#1668): pós-#1629/#1611 o `bucket`
carrega o bucket de SEÇÃO da newsletter (`lancamento`/`radar`/`use_melhor`/`video`,
emitido por `merge-scored-chunks` → `scorer-select`), **não** a category do
artigo — um highlight com `bucket="radar"`/`"use_melhor"` (o caso mais comum)
não bate nenhum dos cases acima e cairia no fallback. `article.category` é a
fonte correta. (O mapping bucket→seção da newsletter acontece no render layer.)

Não usar `scripts/extract-destaques.ts` aqui — esse script parsea MD final (pós-writer), não JSON pré-writer. Confusão de paths levou ao bug do #1451 review (PR #1462).

**Dispatch paralelo (uma única mensagem com N+2 chamadas Agent — N writer + 2 social, onde N = highlights.length ∈ {2,3}):**

1. `Agent` → `writer-destaque` × N — uma instância por destaque (n=1..N). Cada uma recebe:
   - `destaque_n`, `destaque` (= `highlights[N-1].article`), `category_label`
     - **#3920: passe o `article` INTEIRO** (não enumere campos) — ele carrega `cluster_sources[]` quando a história teve cobertura múltipla (dedup). O writer usa isso pra emitir o bloco "Aprofunde:" e citar fatos das fontes extras. O `article.url` já é o link canônico (artigo mais completo do cluster).
   - `peer_titles` (titles dos outros 2 — preserva voice diversity)
   - `edition_date`
   - `out_path = {EDITION_DIR}/_internal/02-d{N}-draft.md`
   - `image_prompt_out_path = {EDITION_DIR}/_internal/02-d{N}-prompt.md`

2. `Agent` → `social-writer` (#3991, reverte #3486 — colapsa `social-linkedin`+`social-facebook`+`social-instagram` num único agent) passando:
   - `approved_json_path = {EDITION_DIR}/_internal/01-approved-capped.json`
   - `out_dir = {EDITION_DIR}/`
   - `outros_count`: **não injetar (#2319)** — `social-writer` mantém `{outros_count}` como placeholder literal (igual a `{edition_url}`), consumido só pelo `## post_pixel`. Stage 6 (`resolve-post-pixel.ts`) resolve do `01-approved-capped.json` FINAL. Não calcular nem passar no prompt.

   Gera `_internal/03-social.tmp.md` com 1 texto genérico (estilo Instagram, #3991) por destaque — IDÊNTICO pra LinkedIn/Facebook/Instagram, SEM CTA de canal — + `## post_pixel` (post pessoal do Pixel, inalterado desde #1690). A linha de CTA por canal (e-mail no Facebook, "link na bio" no Instagram, nenhuma no LinkedIn — ver `scripts/lib/social-cta-lines.ts`) é injetada só no Stage 5, nunca aqui.

3. `Agent` → `social-curto` (#3992, mesmo input que social-writer — `approved_json_path` + `out_dir`; `outros_count` não se aplica; **independente do #3991**, não muda). Gera `_internal/03-curto.tmp.md` com 1 texto ≤280 chars por destaque, compartilhado por Twitter/X (dispatch via Buffer MCP no Stage 5, #3994) e Threads (`publish-threads.ts`, que lê exclusivamente esta seção — sem fallback pra `# Social`/`# Facebook`, #4294).

**Aguardar os N writer-destaques + 2 social retornarem.** Cada `writer-destaque` retorna JSON `{ out_path, image_prompt_path, destaque_n, char_count, warnings }`. **Se `warnings[]` de qualquer um não estiver vazio, pare e reporte ao usuário antes de prosseguir** — mesma regra do writer único legacy.

**Capturar custo de tokens (#3748):** monte um array `[{agent_type, usage_raw}]` com o bloco `<usage>` de cada dispatch acima (writer-destaque ×N + 2 social) e rode:
```bash
npx tsx scripts/record-agent-costs.ts --edition-dir {EDITION_DIR}/ --edition {AAMMDD} \
  --stage 2 --costs {EDITION_DIR}/_internal/tmp-agent-costs-stage2.json
```
Persiste breakdown por agent_type em `_internal/cost.json` (complementa o total do stage em `stage-status.json`, #3441). Falha não-bloqueante.

**Pós:** rodar `scripts/stitch-newsletter.ts` (#1463) que produz `02-draft.md` determinístico unificando os 3 destaque drafts + seções secundárias + blocos fixos:

```bash
npx tsx scripts/stitch-newsletter.ts --edition-dir {EDITION_DIR}/
```

**#1938/#2527/#2978/#3212/#3476/#3824:** o stitch auto-injeta os boxes de divulgação nos slots 1 (D1/D2), 2 (D2/D3) e 3 (região pós-ÚLTIMO-destaque, entre D3/D2 e USE MELHOR) em **todo daily** (decisão editorial — os 3 boxes são permanentes desde #3476). Config-driven via `boxes_divulgacao` de `platform.config.json`. Os blocos 📣 Clarice (`data/snippets/clarice-divulgacao.md`, via `loadClariceCallout`) e indicação de ferramenta (`data/snippets/indicacao-ferramenta.md`) seguem disponíveis para reuso (mensal / troca pontual / configurar em qualquer slot). Idempotente por slot (pula se a região correspondente já traz um callout `**📣/📚/🎉 …**` ou `🛒 …`, marcador-agnóstico — ver `boxAlreadyPresentInGap`/`boxAlreadyPresentAfterLastDestaque`). Kill-switch pontual: `--no-sponsor` (suprime a injeção nos slots ativos). **#4274 (slot 0, introdução, opcional, default `null`):** `boxes_divulgacao.slot0` injeta um 4º box entre a coverage line e `**DESTAQUE 1`, só quando o editor o atribui no painel Caixas — mesma idempotência (`boxAlreadyPresentAtIntro`). Limitação: compete pela mesma região do `introCallout`/agradecimento — se for a ÚNICA ocupação da intro E vier bold-wrap total, é lido como `introCallout`, não `boxDivulgacao0` (ver `locateBoxAtIntro` em `newsletter-parse.ts`); prefira formato multi-parágrafo pro slot0 quando não houver outro conteúdo de intro. **#4626 — seleção AUTOMÁTICA dos slots 1/2/3 (substitui a leitura estática quando não há pin manual):** ANTES de chamar `stitchNewsletter()`, `main()` chama `resolveBoxesForEdition()` (`scripts/select-boxes-by-clicks.ts`) — se `boxes_divulgacao_auto.enabled` for `true` (default desde #4626), todo slot 1/2/3 NÃO listado em `pinned_slots` é resolvido por cliques + tendência de queda (janela recente vs. anterior cede espaço a média histórica inflada) + anti-repetição (nunca a box da edição imediatamente anterior). Slot pinado, ou `enabled: false`, usa `boxes_divulgacao.slotN` tal como está (pré-#4626, sem mudança). Sem candidato elegível cede pro valor já configurado — nunca esvazia o slot. Nunca grava em `platform.config.json` (só vale pra esta stitch); fica registrado em `_internal/box-selection.json`, consumido pelo resumo do Stage 4 (§4c.7) como informação, sem gate (decisão do editor #4626: troca de box é baixo risco, não conteúdo editorial).

O script é determinístico, sem LLM. Ordem canonical (#3476, slot0 desde #4274):
- Coverage line (do `01-approved-capped.json > coverage.line`)
- box de divulgação slot 0 (introdução — opcional, entre a coverage line e DESTAQUE 1)
- DESTAQUE 1 block (lê `_internal/02-d1-draft.md`)
- box de divulgação slot 1 (D1/D2)
- DESTAQUE 2 block (lê `_internal/02-d2-draft.md`)
- box de divulgação slot 2 (D2/D3) — **omitido em edições de 2 destaques**
- DESTAQUE 3 block (lê `_internal/02-d3-draft.md`) — **omitido em edições de 2 destaques (#2343)**
- box de divulgação slot 3 (pós-último-destaque — D3 se existir, senão D2)
- **🛠️ USE MELHOR** (se houver candidato selecionado)
- É IA? section (lê `01-eia.md` se existir, strip frontmatter YAML) — **#3476: agora DEPOIS de USE MELHOR** (antes ficava logo após o último destaque, #2546); se a edição não tiver USE MELHOR, É IA? cai logo após o box do slot 3
- **VÍDEOS** (formato canonical `**[title](url)**` + summary, singular/plural conforme count #1324) — **#3820: agora ANTES de LANÇAMENTOS** (decisão editorial 260722; antes ficava depois, #3100 só tinha subido VÍDEOS pra antes de RADAR)
- **LANÇAMENTOS**, **RADAR** (idem; omite seção vazia — RADAR mergeia PESQUISAS + OUTRAS NOTÍCIAS, #1569)
- **ERRO INTENCIONAL** placeholder (`render-erro-intencional.ts` re-insere ao final pós-Clarice — auto-converge)
- **🎁 SORTEIO** (texto fixo) + **🙋🏼‍♀️ PARA ENCERRAR** (#4274: cabeçalho fixo; slot A — apoio+ferramentas — e slot B — convite social, sempre último — são texto editável via painel Caixas em `platform.config.json` → `para_encerrar.{slot_a,slot_b}`, default = o texto de sempre quando não customizado)

Lint pós-stitch valida overlap de hook entre destaques; se overlap detectado, re-dispatch o destaque "perdedor" com peer_titles atualizado.

### Modo fallback: writer único (legacy, casos edge)

Usar quando `highlights.length < 2 || highlights.length > 3` (corrupção do gate — fora do range {2,3}). Coordenador detecta isso lendo JSON antes do dispatch:

```typescript
// Pseudo: top-level lê via Read tool, parsea, branch:
const approved = JSON.parse(read("_internal/01-approved-capped.json"));
const n = approved.highlights.length;
if (n < 2 || n > 3) {
  // fallback pro writer único legacy (abaixo) — corrupção do gate
} else {
  // dispatch paralelo writer-destaque × n (2 ou 3 instâncias, acima)
}
```

Fallback dispatch:

1. `Agent` → `writer` (Sonnet) passando:
   - `highlights` (extraído de `_internal/01-approved-capped.json`)
   - `categorized = _internal/01-approved-capped.json`
   - `edition_date`
   - `out_path = {EDITION_DIR}/_internal/02-draft.md`
   - `d1_prompt_path = {EDITION_DIR}/_internal/02-d1-prompt.md`
   - `d2_prompt_path = {EDITION_DIR}/_internal/02-d2-prompt.md`
   - `d3_prompt_path = {EDITION_DIR}/_internal/02-d3-prompt.md`

2. `Agent` → `social-writer` (#3991, reverte #3486, mesmo input do writer; `{outros_count}` é placeholder literal no output, consumido só pelo `## post_pixel` — não injetar #2319).
3. `Agent` → `social-curto` (#3992, mesmo input do writer; independente do #3991).

Aguardar os 3 retornarem. Writer retorna JSON `{ out_path, d1_prompt_path, d2_prompt_path, d3_prompt_path, checklist, warnings }`. Se `warnings[]` não estiver vazio, **pare** e reporte ao usuário antes de prosseguir.

**Validar outputs dos 3 agents antes de qualquer processamento (#872, #3991, #3992):** se um deles falhou silenciosamente (timeout, retorno mal-formado), o merge em 2c crasharia lendo arquivo ausente (`03-social.tmp.md`) ou perderia a seção Curto silenciosamente. Antes de prosseguir, rodar:

```bash
npx tsx scripts/validate-stage-2-outputs.ts --edition-dir {EDITION_DIR}/
```

O script verifica que `_internal/02-draft.md` e `_internal/03-social.tmp.md` existem e não estão vazios (FATAL — exit 1) e que `_internal/03-curto.tmp.md` existe e não está vazio (WARN — não bloqueia, mas sinaliza que o merge vai sair sem a seção `# Curto` — ambos os dispatches de X (Buffer MCP, #3994) e Threads (`publish-threads.ts`, #4294) fazem skip, sem fallback, quando `# Curto` está ausente/incompleto). Exit 1 = algum agent obrigatório falhou — relatar ao editor com sugestão de re-rodar isolado (`/diaria-2-escrita {AAMMDD} newsletter` ou `social`). Não prosseguir.

### 2b. Processar newsletter

**Lints consolidados (#5416):**
```bash
npx tsx scripts/lint-newsletter-md.ts --stage 2 --json --edition-dir {EDITION_DIR}
```
Substitui as 6 invocações separadas que existiam aqui antes (1 processo Node por check) por uma única chamada agregadora — mesmas funções, mesmo veredito por check, só menos overhead de processo. Output (stdout): JSON `{ stage: 2, passed: boolean, checks: [{ id, source_issue, severity, ok, result }, ...] }`. Os 6 `id` (`url-bucket`, `section-counts`, `destaque-min-chars`, `destaque-max-chars`, `why-matters-length`, `aprofunde-format`) são **todos gate-blocking** — `passed` já reflete "nenhum falhou". Debug de 1 check isolado (`--check X --md {EDITION_DIR}/_internal/02-draft.md`) continua funcionando exatamente como antes (modo aditivo, não removido). Para cada `id` com `ok:false`, a ação de re-dispatch é a descrita abaixo, indexada pelo `id` — rode os re-dispatches necessários e repita a chamada acima até `passed: true` (ou esgotar as tentativas descritas por check).

`url-bucket` (#165): valida que cada URL nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS bate com o bucket correspondente em `_internal/01-approved-capped.json`. Falha = URL na seção errada ou URL fantasma (não existe no approved). Ação: **re-disparar o writer** com a lista de erros explicitada no prompt. Até 3 tentativas; se persistir após 3, reportar erro e pausar pra fix manual no `02-draft.md`. Caso de borda comum: ferramenta nova com category `noticias` no bucket `radar` que o writer põe em LANÇAMENTOS por associação temática.

`section-counts` (#358, #907, #1629): valida que cada seção secundária respeita o cap (lançamentos≤5, radar=`max(5, 12-d-l)`). O writer pode ignorar caps mesmo recebendo `01-approved-capped.json` se ele decidir incluir runners-up por achar relevante. Ação: re-disparar writer com a violação no prompt.

`destaque-min-chars` (#914) + `destaque-max-chars` (#964): validam mínimo e máximo de cada destaque (janela única: todos 900–1000, #6061). Falha do min = destaque anêmico — re-disparar writer com instruction explícita:
> "Destaque D{N} tem {chars} chars (mínimo {min}). Expanda: (a) adicione 1 frase em 'Por que isso importa' contextualizando impacto pro leitor BR — ex: timing eleitoral, custo de infra, mudança de processo (respeitando o teto de 300 chars do why, #3993); OU (b) adicione mais 1 parágrafo curto de body com detalhe técnico/empresarial. NÃO repetir conteúdo já presente." (#1208 — anti-pattern observado em 260517: D2/D3 saiam ~860 chars com why em 1 frase só).
Falha do max = destaque inflado — re-disparar writer com instruction de trimar parágrafo menos relevante OU encurtar 'Por que isso importa' (respeitando o piso de 180 chars do why, #3993).

`why-matters-length` (#3993): valida que o parágrafo "Por que isso importa" de cada destaque tem entre 180 e 300 chars (excluindo a label e o bloco "Aprofunde:") — janela mais curta que a spec anterior (~400 chars). Ação: re-disparar o `writer-destaque` do destaque afetado com o char count medido + a instrução: "reescreva 'Por que isso importa' com {180-300} chars, 2 frases curtas (frase 1: impacto direto; frase 2: implicação concreta), sem tocar no resto do destaque." Se o ajuste do why empurrar o total pra fora da janela única 900-1000 (#6061), o body precisa compensar na mesma passada (ver orçamento de chars em `writer-destaque.md` passo 2) — não re-disparar 2 vezes em sequência sem incluir as duas instruções juntas.

`aprofunde-format` (#3920): valida o bloco "Aprofunde:" dos destaques com cluster (item bem-formado, após "Por que importa", não vazio). Bloco AUSENTE nunca falha (é opcional). Ação: item malformado/lixo no bloco — re-disparar o writer do destaque com instruction pra corrigir o formato `* [Título](URL) - Fonte`.

- **Normalizar layout (inline — sem Agent, #157):**
  ```bash
  npx tsx scripts/normalize-newsletter.ts \
    --in {EDITION_DIR}/_internal/02-draft.md \
    --out {EDITION_DIR}/_internal/02-normalized.md \
    2> {EDITION_DIR}/_internal/02-normalize-report.json
  ```
  Heurístico conservador — só quebra quando o pattern é inequívoco (ex: 3 títulos do destaque colados no header, ou título+URL+descrição colados num item de seção). Se nenhum bug detectado, `02-normalized.md` é cópia idêntica do draft. Falha do script → log warn + fallback usa `02-draft.md`.

- **Singularizar + adicionar emoji nos headers de seção (#1324, #1328):** writer escreve sempre plural (`**LANÇAMENTOS**`); script normaliza pra singular quando N=1 + adiciona emoji prefix (`**🚀 LANÇAMENTO**`):
  ```bash
  npx tsx scripts/singularize-md-sections.ts \
    --md {EDITION_DIR}/_internal/02-normalized.md
  ```
  Idempotente. Stdout: JSON `{changed, sections}`. Falha não-bloqueante (log warn) — render-newsletter-html.ts em Stage 4 também aplica a normalização, então pior caso o gate MD mostra plural mas o HTML final fica correto.

- **Humanizar (#308, #1072):** invocar skill `humanizador` no arquivo `02-normalized.md` — remove tics LLM (gerúndio em cascata, vocabulário inflado, aberturas cenográficas, etc.), calibrando a voz com `data/past-editions.md` como referência:
  ```
  Skill("humanizador", "Leia {EDITION_DIR}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions.md como referência, e salve o resultado em {EDITION_DIR}/_internal/02-humanized.md.")
  ```
  **Retry 3x + abort se persistir (#1072).** Se a skill retornar erro OU se `02-humanized.md` for byte-idêntico a `02-normalized.md` (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** com erro claro pro editor — não usar fallback "normalized direto pra Clarice" silenciosamente. Justificativa: humanizador remove marcas IA que Clarice **não** pega; sem ele a edição sai com prosa polida-vazia (issue #1072). Logar cada tentativa: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'humanizador attempt N/3 failed'`. Após 3ª falha: `--level error --message 'humanizador esgotou retries — abortar Stage 2'` + exit do pipeline.

- **Revisar com Clarice (inline — sem Agent):**
  Determinar e **persistir** `CLARICE_INPUT` em arquivo (#871) — evita drift entre o passo de leitura e o passo de diff:
  ```bash
  npx tsx scripts/resolve-clarice-input.ts --edition-dir {EDITION_DIR}/
  ```
  O script aplica a fallback chain `(02-humanized.md → 02-normalized.md → 02-draft.md)`, valida que o arquivo escolhido existe, e grava o nome relativo em `{EDITION_DIR}/_internal/02-clarice-input.txt`. Se nenhum existir, exit 1 (FATAL).

  **Snapshot pré-Clarice (#874).** Antes de aplicar Clarice, copiar o `CLARICE_INPUT` resolvido para `_internal/02-pre-clarice.md`. Esse snapshot é (a) source-of-truth pra resume mid-Clarice (ver SKILL diaria-2-escrita), (b) input pro check de estabilidade de URLs (#873) abaixo, (c) input do `clarice-diff.ts`:
  ```bash
  CLARICE_INPUT=$(cat {EDITION_DIR}/_internal/02-clarice-input.txt)
  cp "{EDITION_DIR}/_internal/$CLARICE_INPUT" {EDITION_DIR}/_internal/02-pre-clarice.md
  ```

  **Assertion obrigatória (review #889 P2).** Antes de chamar `mcp__clarice__correct_text`, verificar que o snapshot foi gravado. Se ausente, abortar e logar erro — sem snapshot não há como detectar URL stability nem fazer resume mid-Clarice:
  ```bash
  test -f {EDITION_DIR}/_internal/02-pre-clarice.md || {
    npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before MCP Clarice call"
    echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar MCP Clarice." >&2
    exit 1
  }
  ```

  1. Ler `_internal/02-clarice-input.txt` pra obter o filename relativo. Ler conteúdo de `{EDITION_DIR}/_internal/{FILENAME}`.
  2. Chamar `mcp__clarice__correct_text` passando o texto. **Chunking automático (#2606, threshold atualizado #2798/#5082):** se o texto tiver > 4.500 chars (threshold `CLARICE_CHUNK_THRESHOLD` de `scripts/lib/clarice-chunk.ts` — **não** 9.000, valor desatualizado corrigido em #5082), **não** passar o texto inteiro — usar `splitIntoChunks(text, 4500)` para dividir em chunks em fronteiras seguras (seção `---` > parágrafo vazio > fim de linha; nunca no meio de frase ou link markdown). **Para cada chunk, chamar `mcp__clarice__correct_text` SERIALMENTE — um de cada vez, aguardando a resposta antes de disparar o próximo, NUNCA em paralelo/mesmo bloco de tool calls** (#4952: causa raiz confirmada de timeout recorrente é concorrência de requests ao cortex.clarice.ai, não tamanho de payload — disparar chunks em paralelo reproduz o mesmo padrão de timeout que #4952 já corrigiu do lado do script REST via `CLARICE_CHUNK_CONCURRENCY=1` default; o caminho MCP não tem esse guard mecânico, então a disciplina serial precisa vir da instrução aqui). Após coletar as sugestões de cada chunk, usar `mergeChunkSuggestions([{chunk, suggestions},...])` (apply chunk-local + re-concatenação — sem aritmética de offset) para produzir o texto corrigido com a política de ambiguidade: sugestão pulada (+ log warn) se `from` aparece 0× (não encontrado) ou 2+× (ambíguo) no chunk — evita replace global de termos curtos como `"os"→""`. Salvar a resposta crua (array de todas as sugestões de todos os chunks) em `{EDITION_DIR}/_internal/02-clarice-suggestions.json` antes de aplicar (auditoria + resume). **Nota:** o fallback REST (`clarice-correct.ts`) também suporta chunking desde #2626 — para textos > 4.5k, o script divide em chunks via `correctTextChunked`, faz 1 request REST por chunk (serial por default desde #4952) e usa `mergeChunkSuggestions` internamente. O texto corrigido pode ser gravado opcionalmente via `--corrected-out` (auditoria).

     **Fallback REST (#1329, retry #2320, chunking #2626).** Se a chamada ao MCP retornar erro de disconnect/unavailable OU se `<system-reminder>` indicar que `mcp__clarice` ficou offline, **não fazer halt** — em vez disso, cair no fallback REST com retry/backoff que escreve no mesmo path. **Sempre passar `--corrected-out`** (#2626): o script já chunka textos > 4.5k e aplica as sugestões chunk-localmente via `mergeChunkSuggestions`, gravando o texto corrigido nesse arquivo. Esse é o resultado correto para textos multi-chunk — **não** re-aplicar `02-clarice-suggestions.json` ao texto inteiro via `clarice-apply.ts` (uma âncora única dentro de um chunk pode aparecer 2+× no texto inteiro e seria pulada como ambígua, sub-corrigindo silenciosamente):
     ```bash
     npx tsx scripts/clarice-correct.ts \
       --in {EDITION_DIR}/_internal/{FILENAME} \
       --out {EDITION_DIR}/_internal/02-clarice-suggestions.json \
       --corrected-out {EDITION_DIR}/_internal/02-clarice-corrected.md \
       --retry \
       --edition {AAMMDD}
     ```
     `--retry` usa 3 tentativas × 60s timeout com backoff exponencial (0s → 5s → 10s entre tentativas). Teto **por chunk**: ~3min15s; para textos multi-chunk o teto total é ~N × 3min15s (N = nº de chunks). Sem `--retry`, timeout é 30s e há apenas 1 tentativa (comportamento legado). Em sucesso, **consumir `02-clarice-corrected.md` diretamente no passo 3** (já é o texto corrigido — pular `clarice-apply.ts`). **Observabilidade por tentativa (#2798):** com `--edition`, cada tentativa (sucesso/retry/falha fatal) é logada em `data/run-log.jsonl` (`message: "clarice_rest_attempt"`, `details: {attempt, elapsedMs, payloadBytes, outcome, status?, chunksInFlight?, viaParagraphFallback?}`) — útil pra correlacionar timeout com concorrência (não tamanho de payload — teoria de tamanho refutada em #4952) via `/diaria-log {AAMMDD}`. **Fallback de 2º nível por-parágrafo (#5082):** habilitado por default, não precisa de flag — se um chunk esgotar os retries acima (não-4xx), o script automaticamente sub-divide esse chunk em parágrafos e tenta 1 request isolado por parágrafo substantivo (sem retry, timeout curto de 20s), recuperando parte ou toda a correção em vez de desistir do chunk inteiro; entradas do run-log com `viaParagraphFallback: true` vêm desse caminho. Não requer ação do orchestrator — é automático dentro de `clarice-correct.ts`. Pra forçar essa granularidade manualmente desde o início (debug/investigação, ver #5082), existe `--granularity paragraph`.

     Logar warn no run-log antes de invocar o script:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "clarice MCP failed — REST fallback" --details '{"server":"clarice","kind":"mcp_to_rest_fallback"}'
     ```

     Exit 0 = sucesso (segue pro passo 3). Exit 3 = HTTP non-2xx ou timeout em TODAS as tentativas (logar `level: error` + halt banner pra editor decidir retry vs skip). Exit 2 = `CLARICE_API_KEY` ausente (halt). **Exit 5 (#5755) = guard de staleness do `--corrected-out`** — mtime do arquivo escrito é anterior ao início da chamada (no-op silencioso: nenhuma requisição HTTP nova, conteúdo de execução ANTERIOR) — halt, nunca consumir esse arquivo, re-rodar em foreground. Se `clariceRest === false` (lido do `preflight-state.json` no início deste stage — ver acima), pular direto pro halt banner — sem chance de fallback bem-sucedido.

     **Skip consciente (#2320).** Se editor aprovar o skip após halt (MCP + REST falharam):
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn \
       --message "clarice_skip" \
       --details '{"reason":"mcp_down_rest_exit3_editor_approved","stage":2}'
     ```
     Este evento estruturado é detectado por `collect-edition-signals.ts` (`signalsFromClariceSkips`) e surfaçado pelo auto-reporter como signal `clarice_skip` pra rastrear frequência. Ao skip:
     1. Copiar `02-pre-clarice.md` → `02-reviewed.md`.
     2. Gravar `[]` em `_internal/02-clarice-suggestions.json` (array vazio = Clarice chamada sem sugestões — aceito por `checkClariceRan` em `check-stage2-invariants.ts`):
        ```bash
        echo '[]' > {EDITION_DIR}/_internal/02-clarice-suggestions.json
        ```
     3. Continuar o pipeline normalmente.
  3. Produzir o texto revisado em `{EDITION_DIR}/02-reviewed.md`. **Aplicação é incondicional (#4514):** aplicar **todas** as sugestões da Clarice, sem cherry-pick por gosto/registro e sem apresentá-las ao editor como menu de escolha antes — relatar o que mudou no diff (passo 4 abaixo), não negociar antes. **Única exceção:** sugestão que corrompa identificador técnico ou nome de marca (ex: `diar.ia` → `diária` quebraria a marca) — aplicar todo o resto e sinalizar só essa ao editor no gate. **Dois caminhos, conforme a origem das sugestões:**
     - **Caminho MCP (normal):** aplicar as sugestões ao texto. Se houve chunking (#2606), o texto corrigido é o resultado do `mergeChunkSuggestions` (apply chunk-local) — gravar esse texto. Se foi chamada única (≤4.5k), aplicar as sugestões ao texto integral.
     - **Caminho fallback REST (#2626):** o script já gravou o texto corrigido (chunk-applied) em `02-clarice-corrected.md`. **Copiar esse arquivo diretamente** para `02-reviewed.md` — **não** re-aplicar `02-clarice-suggestions.json` via `clarice-apply.ts` (re-aplicar a lista plana ao texto inteiro sub-corrige textos multi-chunk; ver fallback acima):
       ```bash
       cp {EDITION_DIR}/_internal/02-clarice-corrected.md {EDITION_DIR}/02-reviewed.md
       ```
     Em ambos os casos, gravar o texto corrigido (não a lista de sugestões) em `{EDITION_DIR}/02-reviewed.md`.
  4. Gerar diff legível usando o snapshot pré-Clarice, passando `02-normalized.md` (pré-Humanizador) como 4º argumento opcional — **#3929: a Clarice tem precedência sobre o Humanizador** (correções que revertem uma edição de estilo do Humanizador são esperadas e não devem ser bloqueadas por passo posterior; o 4º arg permite ao `clarice-diff.ts` sinalizar explicitamente `⚠️ REVERTE HUMANIZADOR` em cada alteração que reverte, dando contexto ao editor no gate em vez de uma correção gramatical indistinguível):
     ```bash
     npx tsx scripts/clarice-diff.ts \
       {EDITION_DIR}/_internal/02-pre-clarice.md \
       {EDITION_DIR}/02-reviewed.md \
       {EDITION_DIR}/_internal/02-clarice-diff.md \
       {EDITION_DIR}/_internal/02-normalized.md
     ```
  Se a Clarice falhar (MCP + REST), propagar o erro — **não** usar o rascunho sem revisão.

- **Sincronizar o bloco É IA? de volta pra `01-eia.md` (#5459).** O bloco `**É IA?**` em `02-reviewed.md` é só um MIRROR copiado verbatim de `01-eia.md` no stitch — mas `extractContent` sempre lê `01-eia.md`, nunca o mirror. Humanizador+Clarice, que acabaram de rodar sobre `02-reviewed.md` inteiro sem exclusão de seção, podem ter reescrito o bloco (achado ao vivo 260817: travessão removido só no mirror). Sem este passo só o Stage 4 (`eia-credit-synced`, #3825, warning-only) descobriria, sempre exigindo fix manual — rodar agora fecha o loop automaticamente: `npx tsx scripts/sync-eia-block.ts --edition-dir {EDITION_DIR}`. Exit 0 sempre que `02-reviewed.md` existir (no-op se sem mirror ainda ou já sincronizado); reescreve `01-eia.md` in-place quando divergir, preservando o frontmatter YAML. Exit 3 só se `02-reviewed.md` faltar (erro real).

- **Verificar estabilidade de URLs em LANÇAMENTOS (#873).** Clarice pode "limpar" URLs (remover query params, normalizar paths, adicionar trailing slash) — isso quebra a regra "LANÇAMENTOS só com link oficial" (#160) silenciosamente, porque a URL pós-Clarice pode não bater mais com a whitelist. Comparar URLs pré/pós-Clarice **antes** de `validate-lancamentos.ts`:
  ```bash
  npx tsx scripts/verify-clarice-url-stability.ts \
    --pre {EDITION_DIR}/_internal/02-pre-clarice.md \
    --post {EDITION_DIR}/02-reviewed.md
  ```
  Exit 0 = todas URLs em LANÇAMENTOS estáveis (warnings em outras seções são informativos, não bloqueiam). Exit 1 = Clarice mexeu em URL de lançamento — incluir o output no prompt do gate humano com diff `antes/depois` pra editor decidir: aceitar a versão pós-Clarice (pode quebrar #160) ou restaurar manualmente em `02-reviewed.md`. Não auto-restaurar — preserva agência editorial.

- **Verificar sobrevivência dos cupons CLARICE (#1982).** Os cupons `NEWS25`/`NEWS50` + link de afiliado `?via=diaria` aparecem no bloco PARA ENCERRAR (sempre) e no box de divulgação `**📣 …**` Clarice **apenas quando esse for o callout ativo** (desde #2527 o default diário é o 📚 livros, sem cupons — o check sai exit 0 "sem patrocínio", esperado). Esses literais passam por humanizer + Clarice e não têm guard. Comparar o baseline **pré-LLM** (`02-normalized.md`, pré-humanizer — cobre os 2 passos; #1982 code-review) vs o pós:
  ```bash
  npx tsx scripts/verify-clarice-coupons.ts \
    --pre {EDITION_DIR}/_internal/02-normalized.md \
    --post {EDITION_DIR}/02-reviewed.md
  ```
  Exit 0 = cupons/link preservados (ou ausentes no pré — edição sem patrocínio). Exit 1 = algum literal sumiu/mudou pós-LLM → **surfaçar no gate** (quebra tracking de afiliado / cupom do parceiro); editor restaura o literal exato em `02-reviewed.md`. Não auto-restaurar.

- **Sincronizar contagem da intro (#743, #876):** após a Clarice, o número declarado na intro pode divergir do número real de artigos (ex: lançamentos rejeitados reduziram o total) e a narrativa pode mencionar "X lançamentos" com X antigo. Corrigir automaticamente, passando o resumo de lançamentos removidos escrito em §2a:
  ```bash
  npx tsx scripts/sync-intro-count.ts \
    --md {EDITION_DIR}/02-reviewed.md \
    --lancamentos-removed {EDITION_DIR}/_internal/02-lancamentos-removed.json
  ```
  Se o script retornar `changed: true` ou `lancamentos_changed: true`, logar `warn` no run-log com os valores antes/depois. Não bloquear — correções são cirúrgicas (apenas o número, sem mexer no resto do texto). Quando `02-lancamentos-removed.json` não existe (ex: §2a foi pulado em rerun), o script ignora silenciosamente esse passo.

- **Validar LANÇAMENTOS oficiais (#160):**
  ```bash
  npx tsx scripts/validate-lancamentos.ts {EDITION_DIR}/02-reviewed.md
  ```
  Garante que todo URL na seção LANÇAMENTOS bate com whitelist oficial (`scripts/categorize.ts > LANCAMENTO_DOMAINS`/`PATTERNS`). **#1968 (verificação POSITIVA):** além do domínio oficial, cada item precisa de um sinal de produto (software/hardware) no slug/título — item oficial sem sinal vai pra `not_a_tool` e também faz exit 1 (pega parceria/evento/programa/relatório). Se exit code != 0 (URL não-oficial OU `not_a_tool`), **incluir os erros no prompt do gate humano** mostrando linha + URL + sugestão de mover pra NOTÍCIAS. Não bloquear automaticamente — editor decide. **Se for ferramenta legítima de slug atípico** (ex: hardware NVIDIA Jetson), adicionar a URL a `seed/lancamentos-tool-allowlist.txt` (1 substring por linha) — override permanente da verificação positiva.

- **Sincronizar linha de cobertura (#1097):** após Clarice + validate-lancamentos, antes do render-erro-intencional, rodar:
  ```bash
  npx tsx scripts/sync-coverage-line.ts --edition-dir {EDITION_DIR}/
  ```
  Auto-calcula X = nº de **e-mails/threads** recebidos em `diariaeditor@gmail.com` (1 e-mail = 1 submissão, independente de quantas URLs carrega — lido do marker `.marker-inject-inbox-urls.json`), Y = `pool.length - inboxLinks` (onde `inboxLinks` é a contagem de **LINKS** que entraram pelo canal do editor, não a contagem de e-mails — misturar essas unidades foi o bug do #1864; sem `inboxLinkCount`/marker legado, cai no fallback `pool - X`, caso degradado, não o comportamento canônico), Z (itens visíveis no 02-reviewed.md final). Substitui a linha "Para esta edição..." no topo do MD. Antes era chutada pelo writer LLM e ficava stale após podas. Stdout: `{ x, y, z, changed, mdPath }`. Falha não-bloqueante (log warn) — números errados são cosméticos, não bloqueiam publicação. Fonte de verdade: `countEditorVsAuto` em `scripts/sync-coverage-line.ts` — não reparafrasear a lógica aqui, conferir o código se divergir (#3807).

- **Render ERRO INTENCIONAL obrigatório (#1073):** após Clarice (e antes do gate humano), rodar:
  ```bash
  npx tsx scripts/render-erro-intencional.ts \
    --edition {AAMMDD} \
    --md {EDITION_DIR}/02-reviewed.md
  ```
  Substitui o placeholder do writer pelo reveal do erro anterior (`Na última edição, …`) + preserva ou insere placeholder pra `Nessa edição, …` (autor preenche manualmente). Também garante que `_internal/intentional-error.json` existe (escreve placeholder `{PREENCHER}` se ausente — #3222, campos estruturados description/location/category/correct_value/reveal, sibling de `02-reviewed.md`, **nunca** sincroniza com o Drive). **Falha = abortar Stage 2** (não silenciar). Justificativa: sem o script, edição vai com `{placeholder, script render-erro-intencional.ts substitui pós-Clarice}` literal no MD; quando colado manualmente no Beehiiv (#1083), aparece como texto bruto no email — contamina UX e mata o concurso "Ache o erro".

  **Coletar os campos do editor (#3222).** Diferente de antes (editor editava o frontmatter YAML direto no Google Doc via Drive), o JSON não passa pelo Drive. **Este é o único ponto do inventário do #5321 que continua perguntando (critério 2 — conteúdo editorial autoral, não dá pra decidir por conta própria o que está "errado")** — mas em vez de abrir a pergunta no vazio, monte uma **proposta completa e pronta pra aceite em 1 clique** aplicando o filtro de segurança do #3808 abaixo (descrição / localização / categoria / valor correto / frase de reveal já preenchidos), e apresente no gate como "aceito esta proposta / quero outra / vou escrever a minha" — nunca como um formulário de 5 campos em branco. Gravar a resposta direto em `{EDITION_DIR}/_internal/intentional-error.json`, substituindo os placeholders `{PREENCHER}`. Isso é o único lugar onde o editor "edita" esse dado agora — nunca via Drive.

  **Filtro de segurança ao PROPOR candidatos (#3808, critérios reforçados #5742).** Se você (o orquestrador) sugerir candidatos de erro em vez de só perguntar em aberto, aplicar por padrão as 3 diretrizes de `context/editorial-rules.md` §10 antes de apresentar ao editor: (1) nunca alterar um fato central de um DESTAQUE (funding, specs, dado de negócio — o que o leitor levaria como "notícia real"); (2) preferir erro cômico/leve (trocadilho, erro ortográfico bobo, nome trocado de forma óbvia como "Craude" em vez de "Claude") em vez de inflação de magnitude sobre um fato real; (3) preferir plantar em menção lateral/secundária do texto, não na frase que carrega a informação principal do destaque (exemplo real de proposta aceita/rejeitada: `docs/orchestrator-stage-narrative-history.md#stage-2-erro-intencional-exemplo`). **Padrão de maior taxa de aceite (#5742):** erro ortográfico bobo em nome de entidade MUITO conhecida do público (empresa/produto/fundador de IA), mencionado dentro do próprio corpo da edição — nunca obra/evento externo que dependa de o leitor saber de cor ou clicar no link (ex: "Anthropik" em vez de "Anthropic", "Hugging Race" em vez de "Hugging Face"). Numérico/data/nome-próprio-externo (contagem só verificável na fonte, ano de evento real, coautor de livro) falha quase sempre a Regra 1 ou a Regra 2 de §10 — evitar por padrão ao propor candidato, mesmo antes do editor rejeitar.

- **Validator final Stage 2 (#1072, #1073):** antes do gate humano, rodar invariant check que detecta passos pulados silenciosamente:
  ```bash
  npx tsx scripts/check-stage2-invariants.ts \
    --edition-dir {EDITION_DIR}/
  ```
  Cobre 5 checks: (a) Humanizador rodou (02-humanized.md ≠ 02-normalized.md), (b) Clarice rodou (02-reviewed.md ≠ 02-pre-clarice.md), (c) render-erro-intencional rodou (sem placeholder literal no MD), (d) `_internal/intentional-error.json` existe (#2284, migrado #3222) — placeholder OK, valores preenchidos pelo editor via chat (não mais via Drive), (e) `intentional-error.json.reveal` (quando já preenchido) começa com "Na última edição" ou outra palavra-gancho temporal reconhecida pelo renderer (#6139) — sem isso, o box de reveal da EDIÇÃO SEGUINTE não é renderizado, silenciosamente. Exit 1 = abort + mostrar o(s) check(s) que falharam ao editor. Existe pra capturar regressões de retry/skip silencioso — humanizador/Clarice/render-erro/intentional-error.json/reveal-temporal-prefix são todos invariantes do Stage 2.

### 2c. Processar social

Após os social agents retornarem, fazer merge em `03-social.md` via script TS. Substitui o snippet inline anterior (#870) — agora com try/catch, validação de tmp files e error reporting actionable:

```bash
npx tsx scripts/merge-social-md.ts --edition-dir {EDITION_DIR}/
```

O script:
- Verifica que `_internal/03-social.tmp.md` (agent `social-writer`) existe e não está vazio; exit 1 com mensagem clara se estiver ausente
- Faz strip de comentários HTML (`<!-- ... -->`) com fallback safe pra comments mal-formados (#875)
- Grava em `03-social.md` como seção única `# Social` (#3991 — substitui `# LinkedIn`/`# Facebook`/`# Instagram`) — texto genérico por destaque + `## post_pixel`, sem qualquer CTA de canal (injetada só no publish)
- **#3992:** se `_internal/03-curto.tmp.md` existir (o caso normal — `social-curto` roda em todo dispatch), mescla também `# Curto` no output. Tmp OPCIONAL — ausência não falha o merge; sem `# Curto`, tanto `publish-threads.ts` quanto o dispatch do X via Buffer MCP (#3994) fazem skip por destaque — nenhum post é publicado nesse canal, sem fallback pra `# Social`/`# Facebook` (#4294). Independente do #3991 — não muda.
- Deleta os tmp files após sucesso
- Edições publicadas ANTES deste merge (formato legado, 3 headers de plataforma) não são re-geradas — lints/publishers mantêm fallback pro formato antigo (ver `scripts/lib/social-lint-rules.ts`), mas o merge só sabe produzir `# Social` daqui em diante.

Falha = abortar e reportar ao editor com sugestão de re-rodar isolado.

**Lint header de plataforma único (#3388) — logo após o merge.** `merge-social-md.ts` prepende seu próprio header `# Social` na hora do merge; se o tmp file do agent `social-writer` já contiver um `# Social` embutido no próprio texto (mesma classe de bug do `docs/orchestrator-stage-narrative-history.md#stage-2-double-header-incident`), o resultado tem 2 ocorrências — o parser para no 2º header como se fosse o fim da seção, e os publishers reportam "Destaque não encontrado" no Stage 5, quebrando o dispatch inteiro. Rodar imediatamente após o merge, antes do humanizador:
```bash
npx tsx scripts/lint-social-md.ts --check platform-headers-unicos --md {EDITION_DIR}/03-social.md
```
Exit 1 = `# Social` (ou, em edição legado, `# LinkedIn`/`# Facebook`) aparece mais de 1 vez. **Abortar Stage 2** (não silenciar, não prosseguir pro humanizador) e reportar ao editor a mensagem do lint (linhas exatas dos headers duplicados) — a correção correta é remover o header duplicado de `03-social.md` e, se a causa for o agent `social-writer` emitindo `# Social` no próprio tmp file, ajustar o prompt do agent pra não incluir esse header (só `merge-social-md.ts` deve escrevê-lo).

**Humanizar social (#308, #1072, refined #1546):** invocar skill `humanizador` in-place no `03-social.md` com prompt completo (mesma profundidade da newsletter — prompt fraco causava remoção de só 25% dos travessões):
```
Skill("humanizador", "Leia {EDITION_DIR}/03-social.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions.md como referência. Rode os 9 passos completos. Meta quantitativa do padrão #20: zero travessões no output (exceção: diálogo e meia-risca numérica). Salve no mesmo arquivo.")
```
**Retry 3x + abort se persistir (#1072).** Se skill retornar erro OU `03-social.md` post-humanizador for byte-idêntico ao pré (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** — não publicar social com tom corporativo de agent output. Antes da invocação, fazer snapshot: `cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/03-social-pre-humanizador.md` pra diff post-skill.

**Verificar cobertura por-seção do humanizador (#2148):** após cada invocação do humanizador social, checar se TODAS as seções relevantes foram tocadas — não apenas o arquivo como um todo:
```bash
npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
  --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md \
  --md {EDITION_DIR}/03-social.md
```
Seções verificadas: `main_d1/d2/d3` (posts principais) e `post_pixel`. **#3627:** `comment_pixel_d1/d2/d3` deixaram de ser gerados (subseção aposentada) — a função (`checkHumanizerSectionCoverage`) já trata seção ausente em pré/pós como no-op, sem mudança de código necessária. Seção idêntica antes/depois = humanizador não tocou. **Exit 1 com lista de seções não-cobertas → re-invocar humanizador mirando explicitamente essas seções no prompt** (ex: "humanize a seção post_pixel que ficou com tom corporativo"). Contabiliza como tentativa adicional no retry 3x — se após o retry dirigido a cobertura ainda for parcial e o no-op total persistir, abortar. Fundamento: o guard whole-file (byte-idêntico pré vs pós) detecta "humanizador não rodou nada", mas NÃO detecta "humanizador rodou nos destaques mas pulou post_pixel" — esse furo deixava esse post com tom LLM passando silenciosamente pelo gate (#2148).

**Retry 3x + fallback inline se `clarice-plugin:humanizador` Unknown skill (#2285):** se a invocação da skill retornar `Unknown skill: clarice-plugin:humanizador` (o marketplace pode ter re-sincronizado durante a sessão), **retry imediato até 3 vezes** antes de desistir. Entre tentativas, aguardar ~5s para o registro recarregar. Se após 3 retries a skill ainda não resolver, **não abortar silenciosamente** — aplicar o rubric inline via prompt direto (referência obrigatória: `context/publishers/humanizador-rubric.md` — leia o arquivo antes de formular o prompt para o LLM; contém as etapas 0-3 + regras de preservação). Logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "humanizador-skill-fallback-inline: clarice-plugin:humanizador Unknown skill após 3 retries — aplicando rubric inline"`. Somente após humanização concluída (skill OU inline), prosseguir para Clarice e sentinel.

**Snapshot pós-humanizador / pré-Clarice (#3929).** Antes de aplicar Clarice, copiar o `03-social.md` (já humanizado) para `_internal/03-social-post-humanizador.md`:
```bash
cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/03-social-post-humanizador.md
```
Esse snapshot vira o baseline do check `humanizer-section-coverage` no pre-gate (`check-invariants.ts --stage 2`, §2d) — decorrelaciona a detecção de "humanizador pulou uma seção" das mudanças que a Clarice fizer a seguir. **Motivação (#3929):** a Clarice tem precedência sobre o Humanizador (correção > estilo) — sem este snapshot, uma reversão legítima da Clarice (ela corrige o texto de volta pra perto do pré-humanizador porque o Humanizador introduziu um erro) faria a seção parecer "idêntica ao pré-humanizador" no check, sendo lida como "humanizador não cobriu a seção" e disparando re-humanização/bloqueio indevido do gate — blindando efetivamente o Humanizador contra a correção da Clarice.

**Revisar social com Clarice (inline, ordem #1072: Humanizador → Clarice):** ler `03-social.md` (já humanizado), chamar `mcp__clarice__correct_text`, aplicar **todas** as sugestões incondicionalmente (#4514 — mesma regra do reviewed: sem cherry-pick, sem menu de escolha ao editor; única exceção é sugestão que corrompa identificador técnico ou nome de marca, aplicar o resto e sinalizar só essa), sobrescrever. **Após sobrescrever**, verificar que a seção `# Social` (#3991) e os headers `## d1`, `## d2`, `## d3` ainda existem. Se algum cabeçalho estiver ausente, restaurar com `Edit` antes de prosseguir. Se Clarice falhar (retornar erro OU output byte-idêntico ao input), **retry 3x + abort** — mesma regra do reviewed.

**Diff legível da revisão Clarice social (#3929).** Gerar diff comparando o snapshot pós-humanizador/pré-Clarice contra o `03-social.md` final, passando `03-social-pre-humanizador.md` (pré-Humanizador) como 4º argumento — sinaliza explicitamente `⚠️ REVERTE HUMANIZADOR` em cada alteração da Clarice que desfaz uma edição do Humanizador, pra o editor decidir com contexto no gate:
```bash
npx tsx scripts/clarice-diff.ts \
  {EDITION_DIR}/_internal/03-social-post-humanizador.md \
  {EDITION_DIR}/03-social.md \
  {EDITION_DIR}/_internal/03-social-clarice-diff.md \
  {EDITION_DIR}/_internal/03-social-pre-humanizador.md
```

**Gravar sentinel de humanizador social (#2279):** após humanizar+Clarice (ambos concluídos), gravar o hash do `03-social.md` final:
```bash
npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/
```
Isso grava `_internal/.humanizer-social-done.json` com o sha256 do arquivo atual. O Stage 4 valida esse hash antes do gate — se o social for editado ou reordenado depois, o hash diverge e o gate bloqueia para re-humanizar.

**Não é mais só um passo em prosa (#6305).** Caso real (edição 260827): o humanizador rodou de fato (snapshot `03-social-pre-humanizador.md` presente, diff confirmando reescrita), mas esta chamada `--write` nunca aconteceu numa sessão via `run-edition-stages.ts` — e o `humanizer-ran` (guard mecânico de #6009 que já bloqueava o `write` do sentinel de Stage 2) não capturava isso, porque ele só prova que a skill `humanizador` rodou (via snapshot), não que este passo seguinte rodou. O Stage 4 só descobriu no `check-humanizer-social.ts --check`, exit 1, tarde demais pra ser barato de corrigir. A regra `social-humanizer-sentinel-written` (`scripts/lib/invariant-checks/stage-2.ts`) fecha essa lacuna: `pipeline-sentinel.ts write --step 2` (mesmo gate do `humanizer-ran`) agora também recusa gravar o sentinel do Stage 2 se `_internal/.humanizer-social-done.json` estiver ausente ou com hash divergente do `03-social.md` atual — pular esta chamada não passa mais silenciosamente.

Exit code handling:
- `0` → sentinel gravado com sucesso.
- `1` → falha ao gravar (permissão, disco) — logar warn e **CONTINUAR Stage 2**. Stage 4 vai bloquear com exit 1 até o sentinel ser gravado manualmente.

**Lint anti-alucinação de cifras pré-gate (#1711):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-numbers.ts --social {EDITION_DIR}/03-social.md --approved {EDITION_DIR}/_internal/01-approved-capped.json
```
Flaga cifras de DINHEIRO COM MAGNITUDE (US$/R$/€ + número + bi/mi/bilhões/...) presentes no post de cada destaque mas AUSENTES da fonte DAQUELE destaque (title+summary de `highlights[N-1]`) — comparação **per-destaque** (não pool inteiro), que pega número certo no contexto errado (exemplo real: `docs/orchestrator-stage-narrative-history.md#stage-2-cifra-errada-exemplo`). WARN-only (exit 0) para cifras alucinadas e contagem errada. `{outros_count}` no `post_pixel` é placeholder legado (#2319, #3052 revertido em 260814 — o writer normalmente não o emite mais, mas o lint segue tolerante caso apareça) — não bloqueia por isso. **Incluir as cifras flagadas no prompt do gate** ("⚠️ cifra X não encontrada na fonte — confira") pro editor verificar contra a fonte original antes de aprovar. Cifras: heurística conservadora (pode ter falso-positivo se a fonte usa formato muito diferente).

**Lints consolidados pré-gate (#5416):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-md.ts --stage 2 --json --edition-dir {EDITION_DIR}
```
Substitui as 5 invocações separadas que existiam aqui antes (`relative-time`, `linkedin-schema`, `no-email-cta-instagram`, `no-trailing-question`, `personal-post-no-newsletter-deixis`, 1 processo Node cada) por uma única chamada agregadora — mesmas funções, mesmo veredito por check. **Não inclui** `platform-headers-unicos` (roda logo após o merge, §2c acima, ANTES do humanizador) nem `humanizer-section-coverage` (precisa de `--pre`, um snapshot por invocação do humanizador — segue como chamada isolada onde já roda hoje). Output (stdout): JSON `{ stage: 2, passed: boolean, checks: [{ id, source_issue, severity, ok, result }, ...] }`. `passed` reflete "nenhum check gate-blocking falhou" — `relative-time`, `no-trailing-question` e `personal-post-no-newsletter-deixis` são **warn-only** (nunca bloqueiam `passed`); `linkedin-schema` e `no-email-cta-instagram` são **gate-blocking**. Debug de 1 check isolado (`--check X --md {EDITION_DIR}/03-social.md`) continua funcionando exatamente como antes (modo aditivo, não removido).

`relative-time` (#877): detecta "hoje", "ontem", "amanhã", "esta semana", "próxima semana", "este mês", "recentemente", "há N dias/semanas/meses" — palavras que envelhecem entre escrever e publicar (posts vão pra fila com D+1+ delay). Matches dentro de aspas (citação direta) são pulados. **WARN-ONLY** — **incluir os matches no `{violations_block}`** mostrando linha + palavra + contexto, mas não bloquear automaticamente — editor decide se reescreve ou aceita (caso de borda raro: nome próprio com palavra-chave).

`linkedin-schema` (#595, #3627, #3991): `social-writer` gera 1 texto genérico por destaque (subseções `comment_diaria`/`comment_pixel` foram aposentadas, decisão do editor 260716 — postagem manual de comentários auxiliares não compensava) + `## post_pixel` — o check adapta automaticamente o range de caracteres esperado conforme o formato (600-900 no `# Social` novo, 1200-1500 no `# LinkedIn` legado). Falha = texto genérico ausente (missing_main) ou char count fora do range. **#3052 revertido (260814):** `## post_pixel` não é mais obrigado a abrir com `{outros_count}`/`{edition_url}` — checks post_pixel_missing_outros_count/post_pixel_missing_edition_url removidos. **GATE-BLOCKING** — ação: re-disparar `social-writer` agent.

`no-email-cta-instagram` (#2486, alvo mudou no #3991): o texto genérico `## d1/d2/d3` não pode conter CTA de e-mail, "link na bio", "segue @...", nem qualquer menção a `diar.ia.br` — essas linhas são injetadas SÓ no publish (`scripts/lib/social-cta-lines.ts`). **GATE-BLOCKING** — ação: re-disparar `social-writer` agent com a violação explicitada no prompt.

`no-trailing-question` (#1762): posts social não devem fechar com pergunta (CTA-pergunta). Flaga quando a última frase do post principal (corpo de `## d{N}`) termina em "?". Perguntas retóricas no meio e perguntas entre aspas são ignoradas. **WARN-ONLY** — **incluir os matches no `{violations_block}`** (platform + destaque + frase) — editor decide reescrever o fim como afirmação ou aceitar. Fix preferido: re-disparar o agent social correspondente pra fechar com afirmação.

`personal-post-no-newsletter-deixis` (#2148): `## post_pixel` é postado na conta PESSOAL do autor — sem contexto de marca. "Esta/essa/nossa newsletter" pressupõe que o leitor está dentro da diar.ia.br; inválido num post standalone. Flaga ocorrências de "esta newsletter", "essa newsletter", "nossa newsletter" (e variantes com "boletim", "edição") em `## post_pixel`. **WARN-ONLY** — **incluir ocorrências no `{violations_block}`** com sugestão de substituição. Fix: reescrever como fato biográfico ("a newsletter de IA que escrevo") em vez de contexto compartilhado. Não bloqueia automaticamente — editor decide se reescreve ou aceita (casos de borda: citação direta de entrevistado).

### 2d. Gate unificado

- **Pre-gate invariants (#1007 Fase 1).** Antes do gate, rodar lints como invariantes (defense-in-depth — lints individuais já rodaram, mas registry centraliza):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 2 --edition-dir {EDITION_DIR}/
  ```
  Exit 1 = re-disparar writer ou bloquear gate até fix manual. Violations são logadas com `source_issue` pra rastreabilidade.

- **Medir tamanho dos destaques (#739).** Antes de apresentar o gate, rodar:
  ```bash
  npx tsx scripts/measure-highlights.ts {EDITION_DIR}/02-reviewed.md
  ```
  Stderr exibe `d1: N chars (M palavras)` por destaque + total + warnings quando algum destaque está fora da faixa saudável (600-1500 chars). Incluir o output stderr no prompt do gate pra editor avaliar balanceamento (d1 muito longo vs d3 raso = desbalanceio editorial; >1500 = newsletter densa, CTR cai). Não bloquear — informativo only.

- **GATE HUMANO unificado (newsletter + social):** mostrar `_internal/02-clarice-diff.md`, `_internal/03-social-clarice-diff.md` (#3929 — se existir e tiver `Reversões do Humanizador` > 0, destacar essas entries explicitamente no resumo, pois são alterações da Clarice que desfizeram uma edição do Humanizador) e o conteúdo de `03-social.md`. Instruir:
  ```
  ✏️  Etapa 2 — Escrita pronta.

  Newsletter — edite {EDITION_DIR}/02-reviewed.md:
      — Mantenha exatamente 1 título por destaque (delete os outros 2).
        URL fica na linha imediatamente abaixo do título escolhido (#172).

  Social — revise {EDITION_DIR}/03-social.md:
      — 1 texto por destaque (d1/d2/d3), compartilhado por LinkedIn/Facebook/Instagram (#3991)
      — + 1 post pessoal standalone (post_pixel, D1, publicação manual)
  ```
  Quando o editor responder "sim", os arquivos locais são os textos finais.

  - **Auto-pick de título via Sonnet (#159, #2772).** Após aprovação, **fazer snapshot do 02-reviewed.md** pra `_internal/02-pre-title-picker.md` (necessário pra validar estrutura post-#1205), depois dispatch `title-picker` (Sonnet, Agent) passando:
    - `md_path = {EDITION_DIR}/02-reviewed.md`
    - `out_path = {EDITION_DIR}/02-reviewed.md` (in-place)
    - `audience_path = context/audience-profile.md`
    - `editorial_rules_path = context/editorial-rules.md`
    - `picks_log_path = {EDITION_DIR}/_internal/02-title-picks.json`

    ```bash
    cp {EDITION_DIR}/02-reviewed.md {EDITION_DIR}/_internal/02-pre-title-picker.md
    ```

    Title-picker detecta destaques que ainda têm >1 título (editor não podou) e escolhe 1 baseado em concretude + tom + variedade lexical. Se `destaques_picked > 0`, logar info: `"title-picker: auto-podou N destaque(s) — log em _internal/02-title-picks.json"`. Se `destaques_picked === 0`, editor já podou tudo manualmente — title-picker é no-op.

    Erro do agent (ex: destaque sem título nenhum) deve ser reportado ao editor antes de prosseguir pra Etapa 3 — não há fallback automático pra título inexistente.

  - **Validar estrutura preservada (#1205).** Após title-picker, comparar estrutura de seções pré/pós:
    ```bash
    npx tsx scripts/validate-section-structure.ts \
      --before {EDITION_DIR}/_internal/02-pre-title-picker.md \
      --after {EDITION_DIR}/02-reviewed.md
    ```
    Exit 1 = title-picker mexeu na estrutura (removeu `---`, moveu ERRO INTENCIONAL, etc — histórico: `docs/orchestrator-stage-narrative-history.md#stage-2-title-picker-corruption`). **Restaurar do snapshot** e reportar ao editor: `"⚠️ title-picker corrompeu estrutura — restaurando 02-reviewed.md do snapshot. Pode podar 1 título por destaque manualmente."`. Não re-disparar — agent vai cometer o mesmo erro.

  - **Validar schema de intentional-error.json (#2553, repurposed #3222).** Após title-picker (e após restauração de snapshot, se houver), validar que `_internal/intentional-error.json` está bem-formado com as 5 chaves esperadas:
    ```bash
    npx tsx scripts/validate-frontmatter-yaml.ts \
      --md {EDITION_DIR}/02-reviewed.md
    ```
    (deriva `_internal/intentional-error.json` como sibling de `--md`.) title-picker só toca `02-reviewed.md` — nunca `_internal/*` — então a classe de corrupção original deste check (histórico: `docs/orchestrator-stage-narrative-history.md#stage-2-title-picker-corruption`) não pode mais acontecer (#3222): o JSON nunca sincroniza com o Drive. Este script agora serve como guard de schema (JSON malformado por edição manual, campos faltando/placeholder `{PREENCHER}`).

    Exit 1 = campos faltando ou placeholder não preenchido em `_internal/intentional-error.json` — peça ao editor os campos faltantes (via chat) e grave diretamente no arquivo. (Note: `validate-section-structure.ts` compara contagem de seções do MD, não valida o JSON — essa check é complementar, não redundante.)

  - **Validar 1 título por destaque (#178).** Após o title-picker:
    ```bash
    npx tsx scripts/lint-newsletter-md.ts \
      --check titles-per-highlight \
      --md {EDITION_DIR}/02-reviewed.md
    ```
    Exit 1 = algum destaque ainda tem ≠1 título. **Não prosseguir** — re-apresentar o gate com o erro destacado:
    > ⚠️ DESTAQUE N tem K títulos — delete os K-1 excedentes em `{EDITION_DIR}/02-reviewed.md` antes de aprovar de novo.

    Se exit 0, prosseguir pra Etapa 3 normalmente. (Em caso normal, title-picker já podou tudo e este check passa silenciosamente.)

  - **Inserir TÍTULO/SUBTÍTULO no topo (#916).** Roda depois que cada destaque tem 1 só título (pós title-picker / poda manual). Stage 4 (Beehiiv) usa esse bloco como subject + preview text — sem isso, editor preenche manualmente todo dia. Idempotente.

    ```bash
    npx tsx scripts/insert-titulo-subtitulo.ts \
      --in {EDITION_DIR}/02-reviewed.md
    ```
    Falha = warning, **não bloqueia** (gate já aprovou).

  - **Re-gravar sentinel de humanizador social pós-gate (#6316).** Rodar de novo, **depois** da aprovação do gate acima e **antes** do `pipeline-sentinel.ts write` abaixo:
    ```bash
    npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/
    ```
    **Por que este passo existe aqui (não é redundante com a chamada de §2c):** o gate de §2d convida o editor a editar `03-social.md` diretamente — mudança legítima e esperada. A chamada `--write` de §2c grava o hash sobre o texto de ANTES do gate; se o editor mexer no arquivo durante o gate (mesmo 1 palavra), o hash fica stale e a regra `social-humanizer-sentinel-written` (`scripts/lib/invariant-checks/stage-2.ts`, #6305) bloqueia o `pipeline-sentinel.ts write` logo abaixo com `hash_mismatch` — não porque algo quebrou, mas porque ninguém re-registrou o texto que o editor de fato aprovou. Re-rodar aqui fecha esse gap: o hash final bate com o texto pós-gate, e `hash_mismatch` volta a significar só o caso real (alguém editou `03-social.md` por fora deste playbook, sem re-humanizar/re-registrar). **Não remover como "já rodou em §2c"** — é exatamente essa suposição que reintroduz o falso-positivo.
    Exit code handling: mesmo padrão da chamada de §2c — `0` = sentinel regravado; `1` = falha ao gravar (permissão, disco) — logar warn e **CONTINUAR Stage 2** (Stage 4/gate de write abaixo vai bloquear até o sentinel ser gravado manualmente).

  - **Escrever sentinel de conclusão do Stage 2:**
    ```bash
    npx tsx scripts/pipeline-sentinel.ts write \
      --edition {AAMMDD} --step 2 \
      --outputs "02-reviewed.md,03-social.md"
    ```
    **#6009: `write` agora recusa gravar (exit 1) se `check-invariants --stage 2` reportar violação de severity=error** (ex: `humanizer-ran` — humanizador pulado) — gate mecânico, não depende mais só do passo em prosa do §2d acima. Nesse caso **não é falha de infra** — significa que o conteúdo ainda não está pronto: leia as violações listadas no stderr, corrija (ex: re-rode o humanizador na seção indicada) e rode `write` de novo. **Não silenciar com warn** e seguir pra Etapa 3 nesse caso. Só logar warn e continuar quando a falha for genuinamente de infra (permissão, disco cheio — mensagem sem menção a `check-invariants`): `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'sentinel_write_failed'`.

  - **Snapshot pós-Stage 2 para derivação de pedidos editoriais (#5731).** Após o gate unificado, criar snapshots dos arquivos finais para permitir derivação determinística posterior de mudanças editoriais:
    ```bash
    npx tsx scripts/derive-editor-requests.ts snapshot-stage2 --edition {AAMMDD}
    ```
    Exit code handling: `0` = snapshots criados; `!=0` = logar warn, não bloquear.

  - **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 2 done via `update-stage-status.ts --stage 2 --status done --end ISO --duration-ms X`. Em seguida `npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 2` (#3441) — popula `cost_usd`/`tokens_in`/`tokens_out`/`models` reais a partir do transcript local da sessão; sem transcript local, sai sem escrever (fail-soft). Ler o JSON de stdout: se `"source":"unavailable"`, logar warn (mesmo padrão do sentinel acima — #5475): `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'stage_usage_capture_unavailable' --details '{"reason":"<reason do stdout>"}'`. Não bloquear.
    `title_picker:?1` = só conta se foi disparado (destaques_picked > 0); senão 0.
