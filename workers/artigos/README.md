# workers/artigos

Hosting de artigos especiais avulsos da diar.ia.br em
`https://especial.diar.ia.br/{ano}/{slug}/`. Servindo no subdomínio
dedicado `especial.diar.ia.br` via `custom_domain = true` — o mesmo
mecanismo comprovado de `livros.diar.ia.br` e `cursos.diar.ia.br`.

**Desde #7030: script + assets (era *static assets* puro).** Os Artigos
Especiais (não as páginas de entidade) mostram um TEASER público — abertura
+ 1ª seção nomeada — e o conteúdo completo fica atrás de um gate por apoio
(≥ um limiar de `apoio_nivel`), reusando o mesmo mecanismo do gate de
`workers/cursos` (#4052): KV de sessão (`ARTIGOS_APOIO_NIVEL`), cookie
assinado, rate-limit por IP. Ver "Gate por apoio" abaixo.

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

## Gate por apoio (#7030)

Os 2 Artigos Especiais publicados (`/2026/engenharia-de-ilusao/`,
`/2026/o-agente/`) mostram um TEASER até a 1ª seção nomeada do artigo
(ponto de corte marcado no source, ver "Adicionar um artigo novo" abaixo)
e cortam o resto atrás de um convite — apoiar (`apoia.se/diaria`) ou
confirmar e-mail já-apoiador (`/gate`). O corte é NO SERVIDOR (o HTML
completo nunca chega no browser de quem não passou no gate) — mesmo
cuidado anti-cloaking/anti-"gate de mentira" do `workers/cursos` (#4052).

Mecanismo (reusa `scripts/lib/shared/*`, não reimplementa):
- `apoio-level-verify.ts` — lookup do nível de apoio via KV
  (`ARTIGOS_APOIO_NIVEL`, chave `apoio:{sha256(email)}` →
  `amigo`/`apoiador`/`mantenedor`/`patrono`), populado por
  `scripts/sync-artigos-apoio-kv.ts` a partir do custom field `apoio_nivel`
  já sincronizado na Beehiiv (`sync-apoio-nivel-beehiiv.ts` — carência de
  1 mês herdada de lá, não recalculada aqui).
- `session-cookie.ts` / `rate-limit.ts` — mesmos primitivos do `cursos`
  (cookie assinado 30 dias, 8 tentativas/IP/hora em `/gate/verify`).
- **Limiar "R$10/mês ↔ qual(is) nível(is)" é PLACEHOLDER não confirmado**
  — ver `src/apoio-gate-config.ts`. Mudar isso é a única coisa que precisa
  mudar quando o editor confirmar os valores reais no apoia.se.

Setup manual antes do 1º deploy (mesmo procedimento do `cursos`):
1. `wrangler kv namespace create ARTIGOS_APOIO_NIVEL` → colar o id em
   `wrangler.toml` (troca o placeholder `PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE`
   — enquanto ele estiver lá, `.github/workflows/deploy-artigos.yml` PULA
   o deploy automático de propósito, ver comentário no workflow).
2. `wrangler secret put COOKIE_HMAC_SECRET` (gerar: `openssl rand -hex 32`).
3. Rodar `scripts/sync-artigos-apoio-kv.ts` pra popular o KV (ainda sem
   agendamento — rodar manualmente até decidir cadência, #7030).

## Adicionar um artigo novo

1. Criar `articles-src/{slug}.html` (documento HTML completo e
   autocontido — sem dependências externas, CSS inline; é AQUI que se
   edita o texto, não em `public/`, ver "Gate por apoio" acima). Incluir
   JSON-LD `Article` (`author`, `datePublished`, `dateModified`,
   `publisher` — ver `articles-src/o-agente.html` pro shape exato, #5126)
   E o marcador `<!-- ESPECIAL:GATE_CUT -->` no ponto onde o teaser deve
   cortar (logo antes da 2ª seção nomeada, mesma convenção dos 2 artigos
   existentes).
2. Rodar `npx tsx scripts/build-artigo-especial-teaser.ts` — gera
   `public/{ano}/{slug}/index.html` (teaser) e
   `src/{slug}-full.generated.ts` (conteúdo completo). Adicionar o artigo
   em `ARTICLES` (`scripts/build-artigo-especial-teaser.ts`) e em
   `GATED_ARTICLES` (`src/gated-articles.ts`) — os 2 `run_worker_first` do
   `wrangler.toml` também precisam da entrada nova.
3. Adicionar o artigo em `public/index.html` (raiz do host — índice de
   todos os artigos especiais, #5126 item 3) e em `public/sitemap.xml`
   (#5126 item 1) — os dois são mantidos manualmente, não gerados.
4. Deploy:
   ```
   cd workers/artigos && npx wrangler deploy
   ```
5. Verificar ao vivo: abrir a URL publicada E a home `diar.ia.br`
   (confirmar que o Beehiiv continua servindo o resto do domínio sem
   interferência), e testar o gate (teaser sem cookie, completo com um
   e-mail apoiador de teste).

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

- KV (`ARTIGOS_APOIO_NIVEL`) + secret (`COOKIE_HMAC_SECRET`) só pro gate
  dos Artigos Especiais (#7030) — páginas de entidade e a home continuam
  100% estáticas, sem custo extra de invocação de script.
- Design system aplicado inline (cores/tipografia espelham
  `scripts/lib/shared/design-tokens.ts`).
- Nunca fazer deploy de arquivos de rascunho/preview dentro de `public/`
  — tudo ali é servido publicamente (o teaser gerado É o conteúdo
  público; o completo só sai embutido no bundle do script, nunca como
  arquivo estático).
- `public/sitemap.xml` e o link em `public/index.html` são mantidos à mão
  (#5126) — nenhum build script gera este Worker (é assets puro). Ao
  publicar um artigo novo, os dois PRECISAM ser atualizados no mesmo PR —
  `test/artigos-sitemap-5126.test.ts` falha se um artigo em `public/` não
  aparecer no sitemap.
