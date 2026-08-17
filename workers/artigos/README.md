# workers/artigos

Hosting de artigos especiais avulsos da diar.ia.br em
`https://especial.diar.ia.br/{ano}/{slug}/`. Worker de *static assets*
(sem script), servindo no subdomínio dedicado `especial.diar.ia.br` via
`custom_domain = true` — o mesmo mecanismo comprovado de
`livros.diar.ia.br` e `cursos.diar.ia.br`.

A raiz `diar.ia.br` continua 100% hospedada pelo Beehiiv Website Builder
v2, sem interferência. (A 1ª tentativa usou Workers Route clássica em
path da raiz; a rota nunca interceptou tráfego na zona de produção — ver
histórico no `wrangler.toml`. Não repetir esse caminho.)

## Estrutura

Cada artigo é um path dentro do subdomínio:

```
workers/artigos/public/{ano}/{slug}/index.html
```

Não precisa de rota nova por artigo — o roteador de assets resolve
sub-paths dentro do mesmo `custom_domain`.

## Adicionar um artigo novo

1. Criar `public/{ano}/{slug}/index.html` (documento HTML completo e
   autocontido — sem dependências externas, CSS inline). Incluir JSON-LD
   `Article` (`author`, `datePublished`, `dateModified`, `publisher` — ver
   `public/2026/o-agente/index.html` pro shape exato, #5126).
2. Adicionar o artigo em `public/index.html` (raiz do host — índice de
   todos os artigos especiais, #5126 item 3) e em `public/sitemap.xml`
   (#5126 item 1) — os dois são mantidos manualmente, não gerados.
3. Deploy:
   ```
   cd workers/artigos && npx wrangler deploy
   ```
4. Verificar ao vivo: abrir a URL publicada E a home `diar.ia.br`
   (confirmar que o Beehiiv continua servindo o resto do domínio sem
   interferência).

## Índices por mês/tema — NÃO estão aqui, já existem em `arquivo.diar.ia.br` (#5125)

O escopo de #5125 também pediu "índice por mês" e "índice por tema" do
corpus. **As duas já existem em produção, num Worker diferente
(`workers/arquivo`), não neste:**

- Por mês: `https://arquivo.diar.ia.br/` (#4105) — todas as edições
  confirmadas, agrupadas por `YYYY-MM`.
- Por tema: `https://arquivo.diar.ia.br/temas/` (#4558 Parte A) — índice dos
  6 hubs temáticos publicados (`HUB_META`), cada um listando as edições que
  casam o tema.

Antes de construir uma 3ª página de índice aqui (ou em qualquer host novo),
rodar `npx tsx scripts/corpus-index-coverage-report.ts` (precisa do junction
`data/`) e ler `docs/corpus-index-status-5125.md` — o relatório cruza o
corpus confirmado contra os dois índices já existentes e mede cobertura real
(mês: 100%; tema: ~82% via os 6 hubs, na medição de 17/08/2026). Duplicar um
índice que já cobre o corpus contradiz a decisão registrada em #5125 (opção
C: produzir superfície que NÃO existe, nunca espelhar o que já existe em
host nosso).

## Páginas de entidade (#5125)

Além de artigos avulsos (`{ano}/{slug}/`), o host também serve páginas de
entidade — índice cronológico de menções a uma empresa/produto no corpus da
diária (`data/beehiiv-cache/posts/`), com síntese própria por menção. Path
próprio, gerado (não escrito à mão como os artigos avulsos):

```
workers/artigos/public/entidades/{slug}/index.html
```

Fonte de conteúdo: `scripts/lib/entities/{slug}.ts`. Gerar/regenerar:

```
npx tsx scripts/build-entity-page.ts --entity {slug}
```

Spec completa dos formatos (página de entidade + timeline temática, ainda
não implementada) e o critério anti-thin-content: ver docstring de
`scripts/lib/shared/entity-page.ts`. Mesma exigência manual de
`sitemap.xml`/`public/index.html` dos artigos avulsos —
`test/artigos-entidades-5125.test.ts` falha se uma entidade em
`public/entidades/` ficar fora dos dois.

## Notas

- Sem KV, sem secret, sem script — só assets estáticos.
- Design system aplicado inline (cores/tipografia espelham
  `scripts/lib/shared/design-tokens.ts`).
- Nunca fazer deploy de arquivos de rascunho/preview dentro de `public/`
  — tudo ali é servido publicamente.
- `public/sitemap.xml` e o link em `public/index.html` são mantidos à mão
  (#5126) — nenhum build script gera este Worker (é assets puro). Ao
  publicar um artigo novo, os dois PRECISAM ser atualizados no mesmo PR —
  `test/artigos-sitemap-5126.test.ts` falha se um artigo em `public/` não
  aparecer no sitemap.
