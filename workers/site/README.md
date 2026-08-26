# workers/site

Worker de static assets que vai eventualmente servir o apex `diar.ia.br`
(#467 — decisão do editor de 25/08/2026: "o apex aponta pro nosso Worker;
o Kit fica só com o e-mail").

**Estado desta unidade: acervo `/p/{slug}` das 253 edições publicadas**
(`status: "confirmed"` em `data/beehiiv-cache/posts/`) **+ `/` e
`/subscribe` (#6359, 26/08/2026, stub — ver abaixo).** `custom_domain`/
`routes` apontando pro apex **não estão ligados ainda** — este Worker só
roda em `workers.dev` até o cutover de DNS (fora de escopo, blast-radius
real, ver `docs/apex-cutover-rollback.md`).

### `/` e `/subscribe` (#6359)

Medição ao vivo (26/08/2026, comentário da issue) reduziu o escopo
original do #467 de 4 rotas faltantes pra 2 — `/forms/*` nunca existiu no
apex (404 hoje) e `/sitemap.xml` já era servido certo.

- **`/`** — `public/index.html`, home mínima própria (não redirect —
  preserva o sinal de SEO do apex vivo desde a migração anterior, ver
  `docs/seo-notes.md`). `<title>diar.ia.br</title>` + meta description =
  tagline oficial, medidos ao vivo como o que o apex serve hoje via
  Beehiiv.
- **`/subscribe`** — `public/_redirects`, 302 pro perfil hospedado da
  conta Kit (`https://diar-ia-br.kit.com/`) — a única superfície de
  cadastro PÚBLICA que a conta já expõe (confirmado ao vivo: o único form
  listado via MCP é tipo `embed`, sem página hospedada própria; 0 landing
  pages publicadas). Backend de cadastro é o Kit desde o switchover #6114
  (`platform.config.json` → `publishing.newsletter.backend`).

**STUB, não a versão definitiva** — decisão do editor (Gate B, #6359):
"stub primeiro, migrar depois". Redirect em vez de página própria postando
na API porque UTM/atribuição de cadastro é escopo do #6318 (aberta —
mecanismo de custom field UTM já mergeado e verificado no #6324, backfill
592/592 assinantes sem divergências; resta fechar o vínculo
form+double-opt-in — Opção B, mais rica, medida ao vivo em 26/08 mas sem
confirmação de que já virou decisão final/implementação — e checar se a
atribuição aparece na UI do Kit) — não entrar nisso aqui. Smoke test de
rotas: `test/site-worker-routes-6359.test.ts`.

Fora de escopo aqui:

- o cutover de DNS em si

**O passo de pipeline que publica a página de uma edição NOVA já existe
(#6202):** `scripts/publish-edition-site-page.ts`, dispatchado no Stage 6
(§6d-site em `.claude/agents/orchestrator-stage-6.md`) depois do agendamento
confirmado — commita+empurra `public/p/{slug}` a cada edição, então o acervo
deste Worker deixou de ser um snapshot estático das 253 edições antigas.

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
