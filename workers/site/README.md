# workers/site

Worker (`diaria-site`) que serve o apex `diar.ia.br` (#467 — decisão do
editor de 25/08/2026: "o apex aponta pro nosso Worker; o Kit fica só com o
e-mail").

**O cutover já aconteceu (#467/#6498, confirmado ao vivo em 28/08/2026):**
`https://diar.ia.br/` responde com o `public/index.html` deste Worker
(`server: cloudflare`, não mais Beehiiv). A amarração do custom hostname do
apex a este Worker foi feita na configuração da zona, fora do repo — por
isso não aparece `custom_domain`/`[[routes]]` no `wrangler.toml`. Rollback:
`docs/apex-cutover-rollback.md`.

Conteúdo servido: o acervo `/p/{slug}` das edições publicadas, a home `/`,
`/assinar`, `/subscribe` (ver abaixo) e as rotas do script (próxima seção).

## Script (`src/index.ts`) e bindings

O Worker não é mais só de static assets: desde o #6429 tem `main =
"src/index.ts"`, com `run_worker_first = true` no `[assets]` (sem isso o
asset ganharia a request antes do script). O script resolve, antes do
`env.ASSETS.fetch`:

- `POST /webhooks/hotmart`, `GET /hotmart/abandonos` e `GET /hotmart/vendas`
  — webhook e leitura de abandonos/vendas da Hotmart (#10082, #10734);
- `/img/{key}` — capas da edição lidas do KV `POLL` (com fallback no R2
  `MEDIA`), mesma origem do documento (#7657, #11412);
- `/confirmada` (página do double opt-in, #7737/#8554) e `/confirmado`
  (301 para `/confirmada`);
- `/produto/conteudo-autentico` — 302 para a versão ativa da página de venda;
- a chave do IndexNow, quando `INDEXNOW_KEY` está configurada (#8355);
- `/apoiar/ir` (302 para o apoia.se, conta o clique) e `/apoiar` (301,
  #7915/#8498);
- `/video` — 302 para o horizontal mais recente no YouTube, link fixo da bio
  (#12735, #12801).

Depois do asset lookup: `/p/{slug}` servido ganha ETag/Last-Modified/304
(#8355), e `/p/{slug}` inexistente cai num 302 para o permalink no Kit
(#6429). Toda request também passa pelos contadores de bot de IA e de
Referer de assistente (#8062).

Bindings declarados no `wrangler.toml`:

- `ASSETS` — `./public`, `html_handling = "drop-trailing-slash"` (#467);
- KV `POLL` — o mesmo namespace de `workers/poll`, só leitura: as imagens
  via `serveKvImage` (allowlist de key do #4112) e o registro do vídeo mais
  recente lido pelo `/video` (chave fixa, #12735);
- R2 `MEDIA` — bucket `diaria-shorts` (`media.diar.ia.br`, #11412);
- KV `CURSOS_SUBSCRIBERS` — contadores (`counter:*`, #8062/#8498/#12735) e
  registros da Hotmart (`hotmart:*`, #10082/#10734).

`observability` ligado (#5920).

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
  `gen-archive-pages.ts` sempre que o acervo mudar EM LOTE (ex: resync do
  cache Beehiiv). **Edição por edição, isso é automático desde o #6454
  (04/09/2026):** `publish-edition-site-page.ts --sitemap
  workers/site/public/sitemap.xml`, chamado no Stage 6 (§6d-site), já
  adiciona a entrada da edição recém-publicada ao `sitemap.xml`
  (`sitemapEntryFromPost`/`addSitemapEntry`, idempotente) e regenera
  `index.html` a partir do MESMO miolo puro (`buildHomeFeed`/`buildIndexHtml`
  de `site-home-page.ts`) — a home se mantém sozinha sem depender de
  ninguém rodar este script à mão. Achado original do #6454: a flag
  `--sitemap` existia desde a 1ª versão do script, mas só STAGEAVA o
  arquivo pro commit — nada escrevia o conteúdo, e a home ficou congelada
  ~10 dias em produção antes do fix. `<title>`/meta description **deixaram
  de ser o bare "diar.ia.br" do stub original em #8067 (260916)** — GSC
  mostrou 0% CTR na busca de marca (207 impr., posição ~7) por não
  comunicar a proposta de valor; guard de regressão do #6359 atualizado
  pra travar o novo texto (mesmo já publicado no painel Beehiiv,
  diaria.beehiiv.com) em vez do antigo.
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
conteúdo. São dois papéis diferentes (curadoria vs. mirror), e o segundo
virou o apex no cutover (#6498) — juntar os dois faria `workers/arquivo`
carregar uma responsabilidade (servir o site de verdade) que não é dele.
Nasceu no mesmo padrão de assets puro de `workers/artigos`; o script veio
depois (seção acima).

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
`workers/site/**`, mesmo padrão de `deploy-artigos.yml`). Como o apex já é
servido por este Worker, todo deploy vai direto pra produção: um binding que
o deploy não resolva (KV/R2 do `wrangler.toml`) faz o deploy falhar e deixa o
apex na versão anterior.
