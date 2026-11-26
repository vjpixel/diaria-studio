---
name: orchestrator-stage-2-fallback
description: Fallback da Etapa 2 do orchestrator diar.ia.br (#14113) — prosa detalhada dos passos que `scripts/stage-2-run.ts` executa (pré-condição, §2a caps/fontes/dispatch/stitch/pool, §2b lints/normalize/humanizador/Clarice REST/guards pós-Clarice/render do erro intencional/invariantes, §2c merge/humanizador/Clarice REST/prova do social, §2d pós-gate). Lido só quando o runner falta ou falha fora dos codes previstos, ou quando orchestrator-stage-2.md cita uma seção daqui. Não é um subagente invocável diretamente.
---

> Fallback de `.claude/agents/orchestrator-stage-2.md`, separado no #14113. Não executar diretamente e não ler no caminho normal: o runner `scripts/stage-2-run.ts` executa estes passos. Ler este arquivo quando o runner não existir ou falhar de um jeito não coberto pelos `code`s (aí seguir §2a-§2d turno a turno, junto com os passos fora do runner do arquivo principal) ou quando o arquivo principal citar uma seção daqui. "Acima", "abaixo" e o que não está aqui (o `category_label` e a tabela temática do #6083, a captura de custo, as ações por id dos lints da newsletter e do social, a proposta do erro intencional, as exceções do `check-invariants --stage 2`, o texto do gate e o `update-stage-status`) referem-se ao arquivo principal. A Clarice é só REST aqui também (#14113): nenhum passo chama `mcp__clarice__correct_text`.

---

## Etapa 2 — Escrita (fallback do runner)

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
  Por último, o mesmo script aplica o **teto global de 13 conteúdos (#9785)** — destaques + todas as seções secundárias, corte por score sem cota por seção, destaques e itens pinados pelo editor nunca saem; cada corte vai pro stderr e pro run-log. Writer recebe `01-approved-capped.json`. Lint pós-writer (`--check section-counts`) valida que o output respeitou os caps; falha = re-disparar writer.

- **Limpar/truncar summaries em inglês (#1490 / #1572).** Antes de stitch, rodar:
  ```bash
  npx tsx scripts/translate-summaries.ts \
    --in {EDITION_DIR}/_internal/01-approved-capped.json \
    --out {EDITION_DIR}/_internal/01-approved-capped.json
  ```
  O script é idempotente (marca `summary_translated: true` após processar). Strip de prefixo arXiv + 1ª frase + truncate em 150 chars; **não faz tradução LLM** — apenas cleanup determinístico pra evitar prefix bruto `[TRADUZIR]` no MD final. Items com `summary_lang: "en"` (categorize.ts #1473) e/ou arXiv abstract são afetados. Stitch adiciona `[TRADUZIR]` na **DESCRIÇÃO** (2ª linha) quando o summary está em EN — **nunca no título** (#1697/#1634: título de seção secundária preserva o nome original do recurso, nunca traduzido). O prefixo da descrição é removido pelo **humanizer** (ETAPA 0, que roda no draft stitched inteiro — seções secundárias incluídas); o que sobrar barra o sentinel da Etapa 2 (`reviewed-no-untranslated-summary`, #9358) e o orchestrator traduz antes do gate. (Obs: `writer-destaque` NÃO toca seções secundárias — só escreve D1/D2/D3.) Sem este step, o `[TRADUZIR]` + summary em inglês cru vazam pro newsletter HTML (histórico: `docs/orchestrator-stage-narrative-history.md#stage-2-translate-leak`).

**Em uma única mensagem**, disparar os agents simultaneamente:
### Modo padrão: writer-destaque paralelo (#1158, #1451, #2343)

**INVARIANTE (#1451 decisão editorial 2026-05-21):** writer paralelo é **default em todas as situações**. Corta wall-clock do Stage 2 de ~30min pra ~10min (Stage 2 era 92% do total do pipeline).

**Pré:** ler `_internal/01-approved-capped.json` direto via `Read` tool e extrair `highlights[]`. Cada highlight tem `{ rank, score, bucket, reason, article }`. **#2343: range válido é {2,3}** — `highlights.length < 2 || highlights.length > 3` → fallback (edge case). Para 2 destaques, dispatch writer-destaque × 2 (D1 + D2). Para 3, dispatch × 3 (D1 + D2 + D3). Construir `peer_titles_per_destaque` inline: para cada destaque N, peer_titles é o array de `highlights[i].article.title` para i ≠ N-1.

`category_label` é a **Category editorial do destaque**, derivada de `highlights[N-1].article.category` pela tabela temática do #6083 — ver "Dispatch dos agentes" no arquivo principal (nunca do `bucket`, #1668).

Não usar `scripts/extract-destaques.ts` aqui — esse script parsea MD final (pós-writer), não JSON pré-writer. Confusão de paths levou ao bug do #1451 review (PR #1462).

**0. Baixar as fontes dos destaques ANTES do dispatch (#9252)** — do MESMO `01-approved-capped.json` que o writer e o lint usam (approved e capped podem divergir, ex. 260925):
```bash
npx tsx scripts/refresh-destaque-sources.ts --edition-dir {EDITION_DIR}/ --approved {EDITION_DIR}/_internal/01-approved-capped.json --record-writer-inputs
```
Grava `_internal/fact-check-sources/d{N}.txt` com o texto completo de cada `article.url` (fail-soft: download falho vira `error`, writer segue só com o summary). Sem isso o writer escreve do `summary` curto e inventa fatos (261001). `--record-writer-inputs` (#9648, só aqui — nunca no Stage 4) grava `_internal/02-writer-inputs.json` (+ cópia do texto), registro do que cada writer recebeu que a troca de destaque no Stage 4 não sobrescreve. **0b. 4º post social — item USE MELHOR (#9568), ANTES do dispatch:** `npx tsx scripts/select-use-melhor-post.ts --edition-dir {EDITION_DIR}/`. Stdout JSON. **`enabled: false` (quando `publishing.social.use_melhor_time` for `null`/inválido OU colidir com um slot de destaque `fallback_schedule.d{N}_time` — desde 25/11/2026 o valor é `"09:00"`, decisão do editor ao fim do teste rotativo do #10305; era `"07:45"` desde 05/10/2026) → feature INERTE: não passar nada novo aos social agents, dispatch exatamente como abaixo.** `enabled: true` + `item` não-nulo → passar `use_melhor_post_path = {EDITION_DIR}/_internal/use-melhor-post.json` ao `social-writer` E ao `social-curto` (passos 2/3), que escrevem também a seção `## um`. `enabled: true` + `item: null` → não passar (4º post pulado; o `reason` aparece no gate do Stage 4). Fail-soft: erro do script nunca aborta o Stage 2.

**0c. Pesquisa de títulos do D1 no YouTube (#12552), ANTES do dispatch:** `npx tsx scripts/youtube-title-research.ts --edition-dir {EDITION_DIR}/ --approved {EDITION_DIR}/_internal/01-approved-capped.json`. Busca os vídeos de maior audiência dos últimos 4 dias sobre a história do D1 (até 3 queries, nomes próprios + termo principal em PT e EN) e grava `_internal/youtube-title-research.json` com os títulos, views, canal, idioma e os termos que mais se repetem no topo. Stdout JSON `{ status, reason, path, videos, top_terms }`. **`status: "ok"`** → passar `youtube_title_research_path = {EDITION_DIR}/_internal/youtube-title-research.json` ao `writer-destaque` do **D1** (só dele; D2/D3 não recebem) e, depois do gate, ao `title-picker` (§2d). Qualquer outro `status` (`skipped` sem credencial, `error` de cota/token/rede, `no_results`) → não passar nada e seguir; o motivo aparece no gate do Stage 4. Exit sempre 0 (fail-soft), nunca aborta o Stage 2. É só vocabulário: nenhum título é trocado por este passo.

**Dispatch paralelo (uma única mensagem com N+2 chamadas Agent — N writer + 2 social, onde N = highlights.length ∈ {2,3}):** **Nunca fazer polling (#9223).** As N+2 chamadas `Agent` são SÍNCRONAS: a mensagem só volta quando os subagentes terminaram, com os resultados já na resposta. Não há o que esperar — nunca usar `sleep`, `while … sleep`, `tasklist`, `ls` em loop ou script de poll para "aguardar" os subagentes. Em sessão headless (`claude --print`, spawn do `edition-stage-runner.ts`) esses comandos são negados (`permission_denials`) e cada tentativa queima um turno do teto `--max-turns` (edição 261001: ~15 tentativas negadas, 120 turnos esgotados sem sentinela). Se um output esperado não existir depois da resposta do `Agent`, o subagente falhou — tratar como falha, não esperar mais. **Antes desta mensagem, guardar o instante do dispatch (#9962):** `npx tsx scripts/verify-agent-outputs.ts --now` → `{DISPATCH_AT}` (usado no check pós-dispatch abaixo).

1. `Agent` → `writer-destaque` × N — uma instância por destaque (n=1..N). Cada uma recebe:
   - `destaque_n`, `destaque` (= `highlights[N-1].article`), `category_label`
     - **#3920: passe o `article` INTEIRO** (não enumere campos) — ele carrega `cluster_sources[]` quando a história teve cobertura múltipla (dedup). O writer usa isso pra emitir o bloco "Aprofunde:" e citar fatos das fontes extras. O `article.url` já é o link canônico (artigo mais completo do cluster).
   - `peer_titles` (titles dos outros 2 — preserva voice diversity)
   - `edition_date`; `source_url` = `highlights[N-1].article.url` **literal** — a única URL permitida no link do título (#9252: writer headless já inventou URL "parecida"); `source_text_path` = o `path` da entrada com `destaque === N` no JSON do passo **0** acima (omitir se a entrada veio com `error`)
   - `out_path = {EDITION_DIR}/_internal/02-d{N}-draft.md`
   - `image_prompt_out_path = {EDITION_DIR}/_internal/02-d{N}-prompt.md`
   - `youtube_title_research_path` (#12552): **só no D1** e só quando o passo 0c saiu `status: "ok"` — senão omitir.

2. `Agent` → `social-writer` (#3991, reverte #3486 — colapsa `social-linkedin`+`social-facebook`+`social-instagram` num único agent) passando:
   - `approved_json_path = {EDITION_DIR}/_internal/01-approved-capped.json`
   - `out_dir = {EDITION_DIR}/`
   - `outros_count`: **não injetar (#2319)** — `social-writer` mantém `{outros_count}` como placeholder literal (igual a `{edition_url}`), consumido só pelo `## post_pixel` de edições ANTIGAS (aposentado na #9568). Não calcular nem passar no prompt. `use_melhor_post_path` (#9568): só sob a condição do passo 0b — senão omitir.
   - `source_text_paths` (#9794): `{"d1": path, "d2": path, "d3": path}` — o MESMO `path` por `destaque` do JSON do passo **0** que vai como `source_text_path` aos `writer-destaque` (omitir a chave da entrada que veio com `error`). Sem isso o social escreve só do `summary` do approved, que pode ser a meta-description institucional do site e não o anúncio (edição 261007, D2 Mistral: 2 `NOT_FOUND_IN_SOURCE` no fact-check). **Chave `um` (#9871):** quando o passo 0b passou `use_melhor_post_path` e o stdout trouxe `item.source_text_path`, incluir `"um": "{EDITION_DIR}/{item.source_text_path}"` (texto completo da fonte do item, `_internal/use-melhor-source.txt` — o `item.body` é cortado em 6000 chars e os social agents não têm WebFetch). Sem `item.source_text_path` (fetch falhou), omitir a chave.
   Gera `_internal/03-social.tmp.md` com 1 texto genérico (estilo Instagram, #3991) por destaque — IDÊNTICO pra LinkedIn/Facebook/Instagram, SEM CTA de canal — seguido de `## d{N}-cards` com os 3 blocos do carrossel (#12094: a legenda `## d{N}` é texto corrido, sem a forma do card; só o carrossel lê a seção `-cards`) + `## um` (4º post USE MELHOR, só com `use_melhor_post_path`). **`## post_pixel` NÃO é mais gerado (#9568)** — o post pessoal do Pixel passou a ser o mesmo texto do `## um`. A linha de CTA por canal (e-mail no Facebook, "link na bio" no Instagram, nenhuma no LinkedIn — ver `scripts/lib/social-cta-lines.ts`) é injetada só no Stage 5, nunca aqui.

3. `Agent` → `social-curto` (#3992, mesmo input que social-writer — `approved_json_path` + `out_dir` + `use_melhor_post_path` sob a mesma condição do passo 0b + `source_text_paths` idêntico ao do passo 2 (#9808: sem ele o `# Curto` escreve do `summary` e contradiz o `# Social` do mesmo destaque); `outros_count` não se aplica; **independente do #3991**, não muda). Gera `_internal/03-curto.tmp.md` com 1 texto ≤280 chars por destaque, compartilhado por Twitter/X (dispatch via Buffer MCP no Stage 5, #3994) e Threads (`publish-threads.ts`, que lê exclusivamente esta seção — sem fallback pra `# Social`/`# Facebook`, #4294).

**Aguardar os N writer-destaques + 2 social retornarem.** Cada `writer-destaque` retorna JSON `{ out_path, image_prompt_path, destaque_n, char_count, written, warnings }`. **Se `warnings[]` de qualquer um não estiver vazio, pare e reporte ao usuário antes de prosseguir** — mesma regra do writer único legacy. **Conferir em disco o que os agentes disseram que gravaram (#9962) — OBRIGATÓRIO, antes de qualquer leitura/stitch:** o "gravei e conferi" do subagente não prova nada (edição 261009: `writer-destaque` reportou sucesso e `02-d1-draft.md`/`02-d3-prompt.md` não existiam; o hook #9132 tinha recusado o nome do arquivo). Rodar `npx tsx scripts/verify-agent-outputs.ts --agent stage2-writers --since {DISPATCH_AT} --paths {EDITION_DIR}/_internal/02-d1-draft.md,{EDITION_DIR}/_internal/02-d1-prompt.md,...,{EDITION_DIR}/_internal/03-social.tmp.md,{EDITION_DIR}/_internal/03-curto.tmp.md` com o `out_path` + `image_prompt_out_path` de cada um dos N `writer-destaque` e os 2 `.tmp.md` dos social. **Exit 1 = fail-loud:** o stderr nomeia o arquivo ausente/vazio/defasado — re-disparar SÓ o agente daquele arquivo (mesmo prompt) e rodar o check de novo; se falhar outra vez, pedir o bloco colado na resposta e gravá-lo você mesmo (exceção: `03-curto.tmp.md` que falhar 2× segue a política warn-only do #3992 em `validate-stage-2-outputs.ts`). Um retorno com `written: false` (o agente teve o Write recusado) é tratado igual: re-disparar, nunca integrar. Nunca seguir para o stitch com arquivo faltando.


**Pós:** rodar `scripts/stitch-newsletter.ts` (#1463) que produz `02-draft.md` determinístico unificando os 3 destaque drafts + seções secundárias + blocos fixos:

```bash
npx tsx scripts/stitch-newsletter.ts --edition-dir {EDITION_DIR}/
```

**#1938/#2527/#2978/#3212/#3476/#3824:** o stitch auto-injeta os boxes de divulgação nos slots 1 (D1/D2), 2 (D2/D3) e 3 (região pós-ÚLTIMO-destaque, entre D3/D2 e USE MELHOR) em **todo daily** (decisão editorial — os 3 boxes são permanentes desde #3476). Config-driven via `boxes_divulgacao` de `platform.config.json`. Os blocos 📣 Clarice (`data/snippets/clarice-divulgacao.md`, via `loadClariceCallout`) e indicação de ferramenta (`data/snippets/indicacao-ferramenta.md`) seguem disponíveis para reuso (mensal / troca pontual / configurar em qualquer slot). Idempotente por slot (pula se a região correspondente já traz um callout `**📣/📚/🎉 …**` ou `🛒 …`, marcador-agnóstico — ver `boxAlreadyPresentInGap`/`boxAlreadyPresentAfterLastDestaque`). Kill-switch pontual: `--no-sponsor` (suprime a injeção nos slots ativos). **#4274 (slot 0, introdução, opcional, default `null`):** `boxes_divulgacao.slot0` injeta um 4º box entre a coverage line e `**DESTAQUE 1`, só quando o editor o atribui no painel Caixas — mesma idempotência (`boxAlreadyPresentAtIntro`). Limitação: compete pela mesma região do `introCallout`/agradecimento — se for a ÚNICA ocupação da intro E vier bold-wrap total, é lido como `introCallout`, não `boxDivulgacao0` (ver `locateBoxAtIntro` em `newsletter-parse.ts`); prefira formato multi-parágrafo pro slot0 quando não houver outro conteúdo de intro. **#4626 — seleção AUTOMÁTICA dos slots 1/2/3 (substitui a leitura estática quando não há pin manual):** ANTES de chamar `stitchNewsletter()`, `main()` chama `resolveBoxesForEdition()` (`scripts/select-boxes-by-clicks.ts`) — se `boxes_divulgacao_auto.enabled` for `true` (default desde #4626), todo slot 1/2/3 NÃO listado em `pinned_slots` é resolvido por cliques + tendência de queda (janela recente vs. anterior cede espaço a média histórica inflada) + anti-repetição (nunca a box da edição imediatamente anterior). Slot pinado, ou `enabled: false`, usa `boxes_divulgacao.slotN` tal como está (pré-#4626, sem mudança). Sem candidato elegível cede pro valor já configurado — só esvazia o slot se esse fallback for inelegível (outra audiência/mesmo evento/duplicado, `fallback-ineligible`, #9155). Nunca grava em `platform.config.json` (só vale pra esta stitch); fica registrado em `_internal/box-selection.json`, consumido pelo resumo do Stage 4 (§4c.7) como informação, sem gate (decisão do editor #4626: troca de box é baixo risco, não conteúdo editorial).

O script é determinístico, sem LLM. Ordem canonical (#3476, slot0 desde #4274):
- Coverage line (do `01-approved-capped.json > coverage.line`)
- box de divulgação slot 0 (introdução — opcional, entre a coverage line e DESTAQUE 1)
- DESTAQUE 1 block (lê `_internal/02-d1-draft.md`)
- box de divulgação slot 1 (D1/D2)
- DESTAQUE 2 block (lê `_internal/02-d2-draft.md`)
- box de divulgação slot 2 (D2/D3) — **omitido em edições de 2 destaques**
- DESTAQUE 3 block (lê `_internal/02-d3-draft.md`) — **omitido em edições de 2 destaques (#2343)**
- ~~box de divulgação slot 3 (pós-último-destaque)~~ **ELIMINADO (#6748, 29/08/2026)** — `stitch-newsletter.ts` nunca mais injeta nada nessa região; a edição sai com no máximo 2 boxes (slot1+slot2)
- **🛠️ USE MELHOR** (se houver candidato selecionado)
- É IA? section (lê `01-eia.md` se existir, strip frontmatter YAML) — **#3476: agora DEPOIS de USE MELHOR** (antes ficava logo após o último destaque, #2546); se a edição não tiver USE MELHOR, É IA? cai logo após o último destaque (D3 ou D2 — não mais "o box do slot 3", eliminado no #6748)
- **VÍDEOS** (formato canonical `**[title](url)**` + summary, singular/plural conforme count #1324) — **#3820: agora ANTES de LANÇAMENTOS** (decisão editorial 260722; antes ficava depois, #3100 só tinha subido VÍDEOS pra antes de RADAR)
- **LANÇAMENTOS**, **RADAR** (idem; omite seção vazia — RADAR mergeia PESQUISAS + OUTRAS NOTÍCIAS, #1569)
- **ERRO INTENCIONAL** placeholder (`render-erro-intencional.ts` re-insere ao final pós-Clarice — auto-converge)
- **🎁 SORTEIO** (texto fixo) + **🙋🏼‍♀️ PARA ENCERRAR** (#4274: cabeçalho fixo; slot A — apoio+ferramentas — e slot B — convite social, sempre último — são texto editável via painel Caixas em `platform.config.json` → `para_encerrar.{slot_a,slot_b}`, default = o texto de sempre quando não customizado)

Lint pós-stitch valida overlap de hook entre destaques; se overlap detectado, re-dispatch o destaque "perdedor" com peer_titles atualizado.

**Descrição do pool a partir do texto lido (#13884, decisão do editor de 25/11/2026) — logo depois do stitch (ou do writer único, no fallback), antes dos lints do §2b.** O stitch monta a descrição de LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS do `summary`; este passo a reescreve da página baixada no passo 0 (`_internal/pool-sources/`). (1) `npx tsx scripts/pool-descriptions.ts --input --edition-dir {EDITION_DIR}/` — stdout `{ input_path, items, skipped[] }`; `items: 0` → pular (2)-(3); item de `skipped[]` (403, prévia de paywall, página quase vazia, YouTube) fica com a descrição do `summary` e o `source-not-read` do gate 4 o julga. (2) `Agent` → `writer-pool` com `input_path` e `out_path = {EDITION_DIR}/_internal/02-pool-descriptions.json` (síncrono, sem polling #9223); conferir com `verify-agent-outputs.ts --agent writer-pool --since {DISPATCH_AT} --paths {out_path}` (#9962), ausente = log warn e pular (3). (3) `npx tsx scripts/pool-descriptions.ts --apply --edition-dir {EDITION_DIR}/` — troca a descrição no `02-draft.md`, preserva o tempo do USE MELHOR e grava as URLs aplicadas em `pool-sources/descriptions-applied.json` (é o que faz o `source-not-read` contar a página como lida); descrição rejeitada pela forma (fora de 60-280 chars, markdown, seta, URL) vai ao stderr e o item fica como estava; exit ≠ 0 = log warn e seguir. (4) Custo: `<usage>` do `writer-pool` em `record-agent-costs.ts --stage 2 --costs {EDITION_DIR}/_internal/tmp-agent-costs-stage2-pool.json` (o `cost.json` acumula).

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

2. `Agent` → `social-writer` (#3991, reverte #3486, mesmo input do writer; `{outros_count}` é placeholder literal no output, consumido só pelo `## post_pixel` legado — não injetar #2319; `## post_pixel` aposentado na #9568).
3. `Agent` → `social-curto` (#3992, mesmo input do writer + `source_text_paths` quando o passo 0 rodou, #9808; independente do #3991).

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
Substitui as 6 invocações separadas que existiam aqui antes (1 processo Node por check) por uma única chamada agregadora — mesmas funções, mesmo veredito por check, só menos overhead de processo. Output (stdout): JSON `{ stage: 2, passed: boolean, checks: [{ id, source_issue, severity, ok, result }, ...] }`. Os 7 `id` (`url-bucket`, `section-counts`, `destaque-min-chars`, `destaque-max-chars`, `why-matters-length`, `aprofunde-format`, `destaque-url-matches-approved`) são **todos gate-blocking** — `passed` já reflete "nenhum falhou". Debug de 1 check isolado (`--check X --md {EDITION_DIR}/_internal/02-draft.md`) continua funcionando exatamente como antes (modo aditivo, não removido). Para cada `id` com `ok:false`, a ação de re-dispatch é a descrita abaixo, indexada pelo `id` — rode os re-dispatches necessários e repita a chamada acima até `passed: true` (ou esgotar as tentativas descritas por check).

A ação de cada `id` com `ok:false` (re-dispatch do writer do destaque, até quantas tentativas) está no arquivo principal, "§2b — consertos por id".


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

- **Humanizar (#308, #1072):** invocar skill `humanizador` no arquivo `02-normalized.md` — remove tics LLM (gerúndio em cascata, vocabulário inflado, aberturas cenográficas, etc.), calibrando a voz com `data/past-editions-recent.md` como referência (recorte de ~12 edições, #9978 — nunca o `past-editions.md` completo de ~30 dias, que estoura o Read):
  ```
  Skill("humanizador", "Leia {EDITION_DIR}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions-recent.md como referência, e salve o resultado em {EDITION_DIR}/_internal/02-humanized.md.")
  ```
  **Retry 3x + abort se persistir (#1072).** Se a skill retornar erro OU se `02-humanized.md` for byte-idêntico a `02-normalized.md` (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** com erro claro pro editor — não usar fallback "normalized direto pra Clarice" silenciosamente. Justificativa: humanizador remove marcas IA que Clarice **não** pega; sem ele a edição sai com prosa polida-vazia (issue #1072). Logar cada tentativa: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'humanizador attempt N/3 failed'`. Após 3ª falha: `--level error --message 'humanizador esgotou retries — abortar Stage 2'` + exit do pipeline.

- **Revisar com Clarice (REST, inline — sem Agent):**
  Determinar e **persistir** `CLARICE_INPUT` em arquivo (#871) — evita drift entre o passo de leitura e o passo de diff:
  ```bash
  npx tsx scripts/resolve-clarice-input.ts --edition-dir {EDITION_DIR}/
  ```
  O script aplica a fallback chain `(02-humanized.md → 02-normalized.md → 02-draft.md)`, valida que o arquivo escolhido existe, e grava o nome relativo em `{EDITION_DIR}/_internal/02-clarice-input.txt`. Se nenhum existir, exit 1 (FATAL).

  **Snapshot pré-Clarice (#874).** Antes de aplicar Clarice, copiar o `CLARICE_INPUT` resolvido para `_internal/02-pre-clarice.md`. Esse snapshot é (a) source-of-truth pra resume mid-Clarice (re-rodar a Clarice parte sempre do snapshot, nunca de `02-reviewed.md`; ver Resume em `diaria-2-escrita/SKILL.md`), (b) input pro check de estabilidade de URLs (#873) abaixo, (c) input do `clarice-diff.ts`:
  ```bash
  CLARICE_INPUT=$(cat {EDITION_DIR}/_internal/02-clarice-input.txt)
  cp "{EDITION_DIR}/_internal/$CLARICE_INPUT" {EDITION_DIR}/_internal/02-pre-clarice.md
  ```

  **Assertion obrigatória (review #889 P2).** Antes de chamar a Clarice, verificar que o snapshot foi gravado. Se ausente, abortar e logar erro — sem snapshot não há como detectar URL stability nem fazer resume mid-Clarice:
  ```bash
  test -f {EDITION_DIR}/_internal/02-pre-clarice.md || {
    npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level error --message "pre-clarice snapshot missing — aborting before Clarice call"
    echo "ERRO: snapshot pré-Clarice ausente — abortar antes de chamar a Clarice." >&2
    exit 1
  }
  ```

  1. Ler `_internal/02-clarice-input.txt` pra obter o filename relativo (`{FILENAME}`).
  2. Chamar a Clarice pelo REST (#1329, retry #2320, chunking #2626) — único caminho da Etapa 2 desde o #14113, o mesmo do runner. **Nunca** chamar `mcp__clarice__correct_text` com o texto: o LLM mandava o texto inteiro como argumento e o reescrevia com Write (~3,5k tokens de saída por passada). **Sempre passar `--corrected-out`** (#2626): o script divide textos > 4.500 chars (`CLARICE_CHUNK_THRESHOLD` de `scripts/lib/diaria/clarice-chunk.ts`) em chunks por fronteira segura, faz 1 request por chunk em série (`CLARICE_CHUNK_CONCURRENCY=1`, #4952: concorrência causava o timeout) e aplica as sugestões chunk-localmente via `mergeChunkSuggestions`, gravando o texto corrigido nesse arquivo. Esse é o resultado correto para textos multi-chunk — **não** re-aplicar `02-clarice-suggestions.json` ao texto inteiro via `clarice-apply.ts` (uma âncora única dentro de um chunk pode aparecer 2+× no texto inteiro e seria pulada como ambígua, sub-corrigindo silenciosamente):
     ```bash
     npx tsx scripts/clarice-correct.ts \
       --in {EDITION_DIR}/_internal/{FILENAME} \
       --out {EDITION_DIR}/_internal/02-clarice-suggestions.json \
       --corrected-out {EDITION_DIR}/_internal/02-clarice-corrected.md \
       --retry \
       --edition {AAMMDD} \
       --deadline-ms {deadlineMs}
     ```
     `{deadlineMs}` = `deadlineMs` de `npx tsx scripts/lib/clarice-stage2-deadline.ts --edition-dir {EDITION_DIR}` (#14029: 90000 com o ping real do Stage 0 falho, 480000 no resto). **Chamar a Bash tool com `timeout: 600000` (#12257)** — o default de 2 min corta o comando antes do teto de 8 min do script e o exit 6 nunca chega. `--retry` usa 3 tentativas × 60s timeout com backoff exponencial (0s → 5s → 10s entre tentativas). Teto **por chunk**: ~3min15s; para textos multi-chunk o teto total é ~N × 3min15s (N = nº de chunks). Sem `--retry`, timeout é 30s e há apenas 1 tentativa (comportamento legado). Em sucesso, **consumir `02-clarice-corrected.md` diretamente no passo 3** (já é o texto corrigido — pular `clarice-apply.ts`). **Observabilidade por tentativa (#2798):** com `--edition`, cada tentativa (sucesso/retry/falha fatal) é logada em `data/run-log.jsonl` (`message: "clarice_rest_attempt"`, `details: {attempt, elapsedMs, payloadBytes, outcome, status?, chunksInFlight?, viaParagraphFallback?}`) — útil pra correlacionar timeout com concorrência (não tamanho de payload — teoria de tamanho refutada em #4952) via `/diaria-log {AAMMDD}`. **Fallback de 2º nível por-parágrafo (#5082):** habilitado por default, não precisa de flag — se um chunk esgotar os retries acima (não-4xx), o script automaticamente sub-divide esse chunk em parágrafos e tenta 1 request isolado por parágrafo substantivo (sem retry, timeout curto de 20s), recuperando parte ou toda a correção em vez de desistir do chunk inteiro; entradas do run-log com `viaParagraphFallback: true` vêm desse caminho. Não requer ação do orchestrator — é automático dentro de `clarice-correct.ts`. Pra forçar essa granularidade manualmente desde o início (debug/investigação, ver #5082), existe `--granularity paragraph`.

     Exit 0 = sucesso (segue pro passo 3). Exit 3 = HTTP non-2xx, timeout, falha de rede ou certificado TLS recusado depois das tentativas (#12693) (logar `level: error` + halt banner pra editor decidir retry vs skip); o motivo sai na última linha JSON `{"failure": {...}}` do stdout, levar ao banner. Exit 2 = `CLARICE_API_KEY` ausente (halt). **Exit 5 (#5755) = guard de staleness do `--corrected-out`** — mtime do arquivo escrito é anterior ao início da chamada (no-op silencioso: nenhuma requisição HTTP nova, conteúdo de execução ANTERIOR) — halt, nunca consumir esse arquivo, re-rodar em foreground. Se `clariceRest === false` (lido do `preflight-state.json` — ver o arquivo principal), **tentar o REST mesmo assim** (#12257): o health check do Stage 0 não guarda o motivo, e API fora ou lenta chega aqui como exit 6 (skip abaixo, sem halt); 401 ou chave ausente voltam como exit 3/2, e aí sim halt. **Exit 6 (#12257) = `clarice_unavailable`**: a API não respondeu dentro do teto TOTAL da chamada (`--deadline-ms`, default 8 min, abaixo dos 10 min em que o harness mata o comando; soma chunks, retries e fallback por-parágrafo). Nada foi gravado em `--out`/`--corrected-out`. **Não fazer halt nem reexecutar o stage.** Rodar `npx tsx scripts/clarice-pending.ts skip --edition-dir {EDITION_DIR}/ --reason clarice_unavailable --edition {AAMMDD}`: grava `02-reviewed.md` a partir de `_internal/02-pre-clarice.md` (o humanizado), gravando antes o marcador `_internal/02-clarice-pending.json` (um crash no meio não deixa texto sem Clarice e sem aviso), mais `[]` em `_internal/02-clarice-suggestions.json` e o evento `clarice_skip`. Pular os passos 3 e 4 abaixo e seguir o resto do Stage 2 normalmente (strip de travessão, URL, cupons, render do erro intencional, gate). No handoff e no resumo do gate, a linha `clarice não rodou (clarice_unavailable): retomar com npx tsx scripts/clarice-pending.ts resume --edition-dir {EDITION_DIR}/ --edition {AAMMDD}`. O Stage 4 tenta o `resume` no início (§4a, antes do fact-check), e os invariantes `clarice-pending` (gate 4) e `clarice-pending-at-publish` (Stage 5) repetem o aviso enquanto o marcador existir. Skip exit 3 = snapshot pré-Clarice ausente ou `02-reviewed.md` editado depois dele: halt banner com o stderr.

     **Skip consciente (#2320).** Se o editor aprovar o skip depois do halt (REST exit 3), é o mesmo `skip` do exit 6 com outro motivo: `npx tsx scripts/clarice-pending.ts skip --edition-dir {EDITION_DIR}/ --reason mcp_down_rest_exit3_editor_approved --edition {AAMMDD}`. Grava o marcador, `02-reviewed.md` a partir do `02-pre-clarice.md`, `[]` nas sugestões (aceito por `checkClariceRan`) e o evento `clarice_skip` que `collect-edition-signals.ts` (`signalsFromClariceSkips`) conta. Nunca à mão (`cp` + `echo '[]'`): sem o marcador, os gates 4 e 5 não acusam que a Clarice não rodou. Continuar o pipeline normalmente.
  3. Produzir o texto revisado em `{EDITION_DIR}/02-reviewed.md`. **Aplicação é incondicional (#4514):** aplicar **todas** as sugestões da Clarice, sem cherry-pick por gosto/registro e sem apresentá-las ao editor como menu de escolha antes — relatar o que mudou no diff (passo 4 abaixo), não negociar antes. **Única exceção:** sugestão que corrompa identificador técnico ou nome de marca (ex: `diar.ia` → `diária` quebraria a marca) — aplicar todo o resto e sinalizar só essa ao editor no gate. O script já gravou o texto corrigido (chunk-applied) em `02-clarice-corrected.md`: **copiar esse arquivo diretamente** para `02-reviewed.md`, sem re-aplicar `02-clarice-suggestions.json` via `clarice-apply.ts`:
       ```bash
       cp {EDITION_DIR}/_internal/02-clarice-corrected.md {EDITION_DIR}/02-reviewed.md
       ```
  4. Gerar diff legível usando o snapshot pré-Clarice, passando `02-normalized.md` (pré-Humanizador) como 4º argumento opcional — **#3929: a Clarice tem precedência sobre o Humanizador** (correções que revertem uma edição de estilo do Humanizador são esperadas e não devem ser bloqueadas por passo posterior; o 4º arg permite ao `clarice-diff.ts` sinalizar explicitamente `⚠️ REVERTE HUMANIZADOR` em cada alteração que reverte, dando contexto ao editor no gate em vez de uma correção gramatical indistinguível):
     ```bash
     npx tsx scripts/clarice-diff.ts \
       {EDITION_DIR}/_internal/02-pre-clarice.md \
       {EDITION_DIR}/02-reviewed.md \
       {EDITION_DIR}/_internal/02-clarice-diff.md \
       {EDITION_DIR}/_internal/02-normalized.md
     ```
     **Rerun com a Clarice OK (#12257):** chegou aqui com a Clarice aplicada (REST exit 0)? Apagar o marcador de um skip de rodada anterior: `npx tsx scripts/clarice-pending.ts clear --edition-dir {EDITION_DIR}/ --edition {AAMMDD}` (no-op sem marcador).
  Se a Clarice falhar, propagar o erro — **não** usar o rascunho sem revisão. Única exceção: exit 6 `clarice_unavailable` do REST, que segue pelo `clarice-pending.ts skip` acima, com o aviso no handoff e no gate.

- **Pós-Clarice, pré-gate: strip de travessão (#9379) e sync do bloco É IA? (#5459).** PRIMEIRO `npx tsx scripts/strip-emdashes-reviewed.ts --edition-dir {EDITION_DIR}` — humanizador/Clarice reintroduzem travessão (` — `) depois do `removeEmdashes` do normalize (editor removia à mão em 21 de 22 destaques); idempotente, exit 0 se `02-reviewed.md` existir, exit 3 só se faltar. DEPOIS, sincronizar o bloco É IA? de volta pra `01-eia.md` (#5459). O bloco `**É IA?**` em `02-reviewed.md` é só um MIRROR copiado verbatim de `01-eia.md` no stitch — mas `extractContent` sempre lê `01-eia.md`, nunca o mirror. Humanizador+Clarice, que acabaram de rodar sobre `02-reviewed.md` inteiro sem exclusão de seção, podem ter reescrito o bloco (achado ao vivo 260817: travessão removido só no mirror). Sem este passo só o Stage 4 (`eia-credit-synced`, #3825, warning-only) descobriria, sempre exigindo fix manual — rodar agora fecha o loop automaticamente: `npx tsx scripts/sync-eia-block.ts --edition-dir {EDITION_DIR}`. Exit 0 sempre que `02-reviewed.md` existir (no-op se sem mirror ainda ou já sincronizado); reescreve `01-eia.md` in-place quando divergir, preservando o frontmatter YAML. Exit 3 só se `02-reviewed.md` faltar (erro real). Exit 4 (#13886) = recusa, nada escrito: o mirror é o placeholder do stitch (ou perderia legenda/"Resultado da última edição") e o `01-eia.md` já tem conteúdo real; o fix é espelhar 01 → 02 com `npx tsx scripts/sync-eia-block.ts --edition-dir {EDITION_DIR} --from 01`.

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
  Garante que todo URL na seção LANÇAMENTOS bate com whitelist oficial (`scripts/categorize.ts > LANCAMENTO_DOMAINS`/`PATTERNS`). **#1968 (verificação POSITIVA):** além do domínio oficial, cada item precisa de um sinal de produto (software/hardware) no slug/título — item oficial sem sinal vai pra `not_a_tool` e também faz exit 1 (pega parceria/evento/programa/relatório). Se exit code != 0 (URL não-oficial OU `not_a_tool`), **incluir os erros no prompt do gate humano** mostrando linha + URL + sugestão de mover pra NOTÍCIAS. Não bloquear automaticamente — editor decide. **Se for ferramenta legítima de slug atípico** (ex: hardware NVIDIA Jetson), rodar `npx tsx scripts/add-lancamentos-allowlist-entry.ts --entry {URL ou padrão de caminho} --edition-dir {EDITION_DIR}/` e re-rodar o validate — override permanente da verificação positiva. **Nunca editar `seed/lancamentos-tool-allowlist.txt` no checkout compartilhado (#12442):** o script grava a linha num worktree de `origin/master` e abre PR (como o `publish-edition-site-page.ts` com a página); a edição corrente já usa a entrada via `_internal/lancamentos-tool-allowlist-pending.txt`. Exit 1 = PR não abriu (a edição segue com o override pendente): citar no resumo do gate.

- **Sincronizar linha de cobertura (#1097):** após Clarice + validate-lancamentos, antes do render-erro-intencional, rodar:
  ```bash
  npx tsx scripts/sync-coverage-line.ts --edition-dir {EDITION_DIR}/
  ```
  Auto-calcula X = nº de **e-mails/threads** recebidos no inbox editorial (`inbox.address` do `platform.config.json`) (1 e-mail = 1 submissão, independente de quantas URLs carrega — lido do marker `.marker-inject-inbox-urls.json`), Y = `pool.length - inboxLinks` (onde `inboxLinks` é a contagem de **LINKS** que entraram pelo canal do editor, não a contagem de e-mails — misturar essas unidades foi o bug do #1864; sem `inboxLinkCount`/marker legado, cai no fallback `pool - X`, caso degradado, não o comportamento canônico), Z (itens visíveis no 02-reviewed.md final). Substitui a linha "Para esta edição..." no topo do MD. Antes era chutada pelo writer LLM e ficava stale após podas. Stdout: `{ x, y, z, changed, mdPath }`. Falha não-bloqueante (log warn) — números errados são cosméticos, não bloqueiam publicação. Fonte de verdade: `countEditorVsAuto` em `scripts/sync-coverage-line.ts` — não reparafrasear a lógica aqui, conferir o código se divergir (#3807).

- **Render ERRO INTENCIONAL obrigatório (#1073):** após Clarice (e antes do gate humano), rodar:
  ```bash
  npx tsx scripts/render-erro-intencional.ts \
    --edition {AAMMDD} \
    --md {EDITION_DIR}/02-reviewed.md
  ```
  Substitui o placeholder do writer pelo reveal do erro anterior (`Na última edição, …`) + preserva ou insere placeholder pra `Nessa edição, …` (autor preenche manualmente). Também garante que `_internal/intentional-error.json` existe (escreve placeholder `{PREENCHER}` se ausente — #3222, campos estruturados description/location/category/correct_value/wrong_value/reveal — `wrong_value` desde #7243, sibling de `02-reviewed.md`, **nunca** sincroniza com o Drive). **Falha = abortar Stage 2** (não silenciar). Justificativa: sem o script, edição vai com `{placeholder, script render-erro-intencional.ts substitui pós-Clarice}` literal no MD; quando colado manualmente no Beehiiv (#1083), aparece como texto bruto no email — contamina UX e mata o concurso "Ache o erro".

  Plantio determinístico em headless/`--no-gates`/`auto_approve` (#9255) e proposta do erro no modo interativo (#3222, filtro de segurança do #3808): arquivo principal, "Erro intencional".


- **Validator final Stage 2 (#1072, #1073):** antes do gate humano, rodar invariant check que detecta passos pulados silenciosamente:
  ```bash
  npx tsx scripts/check-stage2-invariants.ts \
    --edition-dir {EDITION_DIR}/
  ```
  Cobre 5 checks: (a) Humanizador rodou (02-humanized.md ≠ 02-normalized.md), (b) Clarice rodou (02-reviewed.md ≠ 02-pre-clarice.md), (c) render-erro-intencional rodou (sem placeholder literal no MD), (d) `_internal/intentional-error.json` existe (#2284, migrado #3222) — placeholder OK, valores preenchidos pelo editor via chat (não mais via Drive), (e) `intentional-error.json.reveal` (quando já preenchido) começa com "Na última edição" ou outra palavra-gancho temporal reconhecida pelo renderer (#6139) — sem isso, o box de reveal da EDIÇÃO SEGUINTE não é renderizado, silenciosamente. Exit 1 = abort + mostrar o(s) check(s) que falharam ao editor. Existe pra capturar regressões de retry/skip silencioso — humanizador/Clarice/render-erro/intentional-error.json/reveal-temporal-prefix são todos invariantes do Stage 2.

  **Autofix de `fabricated-ellipsis` embutido nesta mesma chamada (#6441).** Antes dos 5 checks acima, o `main()` de `check-stage2-invariants.ts` roda `runSecondaryItemEllipsisAutofix` (`scripts/apply-secondary-item-coherence-autofix.ts`) sobre `{EDITION_DIR}/02-reviewed.md`: restaura mecanicamente qualquer descrição de item secundário (RADAR/USE MELHOR/LANÇAMENTOS) que terminou truncada em "…" entre o stitch e o humanizador, colando o trecho correspondente do `summary` de `01-approved.json` — só quando o summary de origem está íntegro (prefixo bate exatamente). Loga em `_internal/secondary-item-coherence-autofix.json`; best-effort, nunca bloqueia (arquivo ausente = no-op silencioso, item sem prefixo confiável ou com summary TAMBÉM truncado = deixado como está, pra reescrita manual no gate). Por isso o check `secondary-item-coherence` do Stage 4 (`.claude/agents/orchestrator-stage-4.md` §4c.2) rebaixou `fabricated-ellipsis` recuperável pra warn-only — só o caso irrecuperável (summary também truncado, lixo de RSS) segue gate-blocking.

  **Não é mais só um passo em prosa (#6337).** Mesma classe de gap que o #6305 fechou pro sentinel do humanizador social: os 5 checks acima só existiam como esta chamada em prosa — nenhum estava registrado em `STAGE_2_RULES`, então `pipeline-sentinel.ts write --step 2` (#6009) não os cobria e uma sessão que pulasse esta chamada passava pelo gate mecânico sem detecção. Os 5 (`newsletter-humanizador-diff-ran`, `clarice-ran`, `erro-intencional-rendered`, `intentional-error-json-exists`, `reveal-temporal-prefix`) agora também rodam via `scripts/lib/invariant-checks/stage-2.ts` dentro de `write --step 2` — esta chamada explícita continua valendo (roda mais cedo, antes do gate humano, com mensagem mais rica), mas deixa de ser a ÚNICA barreira.

### 2c. Processar social

Após os social agents retornarem, fazer merge em `03-social.md` via script TS. Substitui o snippet inline anterior (#870) — agora com try/catch, validação de tmp files e error reporting actionable:

```bash
npx tsx scripts/merge-social-md.ts --edition-dir {EDITION_DIR}/
```

O script:
- Verifica que `_internal/03-social.tmp.md` (agent `social-writer`) existe e não está vazio; exit 1 com mensagem clara se estiver ausente
- Faz strip de comentários HTML (`<!-- ... -->`) com fallback safe pra comments mal-formados (#875)
- Grava em `03-social.md` como seção única `# Social` (#3991 — substitui `# LinkedIn`/`# Facebook`/`# Instagram`) — texto genérico por destaque + `## um` (4º post, #9568; `## post_pixel` só em edição antiga), sem qualquer CTA de canal (injetada só no publish)
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
Skill("humanizador", "Leia {EDITION_DIR}/03-social.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions-recent.md como referência. Rode os 9 passos completos. Meta quantitativa do padrão #20: zero travessões no output (exceção: diálogo e meia-risca numérica). A 1ª frase de cada ## d{N} e do 1º parágrafo de cada ## d{N}-cards precisa se sustentar sozinha: ao cortar atribuição vaga ou referência temporal, nunca deixe a frase abrindo com 'O estudo', 'A empresa', 'O modelo', 'Isso' ou 'Essa' sem o sujeito ter sido nomeado antes; nomeie o sujeito concreto. Salve no mesmo arquivo.")
```
**Retry 3x + abort se persistir (#1072).** Se skill retornar erro OU `03-social.md` post-humanizador for byte-idêntico ao pré (no-op), re-invocar até 3 vezes total. Após 3 falhas, **abortar Stage 2** — não publicar social com tom corporativo de agent output. Antes da invocação, fazer snapshot: `cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/03-social-pre-humanizador.md` pra diff post-skill.

**Verificar cobertura por-seção do humanizador (#2148):** após cada invocação do humanizador social, checar se TODAS as seções relevantes foram tocadas — não apenas o arquivo como um todo:
```bash
npx tsx scripts/lint-social-md.ts --check humanizer-section-coverage \
  --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md \
  --md {EDITION_DIR}/03-social.md
```
Seções verificadas: `main_d1/d2/d3` (posts principais), `main_um` (4º post USE MELHOR, #9568) e `post_pixel` (só edição antiga — aposentado na #9568). **#3627:** `comment_pixel_d1/d2/d3` deixaram de ser gerados (subseção aposentada) — a função (`checkHumanizerSectionCoverage`) já trata seção ausente em pré/pós como no-op, sem mudança de código necessária. Seção idêntica antes/depois = humanizador não tocou. **Exit 1 com lista de seções não-cobertas → re-invocar humanizador mirando explicitamente essas seções no prompt** (ex: "humanize a seção post_pixel que ficou com tom corporativo"). Contabiliza como tentativa adicional no retry 3x — se após o retry dirigido a cobertura ainda for parcial e o no-op total persistir, abortar. Fundamento: o guard whole-file (byte-idêntico pré vs pós) detecta "humanizador não rodou nada", mas NÃO detecta "humanizador rodou nos destaques mas pulou post_pixel" — esse furo deixava esse post com tom LLM passando silenciosamente pelo gate (#2148).

**Retry 3x + fallback inline se `clarice-plugin:humanizador` Unknown skill (#2285):** se a invocação da skill retornar `Unknown skill: clarice-plugin:humanizador` (o marketplace pode ter re-sincronizado durante a sessão), **retry imediato até 3 vezes** antes de desistir. Entre tentativas, aguardar ~5s para o registro recarregar. Se após 3 retries a skill ainda não resolver, **não abortar silenciosamente** — aplicar o rubric inline via prompt direto (referência obrigatória: `context/publishers/humanizador-rubric.md` — leia o arquivo antes de formular o prompt para o LLM; contém as etapas 0-3 + regras de preservação). Logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message "humanizador-skill-fallback-inline: clarice-plugin:humanizador Unknown skill após 3 retries — aplicando rubric inline"`. Somente após humanização concluída (skill OU inline), prosseguir para Clarice e sentinel.

**Snapshot pós-humanizador / pré-Clarice (#3929).** Antes de aplicar Clarice, copiar o `03-social.md` (já humanizado) para `_internal/03-social-post-humanizador.md`:
```bash
cp {EDITION_DIR}/03-social.md {EDITION_DIR}/_internal/03-social-post-humanizador.md
```
Esse snapshot vira o baseline do check `humanizer-section-coverage` no pre-gate (`check-invariants.ts --stage 2`, §2d) — decorrelaciona a detecção de "humanizador pulou uma seção" das mudanças que a Clarice fizer a seguir. **Motivação (#3929):** a Clarice tem precedência sobre o Humanizador (correção > estilo) — sem este snapshot, uma reversão legítima da Clarice (ela corrige o texto de volta pra perto do pré-humanizador porque o Humanizador introduziu um erro) faria a seção parecer "idêntica ao pré-humanizador" no check, sendo lida como "humanizador não cobriu a seção" e disparando re-humanização/bloqueio indevido do gate — blindando efetivamente o Humanizador contra a correção da Clarice.

**Revisar social com Clarice (REST, ordem #1072: Humanizador → Clarice):** mesmo script da newsletter, sobre o `03-social.md` já humanizado, com o teto normal de 480 s inteiro (o de 90 s do ping real falho é só da newsletter, #14084) e a Bash tool com `timeout: 600000`. Nunca `mcp__clarice__correct_text` (#14113).
```bash
npx tsx scripts/clarice-correct.ts \
  --in {EDITION_DIR}/03-social.md \
  --out {EDITION_DIR}/_internal/03-clarice-suggestions.json \
  --corrected-out {EDITION_DIR}/_internal/03-clarice-corrected.md \
  --retry \
  --edition {AAMMDD} \
  --deadline-ms 480000
```
Exit 0: aplicar **todas** as sugestões incondicionalmente (#4514 — mesma regra do reviewed: sem cherry-pick, sem menu de escolha ao editor; única exceção é sugestão que corrompa identificador técnico ou nome de marca, aplicar o resto e sinalizar só essa), ou seja, copiar `_internal/03-clarice-corrected.md` para `03-social.md` **depois** de conferir que a seção `# Social` (#3991) e os headers `## d1`, `## d2`, `## d3` (+ `## um` em `# Social` e `# Curto` quando o passo 0b passou `use_melhor_post_path`, #9568) ainda existem no corrigido. Cabeçalho perdido = manter o texto humanizado, sem a correção, e avisar no gate. Qualquer outro exit, inclusive o 6 (`clarice_unavailable`), é **halt** (#14084): o `clarice-pending resume` do Stage 4 cobre só a newsletter, então o social nunca segue sem Clarice em silêncio. Retomada pelo runner: `--phase post-humanize --social-clarice-only [--deadline-ms N]`.

**Diff legível da revisão Clarice social (#3929).** Gerar diff comparando o snapshot pós-humanizador/pré-Clarice contra o `03-social.md` final, passando `03-social-pre-humanizador.md` (pré-Humanizador) como 4º argumento — sinaliza explicitamente `⚠️ REVERTE HUMANIZADOR` em cada alteração da Clarice que desfaz uma edição do Humanizador, pra o editor decidir com contexto no gate:
```bash
npx tsx scripts/clarice-diff.ts \
  {EDITION_DIR}/_internal/03-social-post-humanizador.md \
  {EDITION_DIR}/03-social.md \
  {EDITION_DIR}/_internal/03-social-clarice-diff.md \
  {EDITION_DIR}/_internal/03-social-pre-humanizador.md
```

**Gravar sentinel de humanizador social (#2279):** após humanizar+Clarice (ambos concluídos), registrar a prova de cada passo (#11534 — é o que o `--write` do Stage 4 confere, e o que o `--provenance` mostra no gate) e gravar o hash do `03-social.md` final:
```bash
npx tsx scripts/check-humanizer-social.ts --record-run --step humanizador --pre {EDITION_DIR}/_internal/03-social-pre-humanizador.md --post {EDITION_DIR}/_internal/03-social-post-humanizador.md --edition-dir {EDITION_DIR}/
npx tsx scripts/check-humanizer-social.ts --record-run --step clarice --pre {EDITION_DIR}/_internal/03-social-post-humanizador.md --post {EDITION_DIR}/03-social.md --edition-dir {EDITION_DIR}/
```
Se a Clarice rodou e não sugeriu nada no social, `--pre` e `--post` do `--record-run --step clarice` saem iguais e o registro é recusado (exit 1, #11674): repetir com `--note "Clarice sem sugestões"` (prova mais fraca, aparece como "sem sugestões" no `--provenance`) antes do `--write` abaixo (#11685). Nunca passar o mesmo arquivo nos dois sem ter chamado a Clarice.
```bash
npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/
```
O `--write` grava `_internal/.humanizer-social-done.json` com o sha256 do arquivo atual. O Stage 4 valida esse hash antes do gate — se o social for editado ou reordenado depois, o hash diverge e o gate bloqueia para re-humanizar.

**Não é mais só um passo em prosa (#6305).** Caso real (edição 260827): o humanizador rodou de fato (snapshot `03-social-pre-humanizador.md` presente, diff confirmando reescrita), mas esta chamada `--write` nunca aconteceu numa sessão via `run-edition-stages.ts` — e o `humanizer-ran` (guard mecânico de #6009 que já bloqueava o `write` do sentinel de Stage 2) não capturava isso, porque ele só prova que a skill `humanizador` rodou (via snapshot), não que este passo seguinte rodou. O Stage 4 só descobriu no `check-humanizer-social.ts --check`, exit 1, tarde demais pra ser barato de corrigir. A regra `social-humanizer-sentinel-written` (`scripts/lib/invariant-checks/stage-2.ts`) fecha essa lacuna: `pipeline-sentinel.ts write --step 2` (mesmo gate do `humanizer-ran`) agora também recusa gravar o sentinel do Stage 2 se `_internal/.humanizer-social-done.json` estiver ausente ou com hash divergente do `03-social.md` atual — pular esta chamada não passa mais silenciosamente.

Exit code handling:
- `0` → sentinel gravado com sucesso.
- `1` → falha ao gravar (permissão, disco) — logar warn e **CONTINUAR Stage 2**. Stage 4 vai bloquear com exit 1 até o sentinel ser gravado manualmente.

**Lint anti-alucinação de cifras pré-gate (#1711):** após humanizar+Clarice, rodar:
```bash
npx tsx scripts/lint-social-numbers.ts --social {EDITION_DIR}/03-social.md --approved {EDITION_DIR}/_internal/01-approved-capped.json
```
Flaga cifras de DINHEIRO COM MAGNITUDE (US$/R$/€ + número + bi/mi/bilhões/...) presentes no post de cada destaque mas AUSENTES da fonte DAQUELE destaque (title+summary de `highlights[N-1]` + texto bruto `_internal/fact-check-sources/d{N}.txt` quando o manifest marca `ok` com a URL atual, #9809 — o mesmo texto que os social agents recebem como `source_text_paths`) — comparação **per-destaque** (não pool inteiro), que pega número certo no contexto errado (exemplo real: `docs/orchestrator-stage-narrative-history.md#stage-2-cifra-errada-exemplo`). WARN-only (exit 0) para cifras alucinadas e contagem errada. `{outros_count}` no `post_pixel` é placeholder legado (#2319, #3052 revertido em 260814 — o writer normalmente não o emite mais, mas o lint segue tolerante caso apareça) — não bloqueia por isso. **Incluir as cifras flagadas no prompt do gate** ("⚠️ cifra X não encontrada na fonte — confira") pro editor verificar contra a fonte original antes de aprovar. Cifras: heurística conservadora (pode ter falso-positivo se a fonte usa formato muito diferente).

**Lints consolidados pré-gate (#5416):** `npx tsx scripts/lint-social-md.ts --stage 2 --json --edition-dir {EDITION_DIR}` — comando, severidade e ação de cada id no arquivo principal, "§2c — lints do social".

### 2d. Gate unificado (pré e pós-gate)

`check-invariants --stage 2` (e as exceções por regra) e o texto do gate humano estão no arquivo principal, §2d.

- **Medir tamanho dos destaques (#739).** Antes de apresentar o gate, rodar:
  ```bash
  npx tsx scripts/measure-highlights.ts {EDITION_DIR}/02-reviewed.md
  ```
  Stderr exibe `d1: N chars (M palavras)` por destaque + total + warnings quando algum destaque está fora da faixa saudável (600-1500 chars). Incluir o output stderr no prompt do gate pra editor avaliar balanceamento (d1 muito longo vs d3 raso = desbalanceio editorial; >1500 = newsletter densa, CTR cai). Não bloquear — informativo only.


  - **Auto-pick de título via Sonnet (#159, #2772).** Após aprovação, **fazer snapshot do 02-reviewed.md** pra `_internal/02-pre-title-picker.md` (necessário pra validar estrutura post-#1205), depois dispatch `title-picker` (Sonnet, Agent) passando:
    - `md_path = {EDITION_DIR}/02-reviewed.md`
    - `out_path = {EDITION_DIR}/02-reviewed.md` (in-place)
    - `audience_path = context/audience-profile.md`
    - `editorial_rules_path = context/editorial-rules.md`
    - `picks_log_path = {EDITION_DIR}/_internal/02-title-picks.json`
    - `youtube_title_research_path = {EDITION_DIR}/_internal/youtube-title-research.json` (#12552) — só quando o arquivo existe com `status: "ok"` (passo 0c de §2a); senão omitir.

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

  - **Re-gravar sentinel de humanizador social pós-gate (#6305).** Rodar de novo, **depois** da aprovação do gate acima e **antes** do `pipeline-sentinel.ts write` abaixo:
    ```bash
    npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/
    ```
    **Por que este passo existe aqui (não é redundante com a chamada de §2c):** o gate de §2d convida o editor a editar `03-social.md` diretamente — mudança legítima e esperada. A chamada `--write` de §2c grava o hash sobre o texto de ANTES do gate; se o editor mexer no arquivo durante o gate (mesmo 1 palavra), o hash fica stale e a regra `social-humanizer-sentinel-written` (`scripts/lib/invariant-checks/stage-2.ts`, #6305) bloqueia o `pipeline-sentinel.ts write` logo abaixo com `hash_mismatch` — não porque algo quebrou, mas porque ninguém re-registrou o texto que o editor de fato aprovou. Re-rodar aqui fecha esse gap: o hash final bate com o texto pós-gate, e `hash_mismatch` volta a significar só o caso real (alguém editou `03-social.md` por fora deste playbook, sem re-humanizar/re-registrar). **Não remover como "já rodou em §2c"** — é exatamente essa suposição que reintroduz o falso-positivo.
    Exit code handling: mesmo padrão da chamada de §2c — `0` = sentinel regravado; `1` = falha ao gravar (permissão, disco) — logar warn e **CONTINUAR Stage 2** (Stage 4/gate de write abaixo vai bloquear até o sentinel ser gravado manualmente). **Exit `3` (hash diverge) ou `4` (prova ausente) = o editor editou `03-social.md` no gate (#12377 item 1).** O `--write` sem flags recusa porque o texto aprovado pelo editor não passou pelo humanizador nem pela Clarice. O editor aprovou o texto dele, então o default é manter: rodar de novo com os dois motivos, citando o que o editor mudou — `npx tsx scripts/check-humanizer-social.ts --write --edition-dir {EDITION_DIR}/ --bypass-reason "editor editou o social no gate §2d" --unproven-ok "editor aprovou o texto dele no gate §2d"`. O `--unproven-ok` grava o aceite por hash (`accepted_section_hashes`, #12361), que a regra `social-humanizer-provenance-recorded` lê; o `--provenance` mostra a seção como "aceita sem prova". Só re-humanizar (humanizador + Clarice + `--record-run` de cada passo, como em §2c, e depois `--write --bypass-reason`) quando o editor pedir. Se a regra `social-humanizer-provenance-recorded` acusar seção sem prova com o selo já batendo com o texto (selo gravado sem os `--record-run`, #12331), `--write --unproven-ok "<motivo>" --unproven-ok-section {seção}` sem `--bypass-reason` aceita só as seções nomeadas (#12398, #12511; vírgula separa, atalho `d2`/`d2-cards`/`um` vale). **Exit `5` (#12511)** = `--unproven-ok` sem mudança desde o selo e sem `--unproven-ok-section`: nada é gravado e o JSON lista as seções sem prova (`candidates`) — não é falha de gravação (exit 1), repetir com o seletor. Nomear apenas a seção que o editor pediu para manter; seção em que o humanizador não rodou volta ao §2c (humanizador + Clarice + `--record-run`), nunca ao `--unproven-ok`.

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
    Exit code handling: `0` = snapshots criados; `!=0` = logar warn, não bloquear. **Desde o #9356 o `pipeline-sentinel.ts write --step 2` acima já grava esse baseline sozinho** (carimbado em `.capture.json`) — esta chamada é redundante e idempotente (no-op se já existe); mantida como cinto e suspensório. O baseline é imutável e precisa ser a SAÍDA DA PIPELINE: nunca recriá-lo depois que o editor mexeu nos arquivos.

  - **Limpar os snapshots intermediários (#874, #9581) — só DEPOIS do sentinel** (os invariantes `clarice-ran`, `humanizer-ran` e `newsletter-humanizador-diff-ran` do `write --step 2` os leem; o runner apaga a mesma lista, `STAGE2_SNAPSHOTS`, no fim do `post-gate`). Sem mais resume mid-Clarice possível depois disto:
    ```bash
    for f in \
      {EDITION_DIR}/_internal/02-pre-clarice.md \
      {EDITION_DIR}/_internal/02-normalized.md \
      {EDITION_DIR}/_internal/02-humanized.md \
      {EDITION_DIR}/_internal/02-draft.pre-humanize.md \
      {EDITION_DIR}/_internal/03-social-pre-humanizador.md; do
      [ -f "$f" ] && rm "$f"
    done
    ```

