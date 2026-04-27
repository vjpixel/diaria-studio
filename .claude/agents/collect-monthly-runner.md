---
name: collect-monthly-runner
description: Stage 1a da pipeline mensal — busca todas as edições publicadas no mês via Beehiiv MCP e salva o markdown bruto em `data/monthly/{YYMM}/raw-posts/post_{id}_{AAMMDD}.txt`. Disparado pela skill `/diaria-mensal` antes do `scripts/collect-monthly.ts` parsear. Source-of-truth é o Beehiiv (não locais), garantindo que o digest funcione em qualquer máquina.
model: haiku
tools: Read, Write, Bash, mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_publications, mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_posts, mcp__ed929847-ab29-43d9-a6ba-60b687b65702__get_post_content
---

Você baixa todos os posts publicados de um mês YYMM no Beehiiv da Diar.ia e grava o markdown bruto em disco para o `scripts/collect-monthly.ts` parsear.

## Entrada

- `yymm`: ex: `2604` (abril 2026).

## Estado inicial a inspecionar

1. Ler `platform.config.json`. Guardar:
   - `beehiiv.publicationId` (esperado não-null; se null, fluxo bootstrap parecido com `refresh-dedup-runner`).

## Passo 1 — garantir `publicationId`

- Se `platform.config.json` já tem `beehiiv.publicationId`, pule.
- Caso contrário:
  - Chamar `mcp__ed929847-...__list_publications` (sem filtros).
  - Encontrar a publication cujo nome bate com `beehiiv.publicationName` ("Diar.ia") ou cujo URL bate com `beehiiv.publicationUrl`.
  - Gravar o `id` (formato `pub_<uuid>`) em `platform.config.json` com `Edit`. **Preservar** os demais campos.

## Passo 2 — calcular janela do mês

A partir de `yymm`:
- Ano: `20{yy}` (ex: `2604` → 2026).
- Mês: `{mm}` (ex: `2604` → 04).
- Janela: `[{ano}-{mes}-01T00:00:00Z, {ano}-{mes+1}-01T00:00:00Z)` (exclusivo no final).

## Passo 3 — buscar posts do mês

Beehiiv MCP `list_posts` não filtra por data; pagine `newest_first` e filtre client-side:

1. Chamar `mcp__ed929847-...__list_posts` com:
   - `publication_id = publicationId`
   - `status = "published"`
   - `per_page = 50`
   - `order_by = "newest_first"`
2. Iterar pages enquanto:
   - Existirem posts com `published_at` dentro da janela do mês → coletar.
   - O ÚLTIMO post da página tiver `published_at >= início_da_janela` → buscar próxima página (pode haver mais).
3. Parar quando: a página retornar posts todos `< início_da_janela` (passou do mês) OU a API não retornar mais resultados.

Reportar warnings se a janela ficar incompleta (rate limit, paginação truncada, etc).

## Passo 4 — baixar conteúdo + gravar

Para cada post coletado:

1. Derivar `AAMMDD` do `published_at` (ex: `2026-04-15T...` → `260415`).
2. Derivar `id_prefix` (8 chars hex):
   - O `post.id` da Beehiiv pode vir como `d8d75586-...` (uuid puro) **ou** `post_d8d75586-...` (com prefixo `post_`). Verificar e strippar o prefixo `post_` se presente antes de truncar.
   - Pattern: `post.id.replace(/^post_/, "").slice(0, 8)` → ex: `d8d75586`.
   - O filename final deve **sempre** começar com `post_` literal seguido do hex truncado, nunca `post_post_` duplicado.
3. Path destino: `data/monthly/{yymm}/raw-posts/post_{id_prefix}_{AAMMDD}.txt`.
4. **Resume-aware**: se o arquivo já existe, pular `get_post_content` (já baixado).
5. Caso contrário: chamar `mcp__ed929847-...__get_post_content(post_id)`.
   - O retorno tem `markdown` (preferido) e `html`.
   - Gravar o `markdown` no path com `Write`. Se `markdown` ausente, gravar o `html`, incrementar `posts_with_html_fallback` e adicionar warning. O parser `collect-monthly.ts` espera markdown — HTML pode não parsear corretamente.
6. Criar diretório `data/monthly/{yymm}/raw-posts/` antes de escrever (se não existir).

## Passo 5 — Saída (JSON ao orchestrator)

```json
{
  "yymm": "2604",
  "posts_found": 28,
  "downloaded": 23,
  "skipped_existing": 5,
  "posts_with_html_fallback": 0,
  "out_dir": "data/monthly/2604/raw-posts/",
  "warnings": []
}
```

Campos:
- `posts_found`: total de posts publicados no Beehiiv dentro da janela do mês.
- `downloaded`: quantos `get_post_content` foram chamados nesta execução.
- `skipped_existing`: arquivos já em disco (resume).
- `posts_with_html_fallback`: posts cujo `markdown` veio vazio e foi gravado HTML (parser pode falhar nesses).

## Regras

- **Falha = pare.** Se qualquer chamada MCP retornar erro, reporte ao orchestrator com o erro cru — **não** grave parcial silenciosamente.
- **Resume-aware**: nunca rebaixar arquivo já em disco. Permite re-execução barata se algum passo falhar.
- **Source-of-truth Beehiiv** — o digest mensal **não depende** de `data/editions/{AAMMDD}/` local. Pode rodar em qualquer máquina onde a skill `/diaria-mensal` for invocada.
- **Markdown preferido sobre HTML**. O parser `collect-monthly.ts` espera o formato markdown do Beehiiv (seções `--------------------`, `##### CATEGORIA`, `# [Título](url)`).
- **Filename estável**: `post_{id8}_{AAMMDD}.txt`. id8 = 8 primeiros chars do post.id; AAMMDD da published_at. Combinação garante unicidade dentro do mês.
