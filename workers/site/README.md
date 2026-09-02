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

### `/` e `/subscribe` (#6359, redesign #6375)

Medição ao vivo (26/08/2026, comentário da issue #6359) reduziu o escopo
original do #467 de 4 rotas faltantes pra 2 — `/forms/*` nunca existiu no
apex (404 hoje) e `/sitemap.xml` já era servido certo.

- **`/`** — `public/index.html`, redesign completo (#6375) portando a
  "Direção A · Edição diária" (`V1Landing`, repo `diaria-design`,
  `v1-daily.jsx` — já **selecionada**, não uma entre opções em aberto) de
  React/JSX pro HTML estático que este Worker serve. 7 blocos, mesma
  hierarquia do design de referência: Nav → Masthead (H1 + lede + form de
  inscrição inline) → Feature (destaque do dia) → Specials (livros/cursos)
  → Archive (edições anteriores) → Faqs → Footer (form de novo, tema
  escuro). Gerado por `scripts/gen-home-page.ts` (miolo puro em
  `scripts/lib/site-home-page.ts`) — **não** um script ad-hoc: lê
  `public/sitemap.xml` (ordem mais-recente-primeiro) +
  `public/p/{slug}/index.html` já gerados por `gen-archive-pages.ts` pra
  popular Feature/Archive com a MESMA edição confirmada mais recente e as
  mesmas anteriores do acervo real — nunca mock (ver docstring do módulo
  pro porquê de ler o output já commitado em vez de `data/beehiiv-cache/`
  direto). Rodar `npx tsx scripts/gen-home-page.ts` depois de
  `gen-archive-pages.ts` sempre que o acervo mudar. `<title>diar.ia.br</title>`
  + meta description = tagline oficial são preservados do stub original
  (guard de regressão do #6359 continua valendo).
  **O form de inscrição (masthead + footer) resolve a inscrição no
  PRÓPRIO hero (#6976, 01/09/2026) — deixou de ser decorativo.** Até o
  #6976, a pill inteira era um único `<a href="/subscribe">` (depois
  `/assinar`, #6427) com um `<span>` fingindo ser input (`aria-hidden`):
  o visitante clicava, ia pra outra página e digitava o e-mail de novo.
  Hoje é um `<form>` real (mesma geometria pixel-a-pixel da pill antiga —
  só o `<input>`/`<button>` reais herdam a aparência via CSS) que reusa o
  MESMO mecanismo de `public/assinar/index.html`: `POST` JSON cross-origin
  pra `https://eia.diar.ia.br/jogar/subscribe`, `source: "apex"`, UTM
  dinâmico repassado da própria query string da home, status inline
  sem sair da página. Miolo em `renderSignupForm`/`wireSignupForm`
  (`scripts/lib/site-home-page.ts`) — 1 função chamada 2x (`id`s distintos
  `masthead-form`/`footer-form`, sem colisão). A checkbox de opt-in (LGPD,
  `optin_required` no worker `poll`) é obrigatória em todo form deste tipo
  no repo (`/assinar`, `livros-hero/footer`, `arquivo`/`hub`) — entra como
  linha compacta abaixo da pill, sem alterar a geometria da pill em si.
  `/assinar` continua existindo e funcionando como página autônoma
  (link compartilhável, destino de quem chega por fora) — não foi
  removida nem alterada. Desde o #7015, `public/assinar/index.html` é
  GERADO por `scripts/gen-assinar-page.ts` (miolo em
  `scripts/lib/site-assinar-page.ts`) — deixou de ser HTML escrito à mão
  pra fechar o mesmo bug de wordmark do #7010 (só os pontos separadores em
  teal, sem o `.br` inteiro); rodar o gerador depois de editar o módulo,
  nunca editar o HTML direto. V1Specials linka
  direto pros hubs já existentes (`livros.diar.ia.br`, `cursos.diar.ia.br`)
  em vez de fonte de dado dinâmica — não achada nenhuma API própria de
  contagem de livros/cursos no repo, e os hubs já são a fonte de verdade
  de conteúdo dessas categorias.
- **`/subscribe`** — `public/_redirects`, 302 pro perfil hospedado da
  conta Kit (`https://diar-ia-br.kit.com/`) — a única superfície de
  cadastro PÚBLICA que a conta já expõe (confirmado ao vivo: o único form
  listado via MCP é tipo `embed`, sem página hospedada própria; 0 landing
  pages publicadas). Backend de cadastro é o Kit desde o switchover #6114
  (`platform.config.json` → `publishing.newsletter.backend`). **Continua
  sendo o destino real do cadastro** — o #6375 não mexeu nisso, só trocou
  o que `/` mostra visualmente antes de mandar pra cá.

Redirect em vez de página própria postando na API porque UTM/atribuição de
cadastro é escopo do #6318 (aberta — mecanismo de custom field UTM já
mergeado e verificado no #6324, backfill 592/592 assinantes sem
divergências; resta fechar o vínculo form+double-opt-in — Opção B, mais
rica, medida ao vivo em 26/08 mas sem confirmação de que já virou decisão
final/implementação — e checar se a atribuição aparece na UI do Kit) — não
entrar nisso aqui. Smoke test de rotas: `test/site-worker-routes-6359.test.ts`
(rotas/arquivos) + `test/site-home-page-6375.test.ts` (conteúdo do
redesign — 7 blocos, links reais pro acervo) + `test/site-home-signup-6976.test.ts`
(forms de inscrição inline do masthead/footer, POST pra `/jogar/subscribe`).

Fora de escopo aqui:

- o cutover de DNS em si
- POST real pro Kit (#6318)
- medição de conversão visitante→assinante (item separado da issue #6375,
  requer decisão de instrumentação)

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

**Depois de rodar o comando acima, rodar também** `npx tsx
scripts/gen-home-page.ts` — regenera `public/index.html` (#6375) a partir
do `sitemap.xml`/`public/p/` recém-escritos, pra Feature/Archive da home
refletirem o acervo atualizado.

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
