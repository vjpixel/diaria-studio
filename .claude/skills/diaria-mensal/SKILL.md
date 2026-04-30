---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + 10 Outras Notícias. Uso — `/diaria-mensal YYMM [--no-gate]`. Phase 1+2 implementadas (collect → analyst → gate → writer → imagem D1 → É IA? novo → gate imagens); publicação Beehiiv é follow-up. Veja issue #188. #188.
---

# /diaria-mensal

Produz uma edição **mensal** da Diar.ia consolidando os destaques publicados nas edições diárias do mês escolhido.

## Argumentos

- `$1` = mês no formato `YYMM` (ex: `2604` = abril 2026). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir mês atual / mês anterior como atalhos mas exigir confirmação:

  > "Você não passou o mês da edição mensal. Qual mês quer processar? mês atual ({YYMM_atual}) / mês anterior ({YYMM_anterior}) / outro (informe YYMM)"

- `--no-gate` (opcional) = pular o gate humano sobre o `prioritized.md`. Auto-aprova a proposta do `analyst-monthly` e prossegue direto pro `writer-monthly`.

## Pré-requisitos

- Beehiiv MCP funcional (conector nativo do Claude Code, mesmo usado por `refresh-dedup-runner` e `diaria-atualiza-audiencia`).
- `platform.config.json → beehiiv.publicationId` populado (caso contrário, o agent `collect-monthly-runner` resolve via `list_publications` no primeiro passo).
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

**Não há dependência de `data/editions/{AAMMDD}/` local.** O digest puxa direto do Beehiiv (source-of-truth do publicado), funcionando em qualquer máquina.

## Phase 1 (implementada)

### Stage 1 — Coleta

Coleta tem dois sub-passos: (1a) baixar markdown bruto via Beehiiv MCP, (1b) parsear destaques.

