# workers/site

Worker de static assets que vai eventualmente servir o apex `diar.ia.br`
(#467 — decisão do editor de 25/08/2026: "o apex aponta pro nosso Worker;
o Kit fica só com o e-mail").

**Estado desta unidade (1º item do checklist revisado do #467): só o
acervo `/p/{slug}` das 253 edições publicadas** (`status: "confirmed"` em
`data/beehiiv-cache/posts/`). `custom_domain`/`routes` apontando pro apex
**não estão ligados ainda** — este Worker só roda em `workers.dev` até o
cutover de DNS (fora de escopo, blast-radius real, ver
`docs/apex-cutover-rollback.md`).

Fora de escopo aqui, itens 2-6 do checklist do #467:

- passo de pipeline que publica a página de uma edição NOVA (o cache atual
  é um snapshot do que já existe; edições futuras ainda não passam por
  este Worker)
- `/`, `/subscribe`, `/forms/*` (home + formulários postando pro Kit)
- o cutover de DNS em si

## Por que um Worker novo, e não estender `workers/arquivo`

`workers/arquivo` é uma página de CURADORIA (índice por mês/tema, sem
`[assets]`, renderiza on-the-fly a partir do sitemap). Este Worker é o
espelho 1:1 do acervo — cada `/p/{slug}` é o HTML COMPLETO que a Beehiiv já
gerou pra aquela edição (`content.free.web`), sem transformação de
conteúdo. São dois papéis diferentes (curadoria vs. mirror), e o segundo é
justamente o candidato a virar o apex algum dia — juntar os dois faria
`workers/arquivo` carregar uma responsabilidade (servir o site de verdade)
que hoje não é dele. Mesmo padrão de assets puro de `workers/artigos`.

## Gerar as páginas

```
npx tsx scripts/gen-archive-pages.ts
```

Lê `data/beehiiv-cache/posts/post_*.json`, filtra `status: "confirmed"`
(exclui drafts — inclusive o slug placeholder `new-post` visto no cache
real), e escreve:

- `public/p/{slug}/index.html` — 1 por post, a partir de
  `content.free.web` com `<html lang="pt-BR">` injetado (o cache não tem
  NENHUM atributo `lang`; a versão servida pela Beehiiv injeta `lang="en"`
  no template de request-time — bug de plataforma, ver
  `docs/seo-notes.md` Fato 6/#5101 item 1) + `<title>`/`<meta
  name="description">`/`<link rel="canonical">` (o cache não tem nenhum
  dos três; description cai em `meta_default_description` →
  `subtitle` → `preview_text`, #5101 item 2).
- `public/sitemap.xml` — as URLs efetivamente escritas (nunca lista um
  slug pulado por falta de `content.free.web`).

Idempotente e regenera do zero (`rm -rf public/p` antes de escrever) —
rerodar depois de um `beehiiv-sync.ts` novo remove órfãos automaticamente.
Miolo puro testado em `scripts/lib/site-archive-pages.ts` /
`test/gen-archive-pages.test.ts`.

`robots.txt` é mantido à mão (mesmo conteúdo fixo dos outros Workers de
curadoria — `Content-Signal`, `Allow: /`, bloqueio de `Amazonbot`/
`CloudflareBrowserRenderingCrawler` — ver CLAUDE.md "Crawlers de IA ficam
liberados").

## Deploy

```
cd workers/site && npx wrangler deploy
```

ou via `.github/workflows/deploy-site.yml` (push em `master` tocando
`workers/site/**`, mesmo padrão de `deploy-artigos.yml`).
