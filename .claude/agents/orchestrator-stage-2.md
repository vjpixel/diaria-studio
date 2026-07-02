---
name: orchestrator-stage-2
description: Detalhe da Etapa 2 (escrita — newsletter + social em paralelo) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 2 — Escrita

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 2`, banner `--stage "2 — Escrita"`.

Newsletter e social rodam **em paralelo** a partir de `_internal/01-approved.json` — nenhum depende do outro. O gate ao final é unificado.

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
      --approved data/editions/{AAMMDD}/_internal/01-approved.json \
      --write-removed data/editions/{AAMMDD}/_internal/02-lancamentos-removed.json
    ```
    Exit 1 (URLs removidas) é esperado quando o approved tem URL não-oficial — não bloquear, só informativo.
- Radar: `max(5, 12 − destaques − lançamentos_final)` (#1629 — substitui caps separados de Pesquisas + Outras Notícias).
  - `lançamentos_final` deve ser contado **após** o passo de validação acima (lançamentos inválidos já removidos).
  - Se validação de lançamentos removeu N itens, os N slots liberados são preenchidos a partir do pool de `radar` (top por score, respeitando o cap resultante).
- **Aplicar caps via script TS (#907)** — não confiar no writer LLM pra respeitar:
  ```bash
  npx tsx scripts/apply-stage2-caps.ts \
    --in data/editions/{AAMMDD}/_internal/01-approved.json \
    --out data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Writer recebe `01-approved-capped.json`. Lint pós-writer (`--check section-counts`) valida que o output respeitou os caps; falha = re-disparar writer.

- **Limpar/truncar summaries em inglês (#1490 / #1572).** Antes de stitch, rodar:
  ```bash
  npx tsx scripts/translate-summaries.ts \
    --in data/editions/{AAMMDD}/_internal/01-approved-capped.json \
    --out data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  O script é idempotente (marca `summary_translated: true` após processar). Strip de prefixo arXiv + 1ª frase + truncate em 150 chars; **não faz tradução LLM** — apenas cleanup determinístico pra evitar prefix bruto `[TRADUZIR]` no MD final. Items com `summary_lang: "en"` (categorize.ts #1473) e/ou arXiv abstract são afetados. Stitch adiciona `[TRADUZIR]` na **DESCRIÇÃO** (2ª linha) quando o summary está em EN — **nunca no título** (#1697/#1634: título de seção secundária preserva o nome original do recurso, nunca traduzido). O prefixo da descrição é removido pelo **humanizer** (ETAPA 0, que roda no draft stitched inteiro — seções secundárias incluídas) ou pelo editor no gate. (Obs: `writer-destaque` NÃO toca seções secundárias — só escreve D1/D2/D3.) Sem este step, prefixo `[TRADUZIR]` + summary em inglês cru vazaram pro newsletter HTML em 260529 (LANÇAMENTOS + PESQUISAS sections).

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
   - `peer_titles` (titles dos outros 2 — preserva voice diversity)
   - `edition_date`
   - `out_path = data/editions/{AAMMDD}/_internal/02-d{N}-draft.md`
   - `image_prompt_out_path = data/editions/{AAMMDD}/_internal/02-d{N}-prompt.md`

2. `Agent` → `social-linkedin` passando:
   - `approved_json_path = data/editions/{AAMMDD}/_internal/01-approved-capped.json`
   - `out_dir = data/editions/{AAMMDD}/`
   - `outros_count`: **não injetar (#2319)** — `social-linkedin` mantëm `{outros_count}` como placeholder literal (igual a `{edition_url}`). Stage 5 (`publish-linkedin`) resolve do `01-approved-capped.json` FINAL antes de enfileirar. Não calcular nem passar no prompt.

3. `Agent` → `social-facebook` (mesmo input que social-linkedin, exceto `outros_count` que não se aplica ao Facebook).

**Aguardar os N writer-destaques + 2 social retornarem.** Cada `writer-destaque` retorna JSON `{ out_path, image_prompt_path, destaque_n, char_count, warnings }`. **Se `warnings[]` de qualquer um não estiver vazio, pare e reporte ao usuário antes de prosseguir** — mesma regra do writer único legacy.

**Pós:** rodar `scripts/stitch-newsletter.ts` (#1463) que produz `02-draft.md` determinístico unificando os 3 destaque drafts + seções secundárias + blocos fixos:

```bash
npx tsx scripts/stitch-newsletter.ts --edition-dir data/editions/{AAMMDD}/
```

**#1938/#2527:** o stitch auto-injeta o midCallout de divulgação entre D1 e D2 em **todo daily** (decisão editorial). **Default desde #2527: bloco 📚 de curadoria de livros** (`context/snippets/livros-divulgacao.md`, via `loadDailyCallout`); o bloco 📣 Clarice (`context/snippets/clarice-divulgacao.md`, via `loadClariceCallout`) segue disponível para reuso (mensal / troca pontual). Idempotente (pula se D1/D2 já trazem um callout `**📣/📚/🎉 …**`). Kill-switch pontual: `--no-sponsor` (suprime o callout, seja livros ou Clarice).

O script é determinístico, sem LLM. Ordem canonical:
- Coverage line (do `01-approved-capped.json > coverage.line`)
- DESTAQUE 1 block (lê `_internal/02-d1-draft.md`)
- DESTAQUE 2 block (lê `_internal/02-d2-draft.md`)
- É IA? section (lê `01-eia.md` se existir, strip frontmatter YAML)
- DESTAQUE 3 block (lê `_internal/02-d3-draft.md`) — **omitido em edições de 2 destaques (#2343)**
- **LANÇAMENTOS** (formato canonical `**[title](url)**` + summary, singular/plural conforme count #1324)
- **PESQUISAS**, **OUTRAS NOTÍCIAS**, **VÍDEOS** (idem; omite seção vazia)
- **ERRO INTENCIONAL** placeholder (`render-erro-intencional.ts` re-insere ao final pós-Clarice — auto-converge)
- **🎁 SORTEIO** + **🙋🏼‍♀️ PARA ENCERRAR** (texto fixo)

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
   - `out_path = data/editions/{AAMMDD}/_internal/02-draft.md`
   - `d1_prompt_path = data/editions/{AAMMDD}/_internal/02-d1-prompt.md`
   - `d2_prompt_path = data/editions/{AAMMDD}/_internal/02-d2-prompt.md`
   - `d3_prompt_path = data/editions/{AAMMDD}/_internal/02-d3-prompt.md`

2. `Agent` → `social-linkedin` (mesmo input do writer; `{outros_count}` é placeholder literal no output — não injetar #2319).
3. `Agent` → `social-facebook` (mesmo input do writer).

Aguardar os 3 retornarem. Writer retorna JSON `{ out_path, d1_prompt_path, d2_prompt_path, d3_prompt_path, checklist, warnings }`. Se `warnings[]` não estiver vazio, **pare** e reporte ao usuário antes de prosseguir.

**Validar outputs dos 3 agents antes de qualquer processamento (#872):** se um dos 3 falhou silenciosamente (timeout, retorno mal-formado), o merge em 2c crasharia lendo arquivo ausente. Antes de prosseguir, rodar:

```bash
npx tsx scripts/validate-stage-2-outputs.ts --edition-dir data/editions/{AAMMDD}/
```

O script verifica que `_internal/02-draft.md`, `_internal/03-linkedin.tmp.md` e `_internal/03-facebook.tmp.md` existem e não estão vazios. Exit 1 = algum agent falhou — relatar ao editor com sugestão de re-rodar isolado (`/diaria-2-escrita {AAMMDD} newsletter` ou `social`). Não prosseguir.

### 2b. Processar newsletter

- **Pull pós-gate** (antes de qualquer edição local pós-aprovação):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md
  ```
  Garante que edições manuais do editor no Drive durante a revisão do gate não sejam sobrescritas pelo processamento local. Se o pull falhar, usar versão local e logar warn.

- **Lint seções vs buckets (#165).** Antes de qualquer processamento, validar que cada URL nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS bate com o bucket correspondente em `_internal/01-approved-capped.json`:
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --md data/editions/{AAMMDD}/_internal/02-draft.md \
    --approved data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Exit 1 = URL na seção errada ou URL fantasma (não existe no approved). Se falhar, **re-disparar o writer** com a lista de erros explicitada no prompt. Até 3 tentativas; se persistir após 3, reportar erro e pausar pra fix manual no `02-draft.md`. Caso de borda comum: ferramenta nova com category `noticias` no bucket `radar` que o writer põe em LANÇAMENTOS por associação temática.

- **Lint section-counts (#358, #907, #1629).** Validar que cada seção secundária respeita o cap (lançamentos≤5, radar=`max(5, 12-d-l)`). O writer pode ignorar caps mesmo recebendo `01-approved-capped.json` se ele decidir incluir runners-up por achar relevante:
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --check section-counts \
    --md data/editions/{AAMMDD}/_internal/02-draft.md \
    --approved data/editions/{AAMMDD}/_internal/01-approved-capped.json
  ```
  Exit 1 = re-disparar writer com a violação no prompt.

- **Lint destaque-min-chars (#914) + destaque-max-chars (#964).** Validar mínimo e máximo de cada destaque (D1: 1000–1200, D2/D3: 900–1000):
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --check destaque-min-chars \
    --md data/editions/{AAMMDD}/_internal/02-draft.md
  npx tsx scripts/lint-newsletter-md.ts \
    --check destaque-max-chars \
    --md data/editions/{AAMMDD}/_internal/02-draft.md
  ```
  Exit 1 do min = destaque anêmico — re-disparar writer com instruction explícita:
  > "Destaque D{N} tem {chars} chars (mínimo {min}). Expanda: (a) adicione 1 frase em 'Por que isso importa' contextualizando impacto pro leitor BR — ex: timing eleitoral, custo de infra, mudança de processo; OU (b) adicione mais 1 parágrafo curto de body com detalhe técnico/empresarial. NÃO repetir conteúdo já presente." (#1208 — anti-pattern observado em 260517: D2/D3 saiam ~860 chars com why em 1 frase só).
  Exit 1 do max = destaque inflado — re-disparar writer com instruction de trimar parágrafo menos relevante OU encurtar 'Por que isso importa'.

- **Normalizar layout (inline — sem Agent, #157):**
  ```bash
  npx tsx scripts/normalize-newsletter.ts \
    --in data/editions/{AAMMDD}/_internal/02-draft.md \
    --out data/editions/{AAMMDD}/_internal/02-normalized.md \
    2> data/editions/{AAMMDD}/_internal/02-normalize-report.json
  ```
  Heurístico conservador — só quebra quando o pattern é inequívoco (ex: 3 títulos do destaque colados no header, ou título+URL+descrição colados num item de seção). Se nenhum bug detectado, `02-normalized.md` é cópia idêntica do draft. Falha do script → log warn + fallback usa `02-draft.md`.

- **Singularizar + adicionar emoji nos headers de seção (#1324, #1328):** writer escreve sempre plural (`**LANÇAMENTOS**`); script normaliza pra singular quando N=1 + adiciona emoji prefix (`**🚀 LANÇAMENTO**`):
  ```bash
  npx tsx scripts/singularize-md-sections.ts \
    --md data/editions/{AAMMDD}/_internal/02-normalized.md
  ```
  Idempotente. Stdout: JSON `{changed, sections}`. Falha não-bloqueante (log warn) — render-newsletter-html.ts em Stage 4 também aplica a normalização, então pior caso o gate MD mostra plural mas o HTML final fica correto.

- **Humanizar (#308, #1072):** invocar skill `humanizador` no arquivo `02-normalized.md` — remove tics LLM (gerúndio em cascata, vocabulário inflado, aberturas cenográficas, etc.), calibrando a voz com `data/past-editions.md` como referência:
  ```
  Skill("humanizador", "Leia data/editions/{AAMMDD}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions.md como referência, e salve o resultado em data/editions/{AAMMDD}/_internal/02-humanized.md.")
  ```
  **Retry 3x + abort se persistir (#1072).** Se a skill retornar erro OU se `02-humanized.md` for byte-idêntico a `02-normalized.md` (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** com erro claro pro editor — não usar fallback "normalized direto pra Clarice" silenciosamente. Justificativa: humanizador remove marcas IA que Clarice **não** pega; sem ele a edição sai com prosa polida-vazia (issue #1072). Logar cada tentativa: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'humanizador attempt N/3 failed'`. Após 3ª falha: `--level error --message 'humanizador esgotou retries — abortar Stage 2'` + exit do pipeline.

- **Revisar com Clarice (inline — sem Agent):**
  Determinar e **persistir** `CLARICE_INPUT` em arquivo (#871) — evita drift entre o passo de leitura e o passo de diff:
  ```bash
  npx tsx scripts/resolve-clarice-input.ts --edition-dir data/editions/{AAMMDD}/
  ```
  O script aplica a fallback chain `(02-humanized.md → 02-normalized.md → 02-draft.md)`, valida que o arquivo escolhido existe, e grava o nome relativo em `data/editions/{AAMMDD}/_internal/02-clarice-input.txt`. Se nenhum existir, exit 1 (FATAL).

  **Snapshot pré-Clarice (#874).** Antes de aplicar Clarice, copiar o `CLARICE_INPUT` resolvido para `_internal/02-pre-clarice.md`. Esse snapshot é (a) source-of-truth pra resume mid-Clarice (ver SKILL diaria-2-escrita), (b) input pro check de estabilidade de URLs (#873) abaixo, (c) input do `clarice-diff.ts`:
  ```bash
  CLARICE_INPUT=$(cat data/editions/{AAMMDD}/_internal/02-clarice-input.txt)
  cp "data/editions/{AAMMDD}/_internal/$CLARICE_INPUT" data/editions/{AAMMDD}/_internal/02-pre-clarice.md
  ```

  **Assertion obrigatória (review #889 P2).** Antes de chamar `mcp__clarice__correct_text`, verificar que o snapshot foi gravado. Se ausente, abortar e logar erro — sem snapshot não há como detectar URL stability nem fazer resume mid-Clarice:
  ```bash
  test -f data/editions/{AAMMDD}/_internal/02-pre-clarice.md || {
    npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before MCP Clarice call"
    echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar MCP Clarice." >&2
    exit 1
  }
  ```

  1. Ler `_internal/02-clarice-input.txt` pra obter o filename relativo. Ler conteúdo de `data/editions/{AAMMDD}/_internal/{FILENAME}`.
  2. Chamar `mcp__clarice__correct_text` passando o texto. **Chunking automático (#2606):** se o texto tiver > 9.000 chars (threshold `CLARICE_CHUNK_THRESHOLD` de `scripts/lib/clarice-chunk.ts`), **não** passar o texto inteiro — usar `splitIntoChunks(text, 9000)` para dividir em chunks em fronteiras seguras (seção `---` > parágrafo vazio > fim de linha; nunca no meio de frase ou link markdown). Para cada chunk, chamar `mcp__clarice__correct_text` com `chunk.text`. Após coletar as sugestões de cada chunk, usar `mergeChunkSuggestions([{chunk, suggestions},...])` (apply chunk-local + re-concatenação — sem aritmética de offset) para produzir o texto corrigido com a política de ambiguidade: sugestão pulada (+ log warn) se `from` aparece 0× (não encontrado) ou 2+× (ambíguo) no chunk — evita replace global de termos curtos como `"os"→""`. Salvar a resposta crua (array de todas as sugestões de todos os chunks) em `data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json` antes de aplicar (auditoria + resume). **Nota:** o fallback REST (`clarice-correct.ts`) também suporta chunking desde #2626 — para textos > 9k, o script divide em chunks via `correctTextChunked`, faz 1 request REST por chunk e usa `mergeChunkSuggestions` internamente. O texto corrigido pode ser gravado opcionalmente via `--corrected-out` (auditoria).

     **Fallback REST (#1329, retry #2320, chunking #2626).** Se a chamada ao MCP retornar erro de disconnect/unavailable OU se `<system-reminder>` indicar que `mcp__clarice` ficou offline, **não fazer halt** — em vez disso, cair no fallback REST com retry/backoff que escreve no mesmo path. **Sempre passar `--corrected-out`** (#2626): o script já chunka textos > 9k e aplica as sugestões chunk-localmente via `mergeChunkSuggestions`, gravando o texto corrigido nesse arquivo. Esse é o resultado correto para textos multi-chunk — **não** re-aplicar `02-clarice-suggestions.json` ao texto inteiro via `clarice-apply.ts` (uma âncora única dentro de um chunk pode aparecer 2+× no texto inteiro e seria pulada como ambígua, sub-corrigindo silenciosamente):
     ```bash
     npx tsx scripts/clarice-correct.ts \
       --in data/editions/{AAMMDD}/_internal/{FILENAME} \
       --out data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json \
       --corrected-out data/editions/{AAMMDD}/_internal/02-clarice-corrected.md \
       --retry \
       --edition {AAMMDD}
     ```
     `--retry` usa 3 tentativas × 60s timeout com backoff exponencial (0s → 5s → 10s entre tentativas). Teto **por chunk**: ~3min15s; para textos multi-chunk o teto total é ~N × 3min15s (N = nº de chunks). Sem `--retry`, timeout é 30s e há apenas 1 tentativa (comportamento legado). Em sucesso, **consumir `02-clarice-corrected.md` diretamente no passo 3** (já é o texto corrigido — pular `clarice-apply.ts`). **Observabilidade por tentativa (#2798):** com `--edition`, cada tentativa (sucesso/retry/falha fatal) é logada em `data/run-log.jsonl` (`message: "clarice_rest_attempt"`, `details: {attempt, elapsedMs, payloadBytes, outcome, status?}`) — útil pra diagnosticar se o timeout é consistente em chunks grandes (>5k chars) via `/diaria-log {AAMMDD}`.

     Logar warn no run-log antes de invocar o script:
     ```bash
     npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "clarice MCP failed — REST fallback" --details '{"server":"clarice","kind":"mcp_to_rest_fallback"}'
     ```

     Exit 0 = sucesso (segue pro passo 3). Exit 3 = HTTP non-2xx ou timeout em TODAS as tentativas (logar `level: error` + halt banner pra editor decidir retry vs skip). Exit 2 = `CLARICE_API_KEY` ausente (halt). Se `CLARICE_REST = false` (do Stage 0 healthcheck), pular direto pro halt banner — sem chance de fallback bem-sucedido.

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
        echo '[]' > data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json
        ```
     3. Continuar o pipeline normalmente.
  3. Produzir o texto revisado em `data/editions/{AAMMDD}/02-reviewed.md`. **Dois caminhos, conforme a origem das sugestões:**
     - **Caminho MCP (normal):** aplicar as sugestões ao texto. Se houve chunking (#2606), o texto corrigido é o resultado do `mergeChunkSuggestions` (apply chunk-local) — gravar esse texto. Se foi chamada única (≤9k), aplicar as sugestões ao texto integral.
     - **Caminho fallback REST (#2626):** o script já gravou o texto corrigido (chunk-applied) em `02-clarice-corrected.md`. **Copiar esse arquivo diretamente** para `02-reviewed.md` — **não** re-aplicar `02-clarice-suggestions.json` via `clarice-apply.ts` (re-aplicar a lista plana ao texto inteiro sub-corrige textos multi-chunk; ver fallback acima):
       ```bash
       cp data/editions/{AAMMDD}/_internal/02-clarice-corrected.md data/editions/{AAMMDD}/02-reviewed.md
       ```
     Em ambos os casos, gravar o texto corrigido (não a lista de sugestões) em `data/editions/{AAMMDD}/02-reviewed.md`.
  4. Gerar diff legível usando o snapshot pré-Clarice:
     ```bash
     npx tsx scripts/clarice-diff.ts \
       data/editions/{AAMMDD}/_internal/02-pre-clarice.md \
       data/editions/{AAMMDD}/02-reviewed.md \
       data/editions/{AAMMDD}/_internal/02-clarice-diff.md
     ```
  Se a Clarice falhar (MCP + REST), propagar o erro — **não** usar o rascunho sem revisão.

- **Verificar estabilidade de URLs em LANÇAMENTOS (#873).** Clarice pode "limpar" URLs (remover query params, normalizar paths, adicionar trailing slash) — isso quebra a regra "LANÇAMENTOS só com link oficial" (#160) silenciosamente, porque a URL pós-Clarice pode não bater mais com a whitelist. Comparar URLs pré/pós-Clarice **antes** de `validate-lancamentos.ts`:
  ```bash
  npx tsx scripts/verify-clarice-url-stability.ts \
    --pre data/editions/{AAMMDD}/_internal/02-pre-clarice.md \
    --post data/editions/{AAMMDD}/02-reviewed.md
  ```
  Exit 0 = todas URLs em LANÇAMENTOS estáveis (warnings em outras seções são informativos, não bloqueiam). Exit 1 = Clarice mexeu em URL de lançamento — incluir o output no prompt do gate humano com diff `antes/depois` pra editor decidir: aceitar a versão pós-Clarice (pode quebrar #160) ou restaurar manualmente em `02-reviewed.md`. Não auto-restaurar — preserva agência editorial.

- **Verificar sobrevivência dos cupons CLARICE (#1982).** Os cupons `NEWS25`/`NEWS50` + link de afiliado `?via=diaria` aparecem no bloco PARA ENCERRAR (sempre) e no midCallout `**📣 …**` Clarice **apenas quando esse for o callout ativo** (desde #2527 o default diário é o 📚 livros, sem cupons — o check sai exit 0 "sem patrocínio", esperado). Esses literais passam por humanizer + Clarice e não têm guard. Comparar o baseline **pré-LLM** (`02-normalized.md`, pré-humanizer — cobre os 2 passos; #1982 code-review) vs o pós:
  ```bash
  npx tsx scripts/verify-clarice-coupons.ts \
    --pre data/editions/{AAMMDD}/_internal/02-normalized.md \
    --post data/editions/{AAMMDD}/02-reviewed.md
  ```
  Exit 0 = cupons/link preservados (ou ausentes no pré — edição sem patrocínio). Exit 1 = algum literal sumiu/mudou pós-LLM → **surfaçar no gate** (quebra tracking de afiliado / cupom do parceiro); editor restaura o literal exato em `02-reviewed.md`. Não auto-restaurar.

- **Sincronizar contagem da intro (#743, #876):** após a Clarice, o número declarado na intro pode divergir do número real de artigos (ex: lançamentos rejeitados reduziram o total) e a narrativa pode mencionar "X lançamentos" com X antigo. Corrigir automaticamente, passando o resumo de lançamentos removidos escrito em §2a:
  ```bash
  npx tsx scripts/sync-intro-count.ts \
    --md data/editions/{AAMMDD}/02-reviewed.md \
    --lancamentos-removed data/editions/{AAMMDD}/_internal/02-lancamentos-removed.json
  ```
  Se o script retornar `changed: true` ou `lancamentos_changed: true`, logar `warn` no run-log com os valores antes/depois. Não bloquear — correções são cirúrgicas (apenas o número, sem mexer no resto do texto). Quando `02-lancamentos-removed.json` não existe (ex: §2a foi pulado em rerun), o script ignora silenciosamente esse passo.

- **Validar LANÇAMENTOS oficiais (#160):**
  ```bash
  npx tsx scripts/validate-lancamentos.ts data/editions/{AAMMDD}/02-reviewed.md
  ```
  Garante que todo URL na seção LANÇAMENTOS bate com whitelist oficial (`scripts/categorize.ts > LANCAMENTO_DOMAINS`/`PATTERNS`). **#1968 (verificação POSITIVA):** além do domínio oficial, cada item precisa de um sinal de produto (software/hardware) no slug/título — item oficial sem sinal vai pra `not_a_tool` e também faz exit 1 (pega parceria/evento/programa/relatório). Se exit code != 0 (URL não-oficial OU `not_a_tool`), **incluir os erros no prompt do gate humano** mostrando linha + URL + sugestão de mover pra NOTÍCIAS. Não bloquear automaticamente — editor decide. **Se for ferramenta legítima de slug atípico** (ex: hardware NVIDIA Jetson), adicionar a URL a `seed/lancamentos-tool-allowlist.txt` (1 substring por linha) — override permanente da verificação positiva.

- **Sincronizar linha de cobertura (#1097):** após Clarice + validate-lancamentos, antes do render-erro-intencional, rodar:
  ```bash
  npx tsx scripts/sync-coverage-line.ts --edition-dir data/editions/{AAMMDD}/
  ```
  Auto-calcula X (editor_submitted + newsletter_extracted + source:inbox no pool inicial), Y (auto-found = total - X), Z (itens visíveis no 02-reviewed.md final). Substitui a linha "Para esta edição..." no topo do MD. Antes era chutada pelo writer LLM e ficava stale após podas. Stdout: `{ x, y, z, changed, mdPath }`. Falha não-bloqueante (log warn) — números errados são cosméticos, não bloqueiam publicação.

- **Render ERRO INTENCIONAL obrigatório (#1073):** após Clarice (e antes do gate humano), rodar:
  ```bash
  npx tsx scripts/render-erro-intencional.ts \
    --edition {AAMMDD} \
    --md data/editions/{AAMMDD}/02-reviewed.md
  ```
  Substitui o placeholder do writer pelo reveal do erro anterior (`Na última edição, …`) + preserva ou insere placeholder pra `Nessa edição, …` (autor preenche manualmente). **Falha = abortar Stage 2** (não silenciar). Justificativa: sem o script, edição vai com `{placeholder, script render-erro-intencional.ts substitui pós-Clarice}` literal no MD; quando colado manualmente no Beehiiv (#1083), aparece como texto bruto no email — contamina UX e mata o concurso "Ache o erro".

- **Validator final Stage 2 (#1072, #1073):** antes do gate humano, rodar invariant check que detecta passos pulados silenciosamente:
  ```bash
  npx tsx scripts/check-stage2-invariants.ts \
    --edition-dir data/editions/{AAMMDD}/
  ```
  Cobre 4 checks: (a) Humanizador rodou (02-humanized.md ≠ 02-normalized.md), (b) Clarice rodou (02-reviewed.md ≠ 02-pre-clarice.md), (c) render-erro-intencional rodou (sem placeholder literal no MD), (d) frontmatter `intentional_error:` existe em 02-reviewed.md — placeholder OK, valores preenchidos pelo editor no gate do Stage 4 via Drive (#2284). Exit 1 = abort + mostrar o(s) check(s) que falharam ao editor. Existe pra capturar regressões de retry/skip silencioso — humanizador/Clarice/render-erro/frontmatter são todos invariantes do Stage 2.

### 2c. Processar social

Após os social agents retornarem, fazer merge em `03-social.md` via script TS. Substitui o snippet inline anterior (#870) — agora com try/catch, validação de tmp files e error reporting actionable:

```bash
npx tsx scripts/merge-social-md.ts --edition-dir data/editions/{AAMMDD}/
```

O script:
- Verifica que `_internal/03-linkedin.tmp.md` e `_internal/03-facebook.tmp.md` existem e não estão vazios; exit 1 com mensagem clara indicando qual agent falhou se algum estiver ausente
- Faz strip de comentários HTML (`<!-- ... -->`) com fallback safe pra comments mal-formados (#875)
- Concatena em `# LinkedIn` + `# Facebook` e grava em `03-social.md`
- Deleta os tmp files após sucesso

Falha = abortar e reportar ao editor com sugestão de re-rodar isolado.

**Humanizar social (#308, #1072, refined #1546):** invocar skill `humanizador` in-place no `03-social.md` com prompt completo (mesma profundidade da newsletter — prompt fraco causava remoção de só 25% dos travessões):
```
Skill("humanizador", "Leia data/editions/{AAMMDD}/03-social.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions.md como referência. Rode os 9 passos completos. Meta quantitativa do padrão #20: zero travessões no output (exceção: diálogo e meia-risca numérica). Salve no mesmo arquivo.")
```
**Retry 3x + abort se persistir (#1072).** Se skill retornar erro OU `03-social.md` post-humanizador for byte-idêntico ao pré (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** — não publicar social com tom corporativo de agent output. Antes da invocação, fazer snapshot: `cp data/editions/{AAMMDD}/03-social.md data/editions/{AAMMDD}/_internal/03-social-pre-humanizador.md` pra diff post-skill.

**Verificar cobertura por-seção do humanizador (#2148):** após cada invocação do humanizador social, checar se TODAS as seções relevantes foram tocadas — não apenas o arquivo como um todo:
```bash
npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
  --pre data/editions/{AAMMDD}/_internal/03-social-pre-humanizador.md \
  --md data/editions/{AAMMDD}/03-social.md
```
Seções verificadas: `main_d1/d2/d3` (posts principais), `comment_pixel_d1/d2/d3` (comments pessoais) e `post_pixel`. Seção idêntica antes/depois = humanizador não tocou. **Exit 1 com lista de seções não-cobertas → re-invocar humanizador mirando explicitamente essas seções no prompt** (ex: "humanize as seções comment_pixel_d2 e post_pixel que ficaram com tom corporativo"). Contabiliza como tentativa adicional no retry 3x — se após o retry dirigido a cobertura ainda for parcial e o no-op total persistir, abortar. Fundamento: o guard whole-file (byte-idêntico pré vs pós) detecta "humanizador não rodou nada", mas NÃO detecta "humanizador rodou nos destaques mas pulou comments/post_pixel" — esse furo deixava comments com tom LLM passando silenciosamente pelo gate (#2148).

**Retry 3x + fallback inline se `clarice-plugin:humanizador` Unknown skill (#2285):** se a invocação da skill retornar `Unknown skill: clarice-plugin:humanizador` (o marketplace pode ter re-sincronizado durante a sessão — causa-raiz identificada na edição 260615), **retry imediato até 3 vezes** antes de desistir. Entre tentativas, aguardar ~5s para o registro recarregar. Se após 3 retries a skill ainda não resolver, **não abortar silenciosamente** — aplicar o rubric inline via prompt direto (referência obrigatória: `context/publishers/humanizador-rubric.md` — leia o arquivo antes de formular o prompt para o LLM; contém as etapas 0-3 + regras de preservação). Logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "humanizador-skill-fallback-inline: clarice-plugin:humanizador Unknown skill após 3 retries — aplicando rubric inline"`. Somente após humanização concluída (skill OU inline), prosseguir para Clarice e sentinel.

**Revisar social com Clarice (inline, ordem #1072: Humanizador → Clarice):** ler `03-social.md` (já humanizado), chamar `mcp__clarice__correct_text`, aplicar sugestões, sobrescrever. **Após sobrescrever**, verificar que as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda existem. Se algum cabeçalho estiver ausente, restaurar com `Edit` antes de prosseguir. Se Clarice falhar (retornar erro OU output byte-idêntico ao input), **retry 3x + abort** — mesma regra do reviewed.

**Gravar sentinel de humanizador social (#2279):** após humanizar+Clarice (ambos concluídos), gravar o hash do `03-social.md` final:
```bash
npx tsx scripts/check-humanizer-social.ts --write --edition-dir data/editions/{AAMMDD}/
```
Isso grava `_internal/.humanizer-social-done.json` com o sha256 do arquivo atual. O Stage 4 valida esse hash antes do gate — se o social for editado ou reordenado depois, o hash diverge e o gate bloqueia para re-humanizar.

Exit code handling:
- `0` → sentinel gravado com sucesso.
- `1` → falha ao gravar (permissão, disco) — logar warn e **CONTINUAR Stage 2**. Stage 4 vai bloquear com exit 1 até o sentinel ser gravado manualmente.

**Lint timestamps relativos pré-gate (#877):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-md.ts --check relative-time --md data/editions/{AAMMDD}/03-social.md
```
Detecta "hoje", "ontem", "amanhã", "esta semana", "próxima semana", "este mês", "recentemente", "há N dias/semanas/meses" — palavras que envelhecem entre escrever e publicar (posts vão pra fila com D+1+ delay). Matches dentro de aspas (citação direta) são pulados. Exit 1 = matches encontrados. **Incluir os matches no prompt do gate** mostrando linha + palavra + contexto, mas não bloquear automaticamente — editor decide se reescreve ou aceita (caso de borda raro: nome próprio com palavra-chave).

**Lint anti-alucinação de cifras pré-gate (#1711):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-numbers.ts --social data/editions/{AAMMDD}/03-social.md --approved data/editions/{AAMMDD}/_internal/01-approved-capped.json
```
Flaga cifras de DINHEIRO COM MAGNITUDE (US$/R$/€ + número + bi/mi/bilhões/...) presentes no post de cada destaque mas AUSENTES da fonte DAQUELE destaque (title+summary de `highlights[N-1]`) — comparação **per-destaque** (não pool inteiro), que pega número certo no contexto errado (caso 260602: post d1 citou "US$ 965 bilhões em valuation" da Anthropic, ausente da fonte do d1). WARN-only (exit 0) para cifras alucinadas e contagem errada. `{outros_count}` no `comment_diaria` é placeholder intencional deferido para Stage 5 (#2319) — o lint não bloqueia mais por isso. **Incluir as cifras flagadas no prompt do gate** ("⚠️ cifra X não encontrada na fonte — confira") pro editor verificar contra a fonte original antes de aprovar. Cifras: heurística conservadora (pode ter falso-positivo se a fonte usa formato muito diferente).

**Lint LinkedIn schema 3-textos pré-gate (#595):** social-linkedin agora gera main + comment_diaria + comment_pixel por destaque. Validar:
```bash
npx tsx scripts/lint-social-md.ts --check linkedin-schema --md data/editions/{AAMMDD}/03-social.md
```
Falha = subseção ausente (missing_main / missing_comment_diaria / missing_comment_pixel) ou char count fora do range. Exit 1 = re-disparar `social-linkedin` agent.

**Lint pergunta-de-encerramento pré-gate (#1762):** posts social não devem fechar com pergunta (CTA-pergunta). Rodar:
```bash
npx tsx scripts/lint-social-md.ts --check no-trailing-question --md data/editions/{AAMMDD}/03-social.md
```

**Lint deixis de newsletter em post/comment pessoal (#2148):** `## post_pixel` e `### comment_pixel` são postados na conta PESSOAL do autor — sem contexto de marca. "Esta/essa/nossa newsletter" pressupõe que o leitor está dentro da Diar.ia; inválido num post standalone. Rodar:
```bash
npx tsx scripts/lint-social-md.ts --check personal-post-no-newsletter-deixis --md data/editions/{AAMMDD}/03-social.md
```
Exit 1 = ocorrências de "esta newsletter", "essa newsletter", "nossa newsletter" (e variantes com "boletim", "edição") em `## post_pixel` ou `### comment_pixel`. **Incluir ocorrências no prompt do gate** com sugestão de substituição. Fix: reescrever como fato biográfico ("a newsletter de IA que escrevo") em vez de contexto compartilhado. Não bloqueia automaticamente — editor decide se reescreve ou aceita (casos de borda: citação direta de entrevistado).
Flaga quando a última frase do post principal (corpo de `## d{N}`, antes dos comments) termina em "?". Perguntas retóricas no meio e perguntas entre aspas são ignoradas. Exit 1 = **incluir os matches no prompt do gate** (platform + destaque + frase) — editor decide reescrever o fim como afirmação ou aceitar. Fix preferido: re-disparar o agent social correspondente pra fechar com afirmação.

### 2d. Sync push + gate unificado

- **Sync push antes do gate:**
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md,03-social.md,_internal/02-clarice-diff.md --on-conflict pull-merge --fail-on-conflict
  ```
  - `--on-conflict pull-merge` (#963): quando Drive foi modificado depois do último push, tenta 3-way merge automático via `git merge-file --diff3` usando snapshot pre-push como base. Edits disjuntos (pipeline mexeu em D2, editor mexeu em D3) merge clean e seguem.
  - `--fail-on-conflict` (#977): quando 3-way detecta overlap real (mesma região editada por ambos), exit 2. Markers `<<<<<<<` ficam em local pra editor resolver.
  - Anotar resultado em `sync_results[2]`. Exit 0 = OK (com ou sem warnings não-conflito); Exit 2 = CONFLICT real — **parar imediatamente** e renderizar halt banner:
  ```bash
  npx tsx scripts/render-halt-banner.ts \
    --stage "2 — Escrita" \
    --reason "drive-sync 3-way merge tem conflitos não-resolvíveis: editor e pipeline editaram a mesma região" \
    --action "abrir 02-reviewed.md, resolver markers <<<<<<<, e re-rodar drive-sync push"
  ```

- **Pre-gate invariants (#1007 Fase 1).** Antes do gate, rodar lints como invariantes (defense-in-depth — lints individuais já rodaram, mas registry centraliza):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 2 --edition-dir data/editions/{AAMMDD}/
  ```
  Exit 1 = re-disparar writer ou bloquear gate até fix manual. Violations são logadas com `source_issue` pra rastreabilidade.

- **Medir tamanho dos destaques (#739).** Antes de apresentar o gate, rodar:
  ```bash
  npx tsx scripts/measure-highlights.ts data/editions/{AAMMDD}/02-reviewed.md
  ```
  Stderr exibe `d1: N chars (M palavras)` por destaque + total + warnings quando algum destaque está fora da faixa saudável (600-1500 chars). Incluir o output stderr no prompt do gate pra editor avaliar balanceamento (d1 muito longo vs d3 raso = desbalanceio editorial; >1500 = newsletter densa, CTR cai). Não bloquear — informativo only.

- **GATE HUMANO unificado (newsletter + social):** mostrar `_internal/02-clarice-diff.md` e o conteúdo de `03-social.md`. Instruir:
  ```
  ✏️  Etapa 2 — Escrita pronta.

  Newsletter — edite data/editions/{AAMMDD}/02-reviewed.md:
      — Mantenha exatamente 1 título por destaque (delete os outros 2).
        URL fica na linha imediatamente abaixo do título escolhido (#172).

  Social — revise data/editions/{AAMMDD}/03-social.md:
      — 3 posts LinkedIn (d1/d2/d3) + 3 posts Facebook (d1/d2/d3)

  📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/
  ```
  Quando o editor responder "sim", os arquivos locais são os textos finais.

  - **Auto-pick de título via Sonnet (#159, #2772).** Após aprovação, **fazer snapshot do 02-reviewed.md** pra `_internal/02-pre-title-picker.md` (necessário pra validar estrutura post-#1205), depois dispatch `title-picker` (Sonnet, Agent) passando:
    - `md_path = data/editions/{AAMMDD}/02-reviewed.md`
    - `out_path = data/editions/{AAMMDD}/02-reviewed.md` (in-place)
    - `audience_path = context/audience-profile.md`
    - `editorial_rules_path = context/editorial-rules.md`
    - `picks_log_path = data/editions/{AAMMDD}/_internal/02-title-picks.json`

    ```bash
    cp data/editions/{AAMMDD}/02-reviewed.md data/editions/{AAMMDD}/_internal/02-pre-title-picker.md
    ```

    Title-picker detecta destaques que ainda têm >1 título (editor não podou) e escolhe 1 baseado em concretude + tom + variedade lexical. Se `destaques_picked > 0`, logar info: `"title-picker: auto-podou N destaque(s) — log em _internal/02-title-picks.json"`. Se `destaques_picked === 0`, editor já podou tudo manualmente — title-picker é no-op.

    Erro do agent (ex: destaque sem título nenhum) deve ser reportado ao editor antes de prosseguir pra Etapa 3 — não há fallback automático pra título inexistente.

  - **Validar estrutura preservada (#1205).** Após title-picker, comparar estrutura de seções pré/pós:
    ```bash
    npx tsx scripts/validate-section-structure.ts \
      --before data/editions/{AAMMDD}/_internal/02-pre-title-picker.md \
      --after data/editions/{AAMMDD}/02-reviewed.md
    ```
    Exit 1 = title-picker mexeu na estrutura (removeu `---`, moveu ERRO INTENCIONAL, etc — caso 260517). **Restaurar do snapshot** e reportar ao editor: `"⚠️ title-picker corrompeu estrutura — restaurando 02-reviewed.md do snapshot. Pode podar 1 título por destaque manualmente."`. Não re-disparar — agent vai cometer o mesmo erro.

  - **Validar frontmatter YAML (#2553).** Após title-picker (e após restauração de snapshot, se houver), validar que o frontmatter `intentional_error` está bem-formado como YAML multi-linha com as 5 chaves obrigatórias:
    ```bash
    npx tsx scripts/validate-frontmatter-yaml.ts \
      --md data/editions/{AAMMDD}/02-reviewed.md
    ```
    Detecta 2 formas de corrupção:
    - Bloco `intentional_error` colapsado em 1 linha (caso real 260625: title-picker reescreveu o arquivo com `## intentional_error: description: "..." ...` em vez de mapping YAML indentado).
    - Chaves ausentes (`description`, `location`, `category`, `correct_value`, `reveal`).

    Exit 1 = **Restaurar do snapshot** e reportar ao editor: `"⚠️ title-picker corrompeu o frontmatter YAML — restaurando 02-reviewed.md do snapshot. Pode podar 1 título por destaque manualmente."`. Não re-disparar — agent vai cometer o mesmo erro. (Note: `validate-section-structure.ts` compara contagem de seções, não valida YAML — essa check é complementar, não redundante.)

  - **Validar 1 título por destaque (#178).** Após o title-picker:
    ```bash
    npx tsx scripts/lint-newsletter-md.ts \
      --check titles-per-highlight \
      --md data/editions/{AAMMDD}/02-reviewed.md
    ```
    Exit 1 = algum destaque ainda tem ≠1 título. **Não prosseguir** — re-apresentar o gate com o erro destacado:
    > ⚠️ DESTAQUE N tem K títulos — delete os K-1 excedentes em `data/editions/{AAMMDD}/02-reviewed.md` antes de aprovar de novo.

    Se exit 0, prosseguir pra Etapa 3 normalmente. (Em caso normal, title-picker já podou tudo e este check passa silenciosamente.)

  - **Inserir TÍTULO/SUBTÍTULO no topo (#916).** Roda depois que cada destaque tem 1 só título (pós title-picker / poda manual). Stage 4 (Beehiiv) usa esse bloco como subject + preview text — sem isso, editor preenche manualmente todo dia. Idempotente.

    ```bash
    npx tsx scripts/insert-titulo-subtitulo.ts \
      --in data/editions/{AAMMDD}/02-reviewed.md
    ```
    Falha = warning, **não bloqueia** (gate já aprovou).

  - **Escrever sentinel de conclusão do Stage 2:**
    ```bash
    npx tsx scripts/pipeline-sentinel.ts write \
      --edition {AAMMDD} --step 2 \
      --outputs "02-reviewed.md,03-social.md"
    ```
    Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'sentinel_write_failed'`). Não bloquear.

  - **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 2 done via `update-stage-status.ts --stage 2 --status done --end ISO --duration-ms X [--cost-usd Y --tokens-in N --tokens-out N --models "sonnet-4-6,opus-4-7"]`.
    `title_picker:?1` = só conta se foi disparado (destaques_picked > 0); senão 0.