**Resume check Stage 1 (#400):** Antes de qualquer coisa, verificar o estado do disco:

```bash
RAW_POSTS=$(ls data/monthly/$1/raw-posts/*.txt 2>/dev/null | wc -l)
RAW_DESTAQUES=$(test -f data/monthly/$1/raw-destaques.json && echo "yes" || echo "no")
```

- Se `RAW_POSTS > 0` **e** `RAW_DESTAQUES = yes` → ambos os sub-passos completos. Pular para Stage 2.
- Se `RAW_POSTS > 0` **e** `RAW_DESTAQUES = no` → Stage 1a completo, 1b não rodou. Pular Stage 1a, executar Stage 1b.
- Se `RAW_POSTS = 0` → Stage 1a não completou. Executar Stage 1a normalmente, independente de `raw-destaques.json` existir.
  - ⚠️ **Não usar `raw-destaques.json` como indicador de Stage 1a completo** — pode ter sido gerado por run anterior via fallback de edições locais (antes de `collect-monthly-runner` existir), sem nunca ter consultado o Beehiiv.

**1a. Baixar via Beehiiv MCP (inline — não via subagente) (#403):**

Chamar as ferramentas Beehiiv MCP **diretamente** neste contexto (sem disparar Agent). Subagentes não têm acesso aos MCPs nativos do Claude Code — este é o contexto correto para chamá-los.

1. Chamar `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_posts` com:
   - `publication_id = beehiiv.publicationId` (de `platform.config.json`)
   - `status = "confirmed"`
   - `per_page = 50`
   - Paginar e filtrar client-side pela janela do mês `[$1]`
2. Para cada post dentro da janela:
   - Derivar `AAMMDD` do `published_at` e `id_prefix` (8 chars, sem prefixo `post_`)
   - Path: `data/monthly/$1/raw-posts/post_{id_prefix}_{AAMMDD}.txt`
   - Se já existe: pular (resume-aware)
   - Caso contrário: chamar `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__get_post_content` e gravar o `markdown` (preferido) ou `html` (fallback)
3. Criar diretório `data/monthly/$1/raw-posts/` antes de gravar (se não existir)
4. Reportar: `posts_found`, `downloaded`, `skipped_existing`, `posts_with_html_fallback`, `warnings`

Se `posts_found = 0`, abortar — o mês não tem edições publicadas no Beehiiv.

**1b. Parsear destaques** — disparar `Bash`:

```bash
npx tsx scripts/collect-monthly.ts $1
```

O script lê os raw-posts, extrai até 3 destaques por edição (h5 categoria + h1 link como discriminador), enriquece com flag 🇧🇷 (categoria BRASIL = sinal forte; reforço por host e keywords), e grava `data/monthly/{yymm}/raw-destaques.json`.

Reportar ao usuário:
- `editions_count` (quantas edições contribuíram)
- `destaques_count` (esperado: editions_count × 3)
- `is_brazil` count
- Warnings (edições com parse incompleto, formato inesperado, etc.)

Se `destaques_count < 3`, abortar com mensagem clara: o mês não tem destaques suficientes pra um digest mensal.

### Stage 2 — Análise temática

Disparar o subagente `analyst-monthly` via `Agent`, passando no prompt:
- `raw_path = data/monthly/$1/raw-destaques.json`
- `out_path = data/monthly/$1/prioritized.md`
- `yymm = $1`

O agente lê os destaques, agrupa por tema, garante Brasil como um dos 3, propõe títulos narrativos e gera `prioritized.md`.

Reportar ao usuário:
- 3 temas escolhidos com contagem de artigos de suporte
- Outras Notícias (10 standalone)
- Warnings (ex: `⚠️ Poucos destaques específicos do Brasil este mês`)

### Stage 3 — Drive sync push (push do `prioritized.md`)

Estrutura de Drive: `Work/Startups/diar.ia/edicoes/{YYMM}/{YYMM}/` (pasta da edição mensal **dentro** da pasta do mês).

Ler `platform.config.json` → `drive_sync` (default `true`). Se `true`, tentar push via `scripts/drive-sync.ts`. Se o script ainda não suportar a estrutura mensal, marcar como warning e seguir (Phase 2 follow-up).

Falha de sync vira warning, **nunca bloqueia**.

### Stage 4 — Gate humano (pulado com `--no-gate`)

**Se `--no-gate`:** copiar `prioritized.md` direto pro próximo stage (sem pausa).

**Caso contrário:** apresentar o `prioritized.md` ao usuário e pedir aprovação:

```
Prioritized.md para o digest mensal {YYMM}:

D1: {tema 1} ({N} artigos)
D2: {tema 2} ({N} artigos)
D3: {tema 3} ({N} artigos)
Outras Notícias: {N} itens (top 10 standalones)

{warnings se houver}

Aprovar? sim / editar / retry
```

- `sim` → prosseguir.
- `editar` → o usuário edita `prioritized.md` direto no Drive ou local. Após edição, re-rodar a partir do Stage 5.
- `retry` → re-disparar o `analyst-monthly` (útil se a proposta inicial ficou ruim).

### Stage 5 — Writing

Disparar o subagente `writer-monthly` via `Agent`, passando:
- `prioritized_path = data/monthly/$1/prioritized.md`
- `raw_path = data/monthly/$1/raw-destaques.json`
- `out_path = data/monthly/$1/draft.md`
- `yymm = $1`

O agente lê o prioritized aprovado, escreve a edição mensal completa em `draft.md` (com 3 opções de subject auto-geradas).

Reportar ao usuário:
- 3 opções de subject line
- Preview line
- Tamanho aproximado do draft (chars / palavras)

### Stage 6 — Drive sync push (`draft.md`)

Mesmo procedimento do Stage 3, agora com `draft.md`.

### Stage 7 — Gate humano sobre o draft (pulado com `--no-gate`)

**Se `--no-gate`:** prosseguir direto.

**Caso contrário:** apresentar `draft.md` ao usuário pra revisão final. Aprovar / editar / retry.

## Phase 2 (imagens — implementada; publicação Beehiiv — follow-up #188)

### Stage 8 — Imagem D1 + É IA? mensal (em paralelo)

**Resume check:** Se `04-d1-2x1.jpg` **e** `01-eai.md` já existem → pular Stage 8 direto para o gate.

Disparar **em paralelo**:

**8a. Imagem D1:**

```bash
npx tsx scripts/image-generate.ts \
  --editorial data/monthly/$1/_internal/02-d1-prompt.md \
  --out-dir data/monthly/$1/ \
  --destaque d1
```

Outputs: `04-d1-2x1.jpg` (1600×800) + `04-d1-1x1.jpg` (800×800). Se `_internal/02-d1-prompt.md` não existir (writer-monthly antigo), emitir aviso e pular — não bloquear.

**8b. É IA? mensal (novo):**

Derivar o último dia do mês a partir de `$1` (YYMM):

```bash
EAI_EDITION=$(node -e "
  const yymm='$1';
  const year=2000+parseInt(yymm.slice(0,2));
  const month=parseInt(yymm.slice(2,4));
  const lastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
  const yy=String(year).slice(2);
  const mm=String(month).padStart(2,'0');
  const dd=String(lastDay).padStart(2,'0');
  process.stdout.write(yy+mm+dd);
")
npx tsx scripts/eai-compose.ts \
  --edition $EAI_EDITION \
  --out-dir data/monthly/$1/
```

Outputs em `data/monthly/$1/`: `01-eai.md`, `01-eai-A.jpg`, `01-eai-B.jpg`, `_internal/01-eai-meta.json`.

Se `eai-compose.ts` falhar (sem imagem elegível), registrar warn e seguir — É IA? é opcional no mensal.

### Stage 9 — Gate imagens (pulado com `--no-gate`)

**Se `--no-gate`:** prosseguir direto.

**Caso contrário:** apresentar ao editor:

```
📸 Imagem D1: data/monthly/$1/04-d1-2x1.jpg
🤔 É IA? A: data/monthly/$1/01-eai-A.jpg
🤔 É IA? B: data/monthly/$1/01-eai-B.jpg

Aprovar? sim / regenerar-d1 / regenerar-eai / retry
```

- `sim` → concluído.
- `regenerar-d1` → re-rodar Stage 8a apenas.
- `regenerar-eai` → re-rodar Stage 8b apenas (novo `--force`).

### Stage 10 — Publicação Beehiiv (follow-up)

```
⚠️ Publicação automática Beehiiv não implementada (issue #188 — follow-up).
Para publicar: copiar `data/monthly/{YYMM}/draft.md` manualmente para o
editor Beehiiv como rascunho. Revisar e enviar.
```

## Outputs

Todos em `data/monthly/{YYMM}/` (ex: `data/monthly/2604/`):

- `raw-destaques.json` — coleta bruta com metadata estruturada
- `prioritized.md` — proposta do analista (revisada no gate)
- `draft.md` — texto final pra publicação
- `_internal/02-d1-prompt.md` — prompt editorial da imagem D1 (gerado pelo writer-monthly)
- `04-d1-2x1.jpg` + `04-d1-1x1.jpg` — imagem D1 (Stage 8a)
- `01-eai.md` + `01-eai-A.jpg` + `01-eai-B.jpg` — É IA? mensal novo (Stage 8b)
- `published.json` — metadata da publicação Beehiiv (follow-up)

## Notas

- **Apenas manual** — não há trigger automático/agendado por enquanto.
- **Audiência diferente da diária** — quando publicar via Beehiiv (Phase 2), considerar segmento `mensal-only` ou similar pra evitar redundância com leitores que recebem o diário.
- **Plataforma de envio é TBD** — por ora assume-se Beehiiv. Se mudar (ex: migração pra Kit), o `publish-newsletter` é trocado sem afetar o resto do fluxo.
- Status detalhado e decisões editoriais: ver issue #188.
