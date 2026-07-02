---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + Use Melhor (3 tutoriais mais clicados) + Radar (7 links mais clicados). Uso — `/diaria-mensal --cycle YYMM-MM [--no-gate]` ou legado `/diaria-mensal YYMM`. 4 etapas com gate ao final de cada uma; publicação Beehiiv é follow-up (#188).
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

## Pré-requisitos

- Beehiiv MCP funcional (conector nativo do Claude Code).
- `platform.config.json → beehiiv.publicationId` populado.
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

**Não há dependência de `data/editions/{AAMMDD}/` local.** O digest puxa direto do Beehiiv, funcionando em qualquer máquina.

## Resume check global

Antes de iniciar, verificar o estado do disco (de baixo para cima):

- `01-eia.md` + `04-d1-2x1.jpg` existem → Etapa 3 completa. Pular para Etapa 4.
- `draft.md` existe → Etapa 2 completa. Pular para Etapa 3.
- `prioritized.md` existe → Etapa 1 completa. Pular para Etapa 2.
- Caso contrário → começar pela Etapa 1.

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

---

## Etapa 2 — Escrita

Disparar `writer-monthly` via `Agent`:
- `prioritized_path = data/monthly/$CYCLE/prioritized.md`
- `raw_path = data/monthly/$CYCLE/_internal/raw-destaques.json`
- `out_path = data/monthly/$CYCLE/draft.md`
- `yymm = ${CYCLE:0:4}`

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

---

## Etapa 3 — Imagens

**Resume check:** `04-d1-2x1.jpg` e `01-eia.md` existem → pular Etapa 3, ir para Etapa 4.

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

**É IA? mensal (#1912):** seleciona a edição diária do mês cujo poll teve a
taxa de acerto **mais próxima de 50%** (o É IA? que mais dividiu os leitores —
melhor pro recap mensal). Fallback automático ao último dia se nenhum poll for
elegível (gabarito + ≥5 votos). A tabela de candidatos vai pro stderr (auditoria).
```bash
EAI_EDITION=$(npx tsx scripts/select-eia-edition.ts --month ${CYCLE:0:4})
npx tsx scripts/eia-compose.ts --edition $EAI_EDITION --out-dir data/monthly/$CYCLE/
```
Se falhar (sem imagem elegível), registrar warn e seguir — É IA? é opcional.

### 3c. Preview Cloudflare (#1914)

Com as imagens prontas, publicar o preview público no worker `draft` (como a
diária) — o editor revisa o render real no celular antes do Brevo. Usa o design
da mensal (`draftToEmail`), sobe as imagens do É IA? pro KV e mescla a legenda
do `01-eia.md`:
```bash
npx tsx scripts/monthly-preview-cloudflare.ts --cycle $CYCLE
```
Imprime a URL `https://draft.diaria.workers.dev/m{YYMM}-{MM}`. Falha = warning,
não bloqueia. Requer `ADMIN_SECRET` + `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN`.

### Gate Etapa 3 (pulado com `--no-gate`)

Drive sync push: `04-d1-2x1.jpg,04-d1-1x1.jpg,01-eia-A.jpg,01-eia-B.jpg`.

Apresentar:
```
📸 D1: data/monthly/$CYCLE/04-d1-2x1.jpg
🤔 É IA? A: data/monthly/$CYCLE/01-eia-A.jpg
🤔 É IA? B: data/monthly/$CYCLE/01-eia-B.jpg
🌐 Preview: https://draft.diaria.workers.dev/m{YYMM}-{MM}

Aprovar? sim / regenerar-d1 / regenerar-eia
```

---

## Etapa 4 — Publicação Brevo

**Resume check:** `_internal/05-published.json` existe com `status: "test_sent"` → pular para o gate.

### 4a. Drive sync pull

Pull do `draft.md` antes de converter (editor pode ter editado no Drive após Etapa 2):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/monthly/$CYCLE/ --stage 4 --files draft.md
```

Warning se falhar, nunca bloqueia.

### 4b. Verificar pré-requisitos do Brevo

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

Encerrar Etapa 4 (não é bloqueio de pipeline — editor pode publicar manualmente).

### 4c. Criar campanha e enviar email de teste

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

### 4d. Revisar email de teste

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

### Gate Etapa 4 (pulado com `--no-gate`)

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

- `retry` → re-rodar 4c com nova campanha (o script sempre cria uma campanha nova; a anterior fica como rascunho no Brevo e pode ser deletada manualmente)
- `sim` → encerrar pipeline mensal

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
- `_internal/05-published.json` — campanha Brevo criada (Etapa 4)

## Notas

- **Apenas manual** — sem agendamento automático.
- **Publicação final é responsabilidade da Clarice** — o pipeline cria o rascunho, eles preenchem as seções de divulgação e enviam para a lista deles.
- **Brevo list_id e sender_email** precisam estar configurados em `platform.config.json → brevo_monthly` (#653). Se nulos, Etapa 4 exibe instruções e encerra sem bloquear.

## Fluxo multi-campanha Clarice (canônico — #2009)

O fluxo `clarice-build-edition-sends → clarice-split-cells → clarice-schedule-sends` é o caminho **canônico** para ciclos com múltiplos envios (S1 A/B/C + S2/S3). O `publish-monthly.ts` (Etapa 4 acima) é o fluxo legado e será removido em release futuro.

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

**Test-loop no fluxo multi-campanha**: usar `clarice-schedule-sends --send-test` antes do `--schedule`. Envia test email das células `d01-A/B/C` (S1) ou `d08` (S2/S3) para `brevo_monthly.test_email`. Disparar `review-test-email` via Agent após (mesmo fluxo da Etapa 4d acima).
