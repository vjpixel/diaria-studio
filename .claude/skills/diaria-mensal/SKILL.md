---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + 10 Outras Notícias. Uso — `/diaria-mensal YYMM [--no-gate]`. 4 etapas com gate ao final de cada uma; publicação Beehiiv é follow-up (#188).
---

# /diaria-mensal

Produz uma edição **mensal** da Diar.ia consolidando os destaques publicados nas edições diárias do mês escolhido.

## Argumentos

- `$1` = mês no formato `YYMM` (ex: `2604` = abril 2026). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir mês atual / mês anterior como atalhos mas exigir confirmação:

  > "Você não passou o mês da edição mensal. Qual mês quer processar? mês atual ({YYMM_atual}) / mês anterior ({YYMM_anterior}) / outro (informe YYMM)"

- `--no-gate` (opcional) = pular todos os gates humanos. Auto-aprova cada etapa e prossegue direto ao final.

## Pré-requisitos

- Beehiiv MCP funcional (conector nativo do Claude Code).
- `platform.config.json → beehiiv.publicationId` populado.
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

**Não há dependência de `data/editions/{AAMMDD}/` local.** O digest puxa direto do Beehiiv, funcionando em qualquer máquina.

## Resume check global

Antes de iniciar, verificar o estado do disco (de baixo para cima):

- `01-eai.md` + `04-d1-2x1.jpg` existem → Etapa 3 completa. Pular para Etapa 4.
- `draft.md` existe → Etapa 2 completa. Pular para Etapa 3.
- `prioritized.md` existe → Etapa 1 completa. Pular para Etapa 2.
- Caso contrário → começar pela Etapa 1.

---

## Etapa 1 — Coleta e Análise

### 1a. Coleta via Beehiiv MCP

**Resume check (#400):**
```bash
RAW_POSTS=$(ls data/monthly/$1/raw-posts/*.txt 2>/dev/null | wc -l)
RAW_DESTAQUES=$(test -f data/monthly/$1/raw-destaques.json && echo "yes" || echo "no")
```
- `RAW_POSTS > 0` e `RAW_DESTAQUES = yes` → pular 1a e 1b.
- `RAW_POSTS > 0` e `RAW_DESTAQUES = no` → pular 1a, executar 1b.
- `RAW_POSTS = 0` → executar 1a e 1b (mesmo que `raw-destaques.json` exista — pode ser de run anterior via fallback local, #400).

**Coleta (inline — não via subagente, #403):** Chamar os MCPs Beehiiv **diretamente** neste contexto:
1. `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_posts` — `publication_id`, `status="confirmed"`, `per_page=50`. Paginar e filtrar client-side pela janela do mês `[$1]`.
2. Para cada post: derivar `AAMMDD` do `published_at`, `id_prefix` (8 chars sem `post_`). Path: `data/monthly/$1/raw-posts/post_{id_prefix}_{AAMMDD}.txt`. Pular se já existe (resume). Caso contrário: `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__get_post_content` → gravar `markdown` (preferido) ou `html` (fallback).

Se `posts_found = 0`, abortar.

**Parse:**
```bash
npx tsx scripts/collect-monthly.ts $1
```
Se `destaques_count < 3`, abortar.

### 1b. Scoring mensal

**Resume check:** verificar se todos os destaques em `raw-destaques.json` já têm o campo `score` não-nulo. Se sim, pular.

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('data/monthly/$1/raw-destaques.json','utf8')); const missing=d.destaques.filter(x=>x.score==null).length; console.log(missing===0?'scored':'missing:'+missing)"
```

Se `missing > 0`, disparar `scorer-monthly` via `Agent`:
- `raw_path = data/monthly/$1/raw-destaques.json`
- `out_path = data/monthly/$1/raw-destaques.json`

O scorer sobrescreve o arquivo adicionando `score` a cada destaque.

### 1c. Análise temática

Disparar `analyst-monthly` via `Agent`:
- `raw_path = data/monthly/$1/raw-destaques.json`
- `out_path = data/monthly/$1/prioritized.md`
- `yymm = $1`

### Gate Etapa 1 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$1/ --stage 1 --files prioritized.md` (warning se falhar, nunca bloqueia).

Apresentar ao editor:
```
D1: {tema} ({N} artigos)
D2: {tema} ({N} artigos)
D3: {tema} ({N} artigos)
Outras Notícias: {N} itens

Aprovar? sim / editar / retry
```
- `editar` → editor edita `prioritized.md` local/Drive; re-rodar analista após confirmação.
- `retry` → re-disparar `analyst-monthly`.

---

## Etapa 2 — Escrita

Disparar `writer-monthly` via `Agent`:
- `prioritized_path = data/monthly/$1/prioritized.md`
- `raw_path = data/monthly/$1/raw-destaques.json`
- `out_path = data/monthly/$1/draft.md`
- `yymm = $1`

O agente escreve `draft.md` + gera `_internal/02-d1-prompt.md` (prompt Van Gogh impasto do D1 para Etapa 3).

### 2b. Lint de chars

```bash
npx tsx scripts/lint-monthly-draft.ts $1
```

Emite warnings (não bloqueia) se D1 > 1.500 ou D2/D3 > 1.200 chars.

### 2c. Humanizador

Invocar skill humanizador in-place no `draft.md`:

```
Skill("humanizador", "Leia data/monthly/$1/draft.md, humanize o texto removendo marcas de IA em português, calibrando a voz com context/past-editions.md como referência, e salve o resultado no mesmo arquivo.")
```

Se falhar: warning, seguir com o arquivo original (não bloqueia).

### 2d. Clarice

1. Ler `data/monthly/$1/draft.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. Salvar sugestões: `data/monthly/$1/_internal/02-clarice-suggestions.json`.
4. Aplicar:
```bash
npx tsx scripts/clarice-apply.ts \
  --text-file data/monthly/$1/draft.md \
  --suggestions data/monthly/$1/_internal/02-clarice-suggestions.json \
  --out data/monthly/$1/draft.md \
  --report data/monthly/$1/_internal/02-clarice-report.json
```

Se `clarice-apply.ts` falhar: warning, seguir com o arquivo original (não bloqueia).

### Gate Etapa 2 (pulado com `--no-gate`)

Drive sync push: `npx tsx scripts/drive-sync.ts --mode push --edition-dir data/monthly/$1/ --stage 2 --files draft.md,_internal/02-d1-prompt.md,_internal/02-chosen-subject.txt` — **warning se falhar, nunca bloqueia**. (`02-chosen-subject.txt` só existe se o editor tiver escolhido o subject no gate; `02-d1-prompt.md` só existe se o writer tiver gerado o prompt de imagem.)

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

**Após aprovação (#421):** se o editor informar o número do subject escolhido, salvar a linha escolhida em `data/monthly/$1/_internal/02-chosen-subject.txt`. Exemplo: `echo "2" > data/monthly/$1/_internal/02-chosen-subject.txt`.

**Invariante do ASSUNTO:** qualquer passo posterior que modifique `draft.md` (humanizador, Clarice, ajustes de formato) deve usar `Edit` (substituição pontual), nunca `Write` (overwrite completo). Se `Write` for inevitável, ler `02-chosen-subject.txt` antes e restaurar o ASSUNTO correto imediatamente após. O ASSUNTO escolhido pelo editor nunca pode ser sobrescrito silenciosamente.

---

## Etapa 3 — Imagens

**Resume check:** `04-d1-2x1.jpg` e `01-eai.md` existem → pular Etapa 3, ir para Etapa 4.

Disparar **em paralelo** (mesma mensagem):

**D1:**
```bash
npx tsx scripts/image-generate.ts \
  --editorial data/monthly/$1/_internal/02-d1-prompt.md \
  --out-dir data/monthly/$1/ \
  --destaque d1
```
Se `_internal/02-d1-prompt.md` não existir, emitir aviso e pular (não bloquear).

**É IA? mensal (novo):**
```bash
EAI_EDITION=$(node -e "
  const y='$1', yr=2000+parseInt(y.slice(0,2)), mo=parseInt(y.slice(2,4));
  const last=new Date(Date.UTC(yr,mo,0)).getUTCDate();
  process.stdout.write(String(yr).slice(2)+String(mo).padStart(2,'0')+String(last).padStart(2,'0'));
")
npx tsx scripts/eai-compose.ts --edition $EAI_EDITION --out-dir data/monthly/$1/
```
Se falhar (sem imagem elegível), registrar warn e seguir — É IA? é opcional.

### Gate Etapa 3 (pulado com `--no-gate`)

Drive sync push: `04-d1-2x1.jpg,04-d1-1x1.jpg,01-eai-A.jpg,01-eai-B.jpg`.

Apresentar:
```
📸 D1: data/monthly/$1/04-d1-2x1.jpg
🤔 É IA? A: data/monthly/$1/01-eai-A.jpg
🤔 É IA? B: data/monthly/$1/01-eai-B.jpg

Aprovar? sim / regenerar-d1 / regenerar-eai
```

---

## Etapa 4 — Publicação

```
⚠️ Publicação automática Beehiiv não implementada (issue #188 — follow-up).
Para publicar: copiar `data/monthly/{YYMM}/draft.md` manualmente para o
editor Beehiiv como rascunho. Revisar e enviar.
```

---

## Outputs

Todos em `data/monthly/{YYMM}/`:

- `raw-destaques.json` — coleta bruta (Etapa 1)
- `prioritized.md` — destaques aprovados (Etapa 1)
- `draft.md` — texto final (Etapa 2)
- `_internal/02-d1-prompt.md` — prompt imagem D1 (Etapa 2)
- `04-d1-2x1.jpg` + `04-d1-1x1.jpg` — imagem D1 (Etapa 3)
- `01-eai.md` + `01-eai-A.jpg` + `01-eai-B.jpg` — É IA? novo (Etapa 3)

## Notas

- **Apenas manual** — sem agendamento automático.
- **Publicação Beehiiv** é follow-up (#188) — não bloqueia o uso do digest.
