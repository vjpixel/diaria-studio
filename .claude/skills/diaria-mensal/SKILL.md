---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + Use Melhor (3 tutoriais mais clicados) + Radar (7 links mais clicados). Uso — `/diaria-mensal --cycle YYMM-MM [--no-gate]` ou legado `/diaria-mensal YYMM`. Etapas 0-5, espelhando a numeração/semântica da diária (#2795) — 0 Preflight, 1 Coleta/Análise, 2 Escrita, 3 Imagens, 4 Revisão consolidada (gate humano, #2793), 5 Publicação Brevo. Gate ao final de cada etapa 1-5.
---

# /diaria-mensal

Produz uma edição **mensal** da Diar.ia consolidando os destaques publicados nas edições diárias do mês escolhido.

## Argumentos

- `--cycle {conteúdo}-{envio}` = ciclo no formato `YYMM-MM` (ex: `--cycle 2605-06` = conteúdo de maio, enviado em junho). **Formato preferido** (#1962 — elimina ambiguidade entre mês do conteúdo e mês do envio).

  Compat: `$1` = mês no formato `YYMM` (ex: `2605`). O ciclo é derivado automaticamente com aviso (envio = conteúdo + 1). Manter a compat enquanto pastas históricas ainda existirem no formato antigo.

  **Se não passar nenhum dos dois, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir ciclo atual / anterior como atalhos mas exigir confirmação:

  > "Você não passou o ciclo da edição mensal. Qual ciclo quer processar? atual ({ciclo_atual}, ex: 2605-06) / anterior ({ciclo_anterior}) / outro (informe --cycle YYMM-MM)"

- `--no-gate` (opcional) = pular todos os gates humanos. Auto-aprova cada etapa e prossegue direto ao final.

**Variável interna `$CYCLE`:** após resolver o ciclo (pelo `--cycle` passado ou pela derivação do `YYMM` legado), usar `$CYCLE` como o rótulo do ciclo em todos os comandos abaixo. Ex: `CYCLE=2605-06`. O `$1` legado (YYMM) mapeia a `YYMM=${CYCLE:0:4}` quando necessário.

## Etapa 0 — Preflight

Espelha o papel do Stage 0 da diária (setup + checks pré-edição, #2795) — sem gate, sem checkpoint (roda sempre, não é skippável por natureza).

- Beehiiv MCP funcional (conector nativo do Claude Code).
- `platform.config.json → beehiiv.publicationId` populado.
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

**Não há dependência de `data/editions/{AAMMDD}/` local.** O digest puxa direto do Beehiiv, funcionando em qualquer máquina.

## Resume check global (checkpoints unificados com a diária, #2795)

Cada etapa 1-5 grava, ao aprovar seu gate, um checkpoint `_internal/.step-N-done.json` — o MESMO formato de sentinel do diário (`scripts/lib/pipeline-state.ts`), só que sob `data/monthly/{ciclo}/` em vez de `data/editions/{AAMMDD}/` (via `--dir`, #2795). Antes de iniciar, checar de baixo para cima:

```bash
npx tsx scripts/pipeline-sentinel.ts assert --edition $CYCLE --step N --dir "data/monthly/$CYCLE" --outputs "arquivo1,arquivo2"
```

- exit 0 → sentinel presente + outputs íntegros → etapa N completa, pular.
- exit 3 → sentinel AUSENTE mas outputs em disco (ciclo legado, anterior ao #2795 — retrocompat) → tratar como completa (WARN, nunca bloqueia um ciclo antigo).
- exit 1/2 → etapa incompleta → executar.

Ordem de checagem (mais avançada primeiro):

- Etapa 5: `--step 5 --outputs "_internal/05-published.json"` completo → pipeline mensal já concluído (nada a fazer). Se incompleto, a Etapa 5 tem seu PRÓPRIO resume check de granularidade fina (`_internal/05-published.json` existe com `status: "test_sent"` → pular 5a-5c, ir direto ao gate — ver seção da Etapa 5, não duplicado aqui).
- Etapa 4: `--step 4 --outputs "_internal/04-fact-check.json"` → pular para Etapa 5.
- Etapa 3: `--step 3 --outputs "04-d1-2x1.jpg,01-eia.md"` → pular para Etapa 4.
- Etapa 2: `--step 2 --outputs "draft.md"` → pular para Etapa 3.
- Etapa 1: `--step 1 --outputs "prioritized.md"` → pular para Etapa 2.
- Nenhum sentinel nem output em disco → começar pela Etapa 1.

Ao final do gate de cada etapa (exceto quando `retry`/`editar` volta pro topo), gravar o checkpoint:

```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step N --dir "data/monthly/$CYCLE" --outputs "arquivo1,arquivo2"
```

---

## Etapa 1 — Coleta e Análise

### 1a. Coleta via Beehiiv MCP

**Resume check (#400):**
```bash
RAW_POSTS=$(ls data/monthly/$CYCLE/raw-posts/*.txt 2>/dev/null | wc -l)
# Compat: se pasta nova ausente, tentar legada YYMM=${CYCLE:0:4}
[ "$RAW_POSTS" = "0" ] && RAW_POSTS=$(ls data/monthly/${CYCLE:0:4}/raw-posts/*.txt 2>/dev/null | wc -l)
RAW_DESTAQUES=$(test -f data/monthly/$CYCLE/_internal/raw-destaques.json && echo "yes" || \
                test -f data/monthly/${CYCLE:0:4}/_internal/raw-destaques.json && echo "yes" || echo "no")
```
- `RAW_POSTS > 0` e `RAW_DESTAQUES = yes` → pular 1a e 1b.
- `RAW_POSTS > 0` e `RAW_DESTAQUES = no` → pular 1a, executar 1b.
- `RAW_POSTS = 0` → executar 1a e 1b (mesmo que `_internal/raw-destaques.json` exista — pode ser de run anterior via fallback local, #400).

**Coleta (inline — não via subagente, #403):** Chamar os MCPs Beehiiv **diretamente** neste contexto:
1. `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_posts` — `publication_id`, `status="confirmed"`, `per_page=50`. Paginar e filtrar client-side pela janela do mês `[${CYCLE:0:4}]` (mês do conteúdo = YYMM).
2. Para cada post: derivar `AAMMDD` do `published_at`, `id_prefix` (8 chars sem `post_`). Path: `data/monthly/$CYCLE/raw-posts/post_{id_prefix}_{AAMMDD}.txt`. Pular se já existe (resume). Caso contrário: `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__get_post_content` → gravar `markdown` (preferido) ou `html` (fallback).

Se `posts_found = 0`, abortar.

**Parse:**
```bash
npx tsx scripts/collect-monthly.ts --cycle $CYCLE
```
Se `destaques_count < 3`, abortar.

### 1b. Scoring mensal

**Resume check:** verificar se todos os destaques em `_internal/raw-destaques.json` já têm o campo `score` não-nulo. Se sim, pular.

```bash
MONTHLY_INTERNAL=$(npx tsx -e "import { monthlyDir as d } from './scripts/lib/monthly-paths.ts'; console.log(d('$CYCLE') + '/_internal')" 2>/dev/null || echo "data/monthly/$CYCLE/_internal")
node -e "const d=JSON.parse(require('fs').readFileSync('$MONTHLY_INTERNAL/raw-destaques.json','utf8')); const missing=d.destaques.filter(x=>x.score==null).length; console.log(missing===0?'scored':'missing:'+missing)"
```

Se `missing > 0`, disparar `scorer-monthly` via `Agent`:
- `raw_path = data/monthly/$CYCLE/_internal/raw-destaques.json`
- `out_path = data/monthly/$CYCLE/_internal/raw-destaques.json`

O scorer sobrescreve o arquivo adicionando `score` a cada destaque.

### 1c. Análise temática

Disparar `analyst-monthly` via `Agent`:
- `raw_path = data/monthly/$CYCLE/_internal/raw-destaques.json`
- `out_path = data/monthly/$CYCLE/prioritized.md`
- `yymm = ${CYCLE:0:4}`

### 1d. Seções por cliques (Use Melhor + Radar) — #1901/#1902

Após o analista, rodar o ranking determinístico por cliques, que substitui o bloco `## Outras Notícias` do `prioritized.md` por `## Use Melhor` (3 tutoriais mais clicados) + `## Radar` (7 links mais clicados, fora dos Destaques e do Use Melhor):

```bash
npx tsx scripts/monthly-click-sections.ts --cycle $CYCLE
```

Fontes: per-link click data em `data/beehiiv-cache/posts/*.json` (enriquecido via `beehiiv-clicks-enricher`) + seções publicadas em `data/editions/{AAMMDD}/02-reviewed.md`.

**Use Melhor emprestado (#1568):** se as edições diárias do mês forem anteriores à criação da seção Use Melhor (ex.: meses até ~maio/2026), não há tutoriais-fonte no próprio mês. Nesse caso, emprestar a 1ª semana do mês seguinte (que já tem a seção) via `--use-melhor-source AAMMDD:prefix,...` (o `prefix` é o id curto do post no Beehiiv). Garantir que essas edições estejam enriquecidas com clicks antes (rodar `beehiiv-clicks-enricher` nelas). Ex. para o digest de maio (ciclo 2605-06):
```bash
npx tsx scripts/monthly-click-sections.ts --cycle 2605-06 \
  --use-melhor-source 260601:32c6c918,260602:d7adab86,260603:e8b02883,260604:a2fe05de
```

Output: `_internal/monthly-clicks.json` + patch em `prioritized.md`. Warning (não bloqueia) se Use Melhor < 3 ou Radar < 7 candidatos.

**Tamanho do Use Melhor configurável (#2792):** default é top-3 fixo. Se o editor pedir outro número no gate da Etapa 1, re-rodar com `--use-melhor-count N` (ex.: 5 tutoriais). Se o editor pedir por threshold ("todos com ≥N cliques" — inclui empate na fronteira, sem cortar arbitrariamente por posição), usar `--use-melhor-min-clicks N` em vez disso — tem precedência sobre `--use-melhor-count` se as duas forem passadas juntas (warning avisa qual foi ignorada). Ex.:
```bash
npx tsx scripts/monthly-click-sections.ts --cycle $CYCLE --use-melhor-min-clicks 6
```

### Gate Etapa 1 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$CYCLE/ --stage 1 --files prioritized.md` (warning se falhar, nunca bloqueia).

Apresentar ao editor:
```
D1: {tema} ({N} artigos)
D2: {tema} ({N} artigos)
D3: {tema} ({N} artigos)
Use Melhor: {N} tutoriais (mais clicados)
Radar: {N} links (mais clicados)

Aprovar? sim / editar / retry
```
- `editar` → editor edita `prioritized.md` local/Drive; re-rodar analista após confirmação.
- `retry` → re-disparar `analyst-monthly`.

Após aprovação (`sim`), gravar o checkpoint (#2795):
```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step 1 --dir "data/monthly/$CYCLE" --outputs "prioritized.md"
```

---

## Etapa 2 — Escrita

### 2a. Seleção do É IA? do recap (fonte autoritativa, resolvida cedo — #2904, follow-up de #2869)

Resolver a edição-desafio do mês **antes** de disparar o `writer-monthly` — assim o texto do É IA? (passo 8 do agente) nasce já reconciliado com a mesma seleção autoritativa que a Etapa 3 usa pra compor a imagem, em vez de arriscar reescrever manualmente no gate:

```bash
SEL_JSON="data/monthly/$CYCLE/_internal/02-eia-selection.json"
npx tsx scripts/select-eia-edition.ts --month ${CYCLE:0:4} --cycle $CYCLE --out-json $SEL_JSON >/dev/null
```

Grava `$SEL_JSON` com o `EiaSelectionResult` completo (`edition`, `selection: "criterion"|"fallback_last"`, `pct_correct`, `total_votes`, `reason`, `fetch_errors` — schema de `scripts/select-eia-edition.ts`). Nunca bloqueia: `select-eia-edition.ts` sempre grava algo mesmo em fallback (#2869). A Etapa 3 reusa este mesmo arquivo (não recalcula) pra garantir que texto e imagem do É IA? apontem pra a MESMA edição.

Disparar `writer-monthly` via `Agent`:
- `prioritized_path = data/monthly/$CYCLE/prioritized.md`
- `raw_path = data/monthly/$CYCLE/_internal/raw-destaques.json`
- `out_path = data/monthly/$CYCLE/draft.md`
- `yymm = ${CYCLE:0:4}`
- `eia_selection_path = data/monthly/$CYCLE/_internal/02-eia-selection.json` (#2904 — seleção autoritativa do É IA?, gerada no passo 2a acima; substitui a instrução stale de ler `poll_id` de `eia-used.json`)

O agente escreve `draft.md` + gera `_internal/02-d1-prompt.md` (prompt Van Gogh impasto do D1 para Etapa 3).

### 2b. Lint de chars

```bash
npx tsx scripts/lint-monthly-draft.ts --cycle $CYCLE
```

Emite warnings (não bloqueia) se D1 > 1.500 ou D2/D3 > 1.200 chars. **Guardrail crítico (#2794, exit 1 — bloqueia):** o script também simula o render final e falha se algum label de seção não for reconhecido ou se a sonda de imagens produzir menos de 3 `<img>` para os 3 destaques — sinal de que o draft sairia sem imagem em produção (causa raiz do ciclo 2606-07: writer-monthly emitiu labels sem negrito). Se isso disparar, NÃO prosseguir — corrigir o draft (reforçar `**negrito**` nos labels) e re-rodar o lint antes de seguir pra Etapa 2c.

### 2c. Humanizador

Invocar skill humanizador in-place no `draft.md`:

```
Skill("humanizador", "Leia data/monthly/$CYCLE/draft.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions.md como referência, e salve o resultado no mesmo arquivo.")
```

Se falhar: warning, seguir com o arquivo original (não bloqueia).

### 2d. Clarice

1. Ler `data/monthly/$CYCLE/draft.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `data/monthly/$CYCLE/_internal/02-clarice-suggestions.json`.
4. Aplicar:
```bash
npx tsx scripts/clarice-apply.ts \
  --text-file data/monthly/$CYCLE/draft.md \
  --suggestions data/monthly/$CYCLE/_internal/02-clarice-suggestions.json \
  --out data/monthly/$CYCLE/draft.md \
  --report data/monthly/$CYCLE/_internal/02-clarice-report.json
```

Se `clarice-apply.ts` falhar: warning, seguir com o arquivo original (não bloqueia).

### Gate Etapa 2 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$CYCLE/ --stage 2 --files draft.md,_internal/02-d1-prompt.md,_internal/02-chosen-subject.txt` — **warning se falhar, nunca bloqueia**. (`02-chosen-subject.txt` só existe se o editor tiver escolhido o subject no gate; `02-d1-prompt.md` só existe se o writer tiver gerado o prompt de imagem.)

Drive sync pull antes de apresentar ao editor (ele pode ter editado no Drive após o push): `--mode pull --files draft.md` — idem, warning se falhar.

Apresentar:
```
📄 draft.md gerado.
Opções de subject:
  1. {opção 1}
  2. {opção 2}
  3. {opção 3}

Aprovar? sim [+ número do subject escolhido] / editar / retry
```

**Após aprovação (#421):** se o editor informar o número do subject escolhido (ex: "2"), extrair a linha completa do draft e salvar em `data/monthly/$CYCLE/_internal/02-chosen-subject.txt`:
```bash
CHOICE=2  # número informado pelo editor
MONTHLY_DIR="data/monthly/$CYCLE"
node -e "
  const t = require('fs').readFileSync('$MONTHLY_DIR/draft.md','utf8');
  const m = t.match(/^ASSUNTO[\s\S]*?\n${CHOICE}\. (.+)/m);
  if (m) require('fs').writeFileSync('$MONTHLY_DIR/_internal/02-chosen-subject.txt', m[1].trim());
"
```
Isso salva o texto completo (ex: `Diar.ia | Abril 2026 — 30 milhões de empregos em risco`), não só o número. Qualquer reescrita posterior restaura exatamente essa linha no ASSUNTO.

**Invariante do ASSUNTO:** qualquer passo posterior que modifique `draft.md` (humanizador, Clarice, ajustes de formato) deve usar `Edit` (substituição pontual), nunca `Write` (overwrite completo). Se `Write` for inevitável, ler `02-chosen-subject.txt` antes e restaurar o ASSUNTO correto imediatamente após. O ASSUNTO escolhido pelo editor nunca pode ser sobrescrito silenciosamente.

Após aprovação, gravar o checkpoint (#2795):
```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step 2 --dir "data/monthly/$CYCLE" --outputs "draft.md"
```

---

## Etapa 3 — Imagens

**Resume check:** `04-d1-2x1.jpg` e `01-eia.md` existem → pular Etapa 3, ir para Etapa 4 (Revisão consolidada).

Disparar **em paralelo** (mesma mensagem):

**Destaques D1/D2/D3 — todas 2x1 (#1916):** uma chamada por destaque que tiver
prompt. `--ratio 2x1` força o formato wide pra todos (≠ da diária):
```bash
for D in d1 d2 d3; do
  P="data/monthly/$CYCLE/_internal/02-$D-prompt.md"
  [ -f "$P" ] && npx tsx scripts/image-generate.ts \
    --editorial "$P" --out-dir data/monthly/$CYCLE/ --destaque $D --ratio 2x1
done
```
Se um `02-d{N}-prompt.md` não existir, pular esse destaque (aviso, não bloquear).
Saída: `04-d1-2x1.jpg`, `04-d2-2x1.jpg`, `04-d3-2x1.jpg` (+ crops 1x1).

**É IA? mensal (#1912, rastreabilidade + no-silent-fallback #2869, resolvido
cedo na Etapa 2a — #2904):** a edição-desafio já foi selecionada no passo 2a
(antes do `writer-monthly` escrever o draft) — reusar o mesmo
`_internal/02-eia-selection.json` aqui garante que a imagem composta bata com
o texto que o writer já escreveu, em vez de recalcular e arriscar divergir
(ex: novos votos chegando entre a Etapa 2 e a Etapa 3). Só recalcular se o
arquivo estiver ausente (ciclo iniciado antes de #2904, ou Etapa 3 rodada
isolada via `--only 3` sem passar pela 2a). A tabela de candidatos, quando
recalculado, vai pro stderr (auditoria).
```bash
SEL_JSON="data/monthly/$CYCLE/_internal/02-eia-selection.json"
if [ ! -f "$SEL_JSON" ]; then
  npx tsx scripts/select-eia-edition.ts --month ${CYCLE:0:4} --cycle $CYCLE --out-json $SEL_JSON >/dev/null
fi
EAI_EDITION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SEL_JSON','utf8')).edition)")
SEL_SELECTION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SEL_JSON','utf8')).selection)")
SEL_PCT=$(node -e "const j=JSON.parse(require('fs').readFileSync('$SEL_JSON','utf8')); console.log(j.pct_correct === null ? 'null' : j.pct_correct)")
npx tsx scripts/eia-compose.ts --edition $EAI_EDITION --out-dir data/monthly/$CYCLE/ \
  --selection $SEL_SELECTION --pct-correct $SEL_PCT
```
Se `eia-compose.ts` falhar (sem imagem elegível), registrar warn e seguir — É IA? é opcional. `$SEL_JSON` fica em `_internal/` (não sobe pro Drive — #959) e é a fonte pro item de aviso no Gate Etapa 3 abaixo.

### 3c. Preview local via `serve-preview.ts` (#3546 — substitui Claude Artifacts)

Com as imagens prontas, renderizar o HTML da edição no design real (`draftToEmail`,
mesmo template do Brevo) e servir LOCALMENTE pro editor revisar no Chrome antes
do Brevo. Sobe as imagens do É IA?/destaques/livros pro KV do poll (produção
real, inalterado — ver nota abaixo) e mescla a legenda do `01-eia.md`:
```bash
npx tsx scripts/monthly-preview-cloudflare.ts --cycle $CYCLE
```
Grava o HTML em `data/monthly/$CYCLE/_internal/cloudflare-preview.html` (nome do
arquivo mantido por compat — não sobe mais pra Cloudflare, só as imagens continuam
lá) e o manifest `_internal/public-images.json` (url pública → filename local por
imagem — usado só pelo embed abaixo, #3392). Falha = warning, não bloqueia. Requer
`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` (só pras imagens — produção
real, fora do escopo de #3214/#3546).

**Gerar a variante com imagens embutidas antes de servir** — #1914 tinha migrado
esse preview de Cloudflare pra Claude Artifact (elimina cota de Workers KV pro
HTML), mas Artifacts rodam sob CSP estrita que bloqueia imagem remota (só
`data:` URI) — mesma regressão descoberta e corrigida no diário em 260712
(#3214/#3370), reproduzida e corrigida aqui em #3392. #3546 elimina o Artifact
também (servidor local não tem CSP nenhuma, e nem depende de rede pra imagem),
mas a variante embedded continua necessária — `cloudflare-preview.html`
referencia imagens em `eia.diar.ia.br` (#3904 — domínio de marca), e servir standalone (sem
depender do Worker estar no ar) é o ponto do preview local. Reusa
`scripts/embed-images-base64.ts` (mesmo script do diário, já testado — ver
`.claude/agents/orchestrator-stage-4.md` §4b step 2b):
```bash
npx tsx scripts/embed-images-base64.ts \
  --html data/monthly/$CYCLE/_internal/cloudflare-preview.html \
  --images data/monthly/$CYCLE/_internal/public-images.json \
  --edition-dir data/monthly/$CYCLE \
  --out data/monthly/$CYCLE/_internal/cloudflare-preview-embedded.html
```
`missing` no stdout = imagem sem arquivo local (mantém URL remota, não bloqueia) — logar warn se não-vazio (exit code 1 é só sinal de falha PARCIAL, não fatal — não abortar a etapa por causa dele). Servir a partir de `cloudflare-preview-embedded.html` (NUNCA `cloudflare-preview.html` diretamente — esse fica intacto com URLs reais, análogo ao `newsletter-final.html` do diário).

**Servir localmente via `serve-preview.ts` (#3546).** Diferente do Artifact (URL
hospedada pela infra da Anthropic, sobrevive entre sessões), um servidor local é
um PROCESSO desta sessão — não sobrevive a um resume em sessão nova. Por isso o
padrão aqui é sempre "encerrar o servidor anterior (best-effort — o PID pode já
estar morto, de uma sessão passada) → subir um novo", nunca tentar reusar a
mesma URL entre sessões:
```bash
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/monthly/$CYCLE/_internal/preview-server-url.json','utf8')).preview_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/serve-preview.ts \
  --file data/monthly/$CYCLE/_internal/cloudflare-preview-embedded.html --port 0 \
  --persist-to data/monthly/$CYCLE/_internal/preview-server-url.json --field preview_url &
```
Rodar com `run_in_background: true` no Bash tool. Ler `preview_url` (e
`preview_url_pid`, pra teardown) de `preview-server-url.json`. Em modo `local`
(`scripts/lib/exec-mode.ts`), pode-se navegar o Chrome do editor pra essa URL:
`mcp__claude-in-chrome__tabs_context_mcp` (obter/criar o `tabId` do grupo MCP)
→ `mcp__claude-in-chrome__navigate` com esse `tabId` e `url: {preview_url}`;
em `cloud`, só logar a URL — sem navegação (sem Chrome do editor na sessão).

**#3700 — persistir o `tabId` usado**, no mesmo JSON, pra o teardown da Etapa 4e
conseguir fechar a aba (não só matar o servidor — sem isso a aba fica órfã
apontando pro loopback morto e o "Continuar de onde parei" do Chrome a reabre a
cada restart):
```bash
node -e "const p='data/monthly/$CYCLE/_internal/preview-server-url.json';const j=JSON.parse(require('fs').readFileSync(p,'utf8'));j.preview_url_tab_id={tab_id};require('fs').writeFileSync(p,JSON.stringify(j,null,2));"
```

### Gate Etapa 3 (pulado com `--no-gate`)

Drive sync push: `04-d1-2x1.jpg,04-d1-1x1.jpg,01-eia-A.jpg,01-eia-B.jpg`.

**Aviso de fallback (#2869):** ler `$SEL_JSON` (`_internal/02-eia-selection.json`).
Se `selection == "criterion"`, incluir uma linha de confirmação com o `pct_correct`.
Se `selection == "fallback_last"` (ou o arquivo estiver ausente por falha do
script), incluir um item de **aviso explícito** com o `reason` do JSON — o
editor precisa saber que a escolha foi por fallback, não pelo critério, e
pode responder `trocar-eia AAMMDD` pra apontar manualmente outra edição do
mês (nesse caso, regravar `_internal/01-eia-meta.json` com `selection: "manual"`
antes de seguir).

Apresentar:
```
📸 D1: data/monthly/$CYCLE/04-d1-2x1.jpg
🤔 É IA? A: data/monthly/$CYCLE/01-eia-A.jpg
🤔 É IA? B: data/monthly/$CYCLE/01-eia-B.jpg
🌐 Preview (local): {preview_url}

[se selection == "criterion"]
✓ É IA? do recap: edição {EAI_EDITION} — {pct_correct}% acertaram (critério: mais dividida do mês).

[se selection == "fallback_last"]
⚠️ É IA? do recap: NENHUMA edição do mês teve poll elegível — usando o último dia ({EAI_EDITION}) por fallback, não pelo critério de mais dividida. Motivo: {reason}
   Responda "trocar-eia AAMMDD" pra escolher outra edição manualmente.

Aprovar? sim / regenerar-d1 / regenerar-eia / trocar-eia AAMMDD
```

Este gate é uma checagem rápida das imagens em si — a revisão CONSOLIDADA (draft completo + lint + fact-check) acontece na Etapa 4 a seguir, que roda o preview de novo (fresco, refletindo qualquer regeneração feita aqui).

Após aprovação, gravar o checkpoint (#2795):
```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step 3 --dir "data/monthly/$CYCLE" --outputs "04-d1-2x1.jpg,01-eia.md"
```

---

## Etapa 4 — Revisão consolidada (#2793)

Espelha o Stage 4 da diária (gate humano pré-publicação, #1694): antes de criar a campanha Brevo, monta um **pré-render COMPLETO** da edição (mesmo HTML que vai pro Brevo — imagens D1/D2/D3 2:1 + É IA? A/B + todas as seções) e um resumo consolidado (lint + fact-check), com aprovação humana explícita. Resolve o gap do ciclo 2606-07 (#2793): antes desta etapa, o gate da Escrita (Etapa 2) mostrava `draft.md` cru — placeholders `[...]` do É IA?, sem imagens, sem preview — e o preview Cloudflare (Etapa 3) era acessório, não o artefato central de aprovação.

**Resume check:** `_internal/04-fact-check.json` existe → pular para Etapa 5 (ou, se ausente mas `_internal/05-published.json` já existe com `status: "test_sent"`, idem — ciclo legado que pulou a Etapa 4 antes dela existir, #2795 retrocompat).

### 4a. Drive sync pull

Pull do `draft.md` antes de renderizar (editor pode ter editado no Drive após a Etapa 2):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/monthly/$CYCLE/ --stage 4 --files draft.md
```

Warning se falhar, nunca bloqueia.

### 4b. Pré-render completo (reusa Etapa 3c)

Re-roda o preview — idempotente, garante que o HTML reflita o `draft.md` mais recente (pull do 4a) e as imagens definitivas da Etapa 3:

```bash
npx tsx scripts/monthly-preview-cloudflare.ts --cycle $CYCLE
```

Esse é o MESMO `draftToEmail` que gera o email real — o preview mostra o É IA? com a legenda de `01-eia.md` já mesclada (não o placeholder `[...]` que aparece no `draft.md` cru) e as imagens D1/D2/D3 2:1 embutidas via `<img>`, não só referenciadas por path. Se falhar (Cloudflare indisponível pras imagens): warning, seguir sem preview — mas sinalizar isso claramente no resumo do gate (4e) já que o "artefato principal" fica ausente.

**Regenerar a variante com imagens embutidas (#3546, mesmo script da Etapa 3c) e re-servir localmente antes do gate:**
```bash
npx tsx scripts/embed-images-base64.ts \
  --html data/monthly/$CYCLE/_internal/cloudflare-preview.html \
  --images data/monthly/$CYCLE/_internal/public-images.json \
  --edition-dir data/monthly/$CYCLE \
  --out data/monthly/$CYCLE/_internal/cloudflare-preview-embedded.html
```
`missing` no stdout = imagem sem arquivo local (mantém URL remota, não bloqueia) — logar warn se não-vazio (exit code 1 é só sinal de falha PARCIAL, não fatal — não abortar a etapa por causa dele).

**Re-servir localmente (#3546)** — mesmo padrão stop-old → serve-new da Etapa 3c (o conteúdo pode ter mudado desde 3c — `draft.md` editado no Drive/local, pull do 4a — então o servidor de lá fica STALE):
```bash
OLD_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/monthly/$CYCLE/_internal/preview-server-url.json','utf8')).preview_url_pid||'')}catch(e){}")
[ -n "$OLD_PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$OLD_PID"

npx tsx scripts/serve-preview.ts \
  --file data/monthly/$CYCLE/_internal/cloudflare-preview-embedded.html --port 0 \
  --persist-to data/monthly/$CYCLE/_internal/preview-server-url.json --field preview_url &
```
Rodar com `run_in_background: true`. Ler `preview_url` novo de `preview-server-url.json` pra popular `{preview_url}` no resumo do gate (4e) — diferente do Artifact, a URL muda a cada re-render (porta efêmera nova), nunca fica igual entre 3c e 4b.

### 4c. Lint do draft (sumarizado)

```bash
npx tsx scripts/lint-monthly-draft.ts --cycle $CYCLE
```

Exit 1 = **guardrail crítico (#2794) disparou** (labels de seção não reconhecidos ou sonda de imagem < 3 `<img>`) — NÃO prosseguir pro gate; voltar pra Etapa 2 e corrigir o draft (reforçar `**negrito**` nos labels), re-rodar 2b→2c→2d→4a→4b→4c. Exit 0 = ok (warnings de char-limit, se houver, são advisory — incluir no resumo do gate).

### 4d. Fact-check dos claims

Disparar `fact-checker` via `Agent` em modo mensal (#2793):

```
Agent({
  subagent_type: "fact-checker",
  prompt: "
    newsletter_path: data/monthly/$CYCLE/draft.md
    mode: monthly
    out_path: data/monthly/$CYCLE/_internal/04-fact-check.json
  "
})
```

Sem `social_path`/`approved_json_path` (não existem no mensal — o fact-checker extrai as URLs de fonte diretamente dos links ancorados dentro de cada `DESTAQUE N`, ver `.claude/agents/fact-checker.md` § Modo mensal). Sem auto-bloqueio — resultado vai pro resumo do gate (4e).

### 4e. Resumo consolidado + gate humano (pulado com `--no-gate`)

Apresentar ao editor:

```
📋 Revisão consolidada — Diar.ia Mensal {YYMM}

🌐 Preview completo (local): {preview_url}

Lint (scripts/lint-monthly-draft.ts):
  Guardrail de render: {N} seções reconhecidas, {N}/3 <img> na sonda — OK
  D1: {chars} / 1.500 {✓|⚠}
  D2: {chars} / 1.200 {✓|⚠}
  D3: {chars} / 1.200 {✓|⚠}

Fact-check (_internal/04-fact-check.json):
  {total} claims verificados — {sustained} sustentados, {attention_items} pedem atenção
  {listar DIVERGENT + superlativos não-sustentados, se houver}

⚠️  Seções CLARICE — DIVULGAÇÃO e CLARICE — TUTORIAL são PLACEHOLDERS
    ([Placeholder — inserir aqui...]) — preenchidas manualmente pela Clarice
    antes do envio real, NÃO pelo pipeline. O preview acima mostra o
    placeholder literal, não o conteúdo final dessas 2 seções.

Aprovar? sim / editar / retry
```

- `editar` → editor edita `draft.md` local/Drive; re-rodar 4a→4b→4c→4d após confirmação (4b já encerra o servidor de preview anterior e sobe um novo — sem teardown manual aqui).
- `retry` → re-rodar 4b→4c→4d (mesmo draft, novo preview/lint/fact-check — útil se só o preview falhou em 4b; mesmo stop-old→serve-new de 4b).

Após aprovação (`sim`), encerrar o servidor de preview local (#3546 — Etapa 5 não precisa dele, publica direto no Brevo) E a aba do Chrome (#3700 — mesma causa raiz do diário: `--stop-pid` só mata o processo, nunca a aba que `navigate` abriu, e ela fica órfã apontando pro loopback morto até o Chrome a reabrir num "Continuar de onde parei"), e gravar o checkpoint (#2795):

Em modo `local`, fechar a aba ANTES de matar o processo (best-effort, nunca bloqueante):
1. `mcp__claude-in-chrome__tabs_context_mcp` — listar as abas do grupo MCP atual.
2. Para a aba cujo `tabId` bata com `preview_url_tab_id` (`preview-server-url.json`), OU cuja URL aponte pra `127.0.0.1` **excluindo explicitamente a porta `4174` (porta fixa default do Studio, `scripts/studio-ui/server.ts` — excluir sempre, mesmo sem Studio rodando nesta sessão; nunca varrer `127.0.0.1` sem esse filtro, #3727)** (fallback — pega aba de um `retry`/`editar` anterior sem `tabId` persistido; os preview servers do próprio pipeline usam porta efêmera OS-assigned via `serve-preview.ts --port 0`, nunca `4174`, então a exclusão nunca esconde uma aba de preview legítima): (a) **página-cortina** — `mcp__claude-in-chrome__navigate` com `url: "about:blank"` nesse `tabId`; (b) `mcp__claude-in-chrome__tabs_close_mcp` nesse `tabId`.
3. Nenhuma aba encontrada, ou MCP indisponível: pular sem erro. Em `cloud`: pular inteiramente.

   **Exceção consciente ao #738 (CLAUDE.md)** — #3732: o `claude-in-chrome` indisponível/desconectado AQUI (só neste passo de teardown pós-gate, nunca no fluxo principal da Etapa 4) não renderiza halt banner nem aguarda resposta. Racional: o gate humano já foi respondido (`sim` — o editor já aprovou) antes deste passo rodar; falhar a limpeza de uma aba órfã não deveria reverter ou travar uma aprovação que o editor já deu. O #738 nunca listou este passo de teardown como dependente do Chrome MCP. Mesmo padrão de exceção documentada já usado pro Gmail MCP no relatório final de `/diaria-overnight` (`.claude/skills/diaria-overnight/SKILL.md`, regra 4 da seção de relatório) e pro teardown equivalente do orchestrator diário (`.claude/agents/orchestrator-stage-4.md`, §4d) — não citar esta exceção como precedente fora deste passo específico de teardown.

```bash
PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/monthly/$CYCLE/_internal/preview-server-url.json','utf8')).preview_url_pid||'')}catch(e){}")
[ -n "$PID" ] && npx tsx scripts/serve-preview.ts --stop-pid "$PID"

npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step 4 --dir "data/monthly/$CYCLE" --outputs "_internal/04-fact-check.json"
```

---

## Etapa 5 — Publicação Brevo

**Resume check:** `_internal/05-published.json` existe com `status: "test_sent"` → pular para o gate.

### 5a. Drive sync pull

Pull do `draft.md` antes de converter (editor pode ter editado no Drive após Etapa 4):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/monthly/$CYCLE/ --stage 5 --files draft.md
```

Warning se falhar, nunca bloqueia.

### 5b. Verificar pré-requisitos do Brevo

Antes de rodar o script, verificar se `brevo_monthly.list_id` e `brevo_monthly.sender_email` estão preenchidos:

```bash
node -e "
  const c = JSON.parse(require('fs').readFileSync('platform.config.json','utf8')).brevo_monthly;
  const missing = [];
  if (!c.list_id) missing.push('list_id');
  if (!c.sender_email) missing.push('sender_email');
  if (missing.length) {
    console.error('ERRO: campos não configurados em platform.config.json → brevo_monthly:', missing.join(', '));
    console.error('Completar checklist de #653 antes de prosseguir.');
    process.exit(1);
  }
  console.log('ok');
"
```

Se falhar com `ERRO: campos não configurados`, apresentar ao editor:

```
⛔ Publicação Brevo bloqueada: {campos} não configurados em platform.config.json.

Para desbloquear, complete a configuração da conta Brevo (#653):
  1. Criar lista de contatos no painel Brevo → copiar o ID numérico
  2. Verificar o email remetente no painel Brevo
  3. Preencher em platform.config.json → brevo_monthly: { list_id: <ID>, sender_email: "<email>" }
  4. Garantir que BREVO_CLARICE_API_KEY está definido no .env

Alternativa manual: abrir https://app.brevo.com e criar a campanha manualmente colando draft.md.
```

Encerrar Etapa 5 (não é bloqueio de pipeline — editor pode publicar manualmente).

### 5c. Criar campanha e enviar email de teste

```bash
npx tsx scripts/publish-monthly.ts --cycle $CYCLE --send-test
```

O script:
- Converte `draft.md` para HTML de email
- Usa o subject de `_internal/02-chosen-subject.txt` (se existir) ou a opção 1 do ASSUNTO
- Cria campanha Brevo como rascunho
- Envia email de teste para `platform.config.json → brevo_monthly.test_email`
- Salva `_internal/05-published.json`

Se o script falhar com erro de API:
- Verificar que `BREVO_CLARICE_API_KEY` está definido e é válido
- Se `list_id` ou `sender_email` ainda nulos: ver mensagem de bloqueio acima
- Se erro HTTP 4xx da API Brevo: exibir mensagem completa ao editor e encerrar (não retry)

### 5d. Revisar email de teste

Disparar `review-test-email` via `Agent`:

```
Agent({
  subagent_type: "review-test-email",
  prompt: "
    test_email: {brevo_monthly.test_email de platform.config.json}
    edition_title: {subject de _internal/05-published.json}
    edition_dir: data/monthly/$CYCLE/
    attempt: 1
    platform: brevo
  "
})
```

O agente busca o email de teste via Gmail MCP (from:brevo.com) e verifica a estrutura mensal.

Se `review-test-email` retornar `issues` não-vazias, exibir ao editor junto com o gate.

### Gate Etapa 5 (pulado com `--no-gate`)

Ler `_internal/05-published.json` e apresentar:

```
📧 Campanha Brevo criada e email de teste enviado.

Assunto: {subject}
Preview: {preview_text}
Dashboard: {brevo_dashboard_url}
Teste enviado para: {test_email}

{se issues do review-test-email → listar aqui}

Próximos passos manuais (Etapa Clarice):
  1. Abrir o dashboard Brevo acima
  2. Conferir que renderizaram automaticamente (#1916/#1918): imagens 2x1 de
     D1/D2/D3, imagens do É IA?, e os boxes "Desconto exclusivo" + "Laboratório
     Clarice" (vêm do draft, não precisam mais ser preenchidos/adicionados à mão)
  3. Revisar e enviar para a lista de contatos da Clarice

Aprovado? sim / retry (regenerar campanha)
```

- `retry` → re-rodar 5c com nova campanha (o script sempre cria uma campanha nova; a anterior fica como rascunho no Brevo e pode ser deletada manualmente)
- `sim` → encerrar pipeline mensal

Após aprovação (`sim`), gravar o checkpoint final (#2795):
```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $CYCLE --step 5 --dir "data/monthly/$CYCLE" --outputs "_internal/05-published.json"
```

---

## Outputs

Todos em `data/monthly/{ciclo}/` (ex: `data/monthly/2605-06/`):

- `_internal/raw-destaques.json` — coleta bruta (Etapa 1)
- `_internal/monthly-clicks.json` — ranking por cliques Use Melhor + Radar (Etapa 1d)
- `prioritized.md` — destaques aprovados + Use Melhor + Radar (Etapa 1)
- `draft.md` — texto final (Etapa 2)
- `_internal/02-d1-prompt.md` — prompt imagem D1 (Etapa 2)
- `04-d1-2x1.jpg` + `04-d1-1x1.jpg` — imagem D1 (Etapa 3)
- `01-eia.md` + `01-eia-A.jpg` + `01-eia-B.jpg` — É IA? novo (Etapa 3)
- `_internal/cloudflare-preview.html` — pré-render completo com URLs reais (Etapa 4)
- `_internal/public-images.json` — manifest url pública → filename local, input do embed base64 (Etapa 3/4, #3392)
- `_internal/cloudflare-preview-embedded.html` — variante com imagens embutidas em base64, servida localmente via `serve-preview.ts` no gate (Etapa 3/4, #3546 — CSP fix original #3392 espelhando o diário #3370)
- `_internal/preview-server-url.json` — URL + PID do servidor de preview local corrente (Etapa 3/4, #3546 — efêmero, não sobrevive entre sessões)
- `_internal/04-fact-check.json` — claims verificados (Etapa 4)
- `_internal/.step-N-done.json` (N=1..5) — checkpoints de conclusão por etapa, mesmo formato do diário (#2795)
- `_internal/05-published.json` — campanha Brevo criada (Etapa 5)

## Notas

- **Apenas manual** — sem agendamento automático.
- **Publicação final é responsabilidade da Clarice** — o pipeline cria o rascunho, eles preenchem as seções de divulgação e enviam para a lista deles.
- **Brevo list_id e sender_email** precisam estar configurados em `platform.config.json → brevo_monthly` (#653). Se nulos, Etapa 5 exibe instruções e encerra sem bloquear.
- **Retrocompat de ciclos legados (#2795):** ciclos processados antes desta renumeração não têm `_internal/.step-N-done.json` nem `_internal/04-fact-check.json`. O resume check (acima) degrada graciosamente: sentinel ausente + output legado em disco (`draft.md`, `04-d1-2x1.jpg`, etc.) → tratado como etapa completa via fallback exit 3 do `pipeline-sentinel.ts assert`; sentinel ausente + Etapa 4 nunca tendo rodado (ciclo pré-#2793) → a ausência de `_internal/04-fact-check.json` faz a Etapa 4 rodar normalmente antes da Etapa 5 (idempotente e não-destrutivo — só produz um preview/lint/fact-check novos sobre o `draft.md`/imagens já existentes).

## Fluxo multi-campanha Clarice (canônico — #2009)

O fluxo `clarice-build-edition-sends → clarice-split-cells → clarice-schedule-sends` é o caminho **canônico** para ciclos com múltiplos envios (S1 A/B/C + S2/S3). O `publish-monthly.ts` (Etapa 5 acima) é o fluxo legado e será removido em release futuro.

**Passo obrigatório antes do `clarice-schedule-sends --schedule`**: setar o gabarito do É IA?:

```bash
npx tsx scripts/close-poll.ts --brand clarice --cycle $CYCLE --edition {AAMMDD} [--answer A|B]
```

Onde `{AAMMDD}` é a data da edição diária selecionada pelo É IA? mensal (ex: `260531`). Se `--answer` for omitido, lê `ai_side` de `data/editions/{AAMMDD}/_internal/01-eia-meta.json`.

Este comando grava `data/monthly/$CYCLE/_internal/.close-poll-clarice.json`. Sem ele, `clarice-schedule-sends --schedule` falhará com:

```
❌  ERRO: gabarito É IA? não setado para o ciclo {cycle}.
```

Para pular a verificação (não recomendado): `clarice-schedule-sends --schedule --skip-eia-guard`.

**Test-loop no fluxo multi-campanha**: usar `clarice-schedule-sends --send-test` antes do `--schedule`. Envia test email das células `d01-A/B/C` (S1) ou `d08` (S2/S3) para `brevo_monthly.test_email`. Disparar `review-test-email` via Agent após (mesmo fluxo da Etapa 5d acima).
