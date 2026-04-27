---
name: diaria-mensal
description: Gera o digest mensal da Diar.ia agrupando os destaques publicados nas edições do mês em 3 narrativas temáticas (com Brasil garantido) + 10 Outras Notícias. Uso — `/diaria-mensal YYMM [--no-gate]`. Phase 1 implementada (collect → analyst → gate → writer); Phase 2 (imagem D1 + publish Beehiiv) é follow-up. Veja issue #188.
---

# /diaria-mensal

Produz uma edição **mensal** da Diar.ia consolidando os destaques publicados nas edições diárias do mês escolhido.

## Argumentos

- `$1` = mês no formato `YYMM` (ex: `2604` = abril 2026). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir mês atual / mês anterior como atalhos mas exigir confirmação:

  > "Você não passou o mês da edição mensal. Qual mês quer processar? mês atual ({YYMM_atual}) / mês anterior ({YYMM_anterior}) / outro (informe YYMM)"

- `--no-gate` (opcional) = pular o gate humano sobre o `prioritized.md`. Auto-aprova a proposta do `analyst-monthly` e prossegue direto pro `writer-monthly`.

## Pré-requisitos

- Edições diárias do mês já processadas em `data/editions/{AAMMDD}/` com `02-reviewed.md` e `_internal/01-approved.json`.
- `context/audience-profile.md`, `context/editorial-rules.md`, `context/templates/newsletter-monthly.md` existem e não são placeholders.

## Fluxo

## Phase 1 (este PR — implementada)

### Stage 1 — Coleta

Lê edições diárias **localmente** em `data/editions/{AAMMDD}/` (parse de `02-reviewed.md` + enrichment via `_internal/01-approved.json`). A spec original do #188 prevê Beehiiv MCP como source-of-truth do publicado; por ora ficou como follow-up (nova issue) — Phase 1 assume que o editor está rodando o digest na mesma máquina onde as edições foram processadas.

Disparar `Bash`:

```bash
npx tsx scripts/collect-monthly.ts $1
```

Output: `data/monthly/$1/raw-destaques.json`. Reportar ao usuário:
- `editions_count` (quantas edições contribuíram)
- `destaques_count` (total de destaques coletados)
- `is_brazil` count (quantos foram marcados como Brasil)
- Warnings (edições sem `02-reviewed.md` ou sem `_internal/01-approved.json`)

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
Outras Notícias: {10 itens}

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

## Phase 2 (follow-up — issue #188, ainda não implementada)

### Stage 8 — Imagem D1

Quando implementado, gerará a imagem do D1 (Van Gogh impasto, mesmo prompt do diário) via `scripts/image-generate.ts` adaptado.

Por ora, emitir aviso:

```
⚠️ Imagem D1 não gerada automaticamente (Phase 2 follow-up — issue #188).
Gere manualmente, ou aguarde implementação.
```

### Stage 9 — Publish Beehiiv

Quando implementado, adaptará `publish-newsletter` para `mode=monthly`:
- `render-newsletter-html.ts` com template mensal.
- `upload-images-public.ts --mode monthly` (só 1 imagem D1).
- `publish-newsletter` cria rascunho na Beehiiv + email de teste.

Por ora, emitir aviso:

```
⚠️ Publicação automática Beehiiv não implementada (Phase 2 follow-up — issue #188).
Para publicar: copiar `data/monthly/{YYMM}/draft.md` manualmente para o
editor Beehiiv como rascunho. Revisar e enviar.
```

## Outputs

Todos em `data/monthly/{YYMM}/` (ex: `data/monthly/2604/`):

- `raw-destaques.json` — coleta bruta com metadata estruturada
- `prioritized.md` — proposta do analista (revisada no gate)
- `draft.md` — texto final pra publicação (Phase 1 ends here)
- `04-d1.jpg` — imagem D1 (Phase 2)
- `published.json` — metadata da publicação Beehiiv (Phase 2)

## Notas

- **Apenas manual** — não há trigger automático/agendado por enquanto.
- **Audiência diferente da diária** — quando publicar via Beehiiv (Phase 2), considerar segmento `mensal-only` ou similar pra evitar redundância com leitores que recebem o diário.
- **Plataforma de envio é TBD** — por ora assume-se Beehiiv. Se mudar (ex: migração pra Kit), o `publish-newsletter` é trocado sem afetar o resto do fluxo.
- Status detalhado e decisões editoriais: ver issue #188.
