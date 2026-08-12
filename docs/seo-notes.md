# SEO — registro de fatos apurados (#4548)

Notas operacionais sobre a leitura do output de `scripts/seo-pull.ts` e
`scripts/seo-index-check.ts` (task semanal `Diaria-Seo-Weekly`, grava em
`data/seo/`). Não é runbook de setup —
é registro de **decisão/interpretação de dado**, pra que uma rodada futura
(overnight/develop ou o próprio editor) não reinterprete o mesmo dataset como
achado novo ou tente "consertar" o que já está certo.

## Fato 1 — `opportunities: 0` do `seo-pull` é ausência de dado, não achado (03/ago/2026)

A propriedade `sc-domain:diar.ia.br` foi verificada em 27/jul/2026 (#4089) — o
Google Search Console não coleta retroativo, então não existe histórico
anterior a essa data. Medição direta da Search Analytics API em 03/ago:

```
período: 2026-07-26 → 2026-08-03  (9 dias)
totais:  24 impressões · 1 clique · CTR 4,2% · posição média 23,5
queries: 10 linhas   ·  páginas: 14 linhas
```

Com esse volume, `opportunities-*.md` sair com "0 oportunidades (≥50
impressões)" é o comportamento **correto** do script — não um defeito nem um
veredito sobre SEO. `expectedCtr()` (`scripts/seo-pull.ts`) precisa de volume
que ainda não existe.

**Ação:** deixar a task semanal como está (a série de indexação, via
`seo-index-check.ts`, essa sim já é útil — subiu de 10,8% pra 37,3% em uma
semana). Só voltar a **ler** o `opportunities-*.md` com expectativa de sinal
real no checkpoint **~29/set/2026** — mesma data do #4469 (quando também se
mede se o balde `direct` de atribuição caiu abaixo de 25%). Se em setembro o
total ainda estiver na casa das dezenas de impressões, a leitura correta é
"falta autoridade" (backlinks), não "on-page errado".

**Não fazer:** não concluir "SEO não funciona" a partir de `opportunities: 0`
antes do checkpoint; não aumentar a cadência da task nem rodar `seo-pull`
manualmente entre checkpoints (não produz informação nova, só consome quota
da API).

## Fato 2 — as 10 URLs "cópia, canônica divergente" são estado velho de índice, não bug (03/ago/2026)

`data/seo/index-status-2026-08-03.json` marcava 10 URLs como *"Cópia, o Google
e o usuário selecionaram uma página canônica diferente"*, com
`googleCanonical` apontando pro host legado (`diaria.beehiiv.com/p/{slug}`) e
`userCanonical` pro host correto (`diar.ia.br/p/{slug}`) — parece bug nosso.

Verificado ao vivo (URL Inspection API) nas 10 URLs, em 03/ago:

- `https://diaria.beehiiv.com/p/{slug}` responde **301** pra
  `https://diar.ia.br/p/{slug}` (testado com UA de Googlebot).
- O sitemap do host legado (`diaria.beehiiv.com/sitemap.xml`, HTTP 200) lista
  239 URLs — **zero** delas no host legado, todas já apontam pro domínio novo.
- O `<link rel="canonical">` servido aponta pro domínio novo.

Os três sinais que o Google usa pra decidir canônica (redirect, sitemap,
`<link rel="canonical">`) já estão corretos. O que resta é estado velho do
índice — o `lastCrawlTime` dessas 10 páginas ficou entre 19 e 28/jul, e a
consolidação de canônica no Google é assíncrona (não instantânea).

**Ação:** nenhuma correção de código. Re-medir na próxima rodada semanal e
confirmar que a contagem cai sozinha.

**Não fazer:** não "consertar" canonical, redirect ou sitemap por causa deste
achado — os três já estão certos, mexer neles é risco sem ganho. Se em
setembro ainda houver 10 (ou mais) nesse estado com `lastCrawlTime` **recente**
(pós-agosto), aí sim vira investigação — `lastCrawlTime` antigo persistindo é
esperado, `lastCrawlTime` novo com o mesmo sintoma não seria.

## Fato 3 — `/temas/` ganhou `lastmod`/`Last-Modified`/`ETag`, entrou na checagem de indexação, Bing WMT e IndexNow fechados (10-11/ago/2026, #4909)

Achado de auditoria (#4909, Refs #4558): o sitemap do Worker `arquivo`
(`arquivo.diar.ia.br/sitemap.xml`) não emitia `<lastmod>`, `GET
/temas/{slug}` não emitia `Last-Modified`/`ETag`, e as URLs `/temas/*`
nunca entravam na medição de `seo-index-check.ts` — ficavam fora de toda
medição de indexação do projeto.

**Implementado em `develop/fix-4909` (10/ago/2026):**

- `<lastmod>` por `<url>` no sitemap do `arquivo` (raiz = data mais recente
  entre os hubs; cada hub = seu `contentDate`, o mesmo valor já usado no
  JSON-LD — nunca uma fonte de data nova/paralela).
- `Last-Modified` + `ETag` em `GET /temas/{slug}`. **Correção (#5134, ver
  Fato 8 abaixo): o `ETag` NÃO chegava até o cliente em produção** — o código
  montava o header corretamente (confirmado por invocação isolada do `fetch`
  handler), mas `curl -sSI` contra `arquivo.diar.ia.br` não mostrava
  `ETag` nenhum. Corrigido em #5134 (12/ago/2026) trocando pra ETag FRACO
  (`W/"..."`) — não é mais "entregue" no sentido presente-tense que este
  Fato 3 registrava; é entregue A PARTIR do deploy do #5134, com
  verificação ao vivo pós-deploy ainda pendente do editor.
- Novo step `index-arquivo` em `Diaria-SEO-Weekly` (`scripts/seo-index-check.ts
  --sitemap https://arquivo.diar.ia.br/sitemap.xml --out-suffix arquivo`,
  **sem** `--only-posts` — esse filtro é `/\/p\//` e zeraria `/temas/*`
  inteiro). `--out-suffix`/`--out-md` novos no script evitam a colisão que o
  `.md` do host principal teria sofrido (path antes era fixo, não
  sobrescrevível por `--out`).

**IndexNow (item 2 da issue original) — implementado em `overnight/batch-geo-discovery`
(11/ago/2026); metade verificada ao vivo, metade AINDA PENDENTE:** builder puro
do payload + gate "mudou desde o último deploy" (`scripts/lib/indexnow.ts`),
CLI de ping (`scripts/ping-indexnow.ts`), rota de arquivo de chave no Worker
`arquivo` (`GET /{INDEXNOW_KEY}.txt`) e step condicional em
`.github/workflows/deploy-arquivo.yml` (só pinga quando o diff do push toca
`workers/arquivo/src/hubs/*.generated.ts`).

O editor provisionou `INDEXNOW_KEY` como **secret do Worker** (via `wrangler
secret put`) — chave de 32 hex auto-declarada, IndexNow não exige emissão por
terceiro. `GET https://arquivo.diar.ia.br/{chave}.txt` → 200 com o corpo
esperado (armadilha: o primeiro `curl` logo após o `secret put` deu 404 —
propagação de var pelo edge, ~1 min; não é bug). O ping **manual** via CLI das
4 URLs de hub foi testado ao vivo → `api.indexnow.org` respondeu 202 (aceito).

**Fechado (11/ago/2026):** o workflow (`deploy-arquivo.yml:94`) lê a chave de
`${{ secrets.INDEXNOW_KEY }}` — um **secret separado do repositório no
GitHub Actions**, não o secret do Worker acima (são dois lugares distintos
que precisam da MESMA string, achado original do #4909). `gh secret list`
confirmou que esse secret nunca existiu no repo — todo deploy de `arquivo`
que tocasse um `.generated.ts` caía no gate "`INDEXNOW_KEY` ausente" e saía
sem pingar, silenciosamente. Como o valor não é recuperável do secret do
Worker (write-only), as duas pontas foram regeneradas juntas com uma chave
nova: `wrangler secret put INDEXNOW_KEY` no Worker `arquivo` + `gh secret
set INDEXNOW_KEY` no repo, mesma string nos dois. Revalidado ao vivo: `GET
https://arquivo.diar.ia.br/{chave}.txt` → 200, corpo = a chave. O ping
automático de deploy passa a funcionar a partir do próximo push que tocar
um `.generated.ts` — o POST em si não foi disparado manualmente (guard do
docstring de `ping-indexnow.ts`, só o workflow chama o endpoint real).

**Item 3 (Bing Webmaster Tools) — fechado ao vivo (11/ago/2026):** o import do
GSC não funcionou (a conta só tinha propriedade de domínio `sc-domain:`, que o
import do BWT não enxerga — descoberto por consulta à API do Search Console).
Caminho que funcionou: "Adicionar site manualmente" no BWT + verificação por
DNS (CNAME), com os registros criados via API da Cloudflare (o token do
projeto escreve DNS na zona — achado que também serve de referência geral,
não é exclusivo desta issue). Resultado, confirmado via `GetUserSites` da API
do BWT: `https://arquivo.diar.ia.br/` e `https://diar.ia.br/` ambos
`IsVerified: true`. Sitemap submetido nos dois hosts via `SubmitFeed`
(`https://arquivo.diar.ia.br/sitemap.xml`, status `Pending`, 0 erros).

Três armadilhas da API do BWT que valem ficar registradas (quem for
automatizar isto de novo cai nelas):

1. O método chama-se `SubmitFeed` (campo `feedUrl`) — `SubmitSitemap` não
   existe e devolve 404 com corpo HTML, não JSON de erro.
2. **O código de verificação DNS é por site, não por conta** — cada host
   pediu um token diferente. Um CNAME criado por hipótese errada (código
   único por conta) nunca serviu pra nada e foi removido; não replicar esse
   padrão.
3. `AddSite` com barra final no host devolve `202` mas o site não aparece em
   `GetUserSites`; sem a barra devolve `200` e aparece. Não tratar `202` como
   confirmação — sempre conferir com `GetUserSites`.

`BING_WEBMASTER_API_KEY` está no `.env` do editor (gitignored) e documentada
em `.env.example`. Item 3 (Bing WMT), item 1 (lastmod/ETag) e item 2
(IndexNow, ver acima) fechados sem pendência.

## Fato 4 — verificação ao vivo do contador de fetch por bot (#4902) e da cobertura de indexação por hub (#4903), 12/ago/2026

O código dos dois mecanismos (contador KV de fetch/Referer no Worker
`arquivo`, `scripts/ai-fetch-report.ts`, `scripts/hub-index-coverage.ts`) foi
implementado e mergeado em `master` pelo PR #4967 (11/ago/2026), mas **sem**
`Closes #4902`/`Closes #4903` no body — as duas issues continuavam abertas
apesar do código já estar em produção. A pendência real que restava era
verificação AO VIVO (item 4 de #4902, itens 2-3 de #4903), que o PR #4967
descartou de propósito (rodou só com `fetchImpl`/KV fake — "nenhuma chamada de
rede real ... usada nesta sessão"). Esta sessão tinha credenciais locais e
rodou os dois mecanismos contra produção:

**#4902 — contador de fetch confirmado funcionando:**

- `curl -A "OAI-SearchBot/1.0" https://arquivo.diar.ia.br/temas/anthropic-claude`
  → 200 OK (deploy do Worker `arquivo` já incluía o binding KV — último deploy
  automático em 12/ago/2026 00:06 UTC, `git log` do push confirma o commit do
  #4902 dentro da árvore).
- `npx tsx scripts/ai-fetch-report.ts --date 2026-08-12 --days 2` (lido
  minutos depois do curl acima) → o hit de `OAI-SearchBot` aparece no contador
  do dia (`1`), ao lado de `bingbot: 1`. O dia anterior (2026-08-11) já tinha
  tráfego orgânico registrado: `Googlebot: 2`, `bingbot: 8` — **zero** de
  `OAI-SearchBot`, `ChatGPT-User`, `Claude-User`, `Claude-SearchBot`,
  `PerplexityBot` ou `Perplexity-User` orgânico até agora. Consistente com o
  que a issue já esperava (é cedo, e o item 4 dela — esperar 2-3 semanas antes
  de julgar — segue válido). O mecanismo em si está confirmado: o contador
  soma corretamente e a leitura via `getTextFromWorkerKV` funciona contra o
  namespace real.
- `data/ai-fetch/history.jsonl` agora tem os 2 primeiros registros reais
  (antes vazio/inexistente).

**#4903 — cruzamento confirmado contra dado real, e `arquivo.diar.ia.br` medido pela 1ª vez:**

- `npx tsx scripts/hub-index-coverage.ts` (sem argumentos, contra
  `index-status-2026-08-10.json`, o relatório principal mais recente) bateu
  exatamente com os números já citados no corpo da issue #4903 para o hub
  `anthropic-claude` — 27/76 indexadas, 42/76 nunca rastreadas, 16/76 órfãs.
  Cruzamento também rodou pros outros 4 hubs (`openai-chatgpt` 36/96,
  `google-gemini` 23/61, `meta-ai` 7/20 com 1 URL ausente do relatório —
  edição mais nova que a rodada, tratado como informativo pela função pura —
  `brasil-regulacao` 5/11).
- `npx tsx scripts/seo-index-check.ts --sitemap https://arquivo.diar.ia.br/sitemap.xml --limit 10 --out-suffix arquivo`
  rodou pela 1ª vez contra a Search Console de verdade: **2/6 URLs indexadas
  (33,3%)**, escrito em `data/seo/index-status-arquivo-2026-08-12.{json,md}`.
  **Correção (#5120): esse "2/6" mistura raiz com hub e infla a leitura por
  hub.** Das 2 URLs indexadas, uma é a raiz `arquivo.diar.ia.br/` — não é um
  hub. Por hub, é **1 de 5 = 20%** (só `anthropic-claude`), não os "2/6
  (33%)" que chegaram a circular. O sitemap hoje tem 6 URLs (a raiz `/` + 5
  hubs — cresceu de 4 pra 6 desde que a issue foi escrita, o 5º hub
  `brasil-regulacao` entrou depois; o 6º hub, `mercado-trabalho`, mergeou em
  `8c6e0f27` 24min DEPOIS desta medição — não é bug do sitemap, que deriva
  de `HUB_REGISTRY` e já tem os 6 hoje). Os 4 hubs não-indexados
  (`openai-chatgpt`, `google-gemini`, `meta-ai`, `brasil-regulacao`) são
  todos marcados **órfãos (sem link interno)** pelo script **e não têm
  `lastCrawlTime`** — o Google nunca rastreou nenhum dos 4, nem uma vez,
  não é "rastreou e decidiu não indexar". Achado fora do escopo original da
  issue (que pedia só medir, não consertar): nenhuma dessas 4 páginas de hub
  tem `<a href>` apontando pra ela a partir de outra página já rastreada. Só
  `anthropic-claude` (o hub mais antigo) está indexado — plausível que seja
  o único com link de entrada hoje. Não é ação desta nota — registro pro
  checkpoint de ~07/out/2026 citado no corpo da issue.

**Ação:** ambas issues fecham com este achado — mecanismo confirmado
funcionando ao vivo nos dois casos, números batendo com o esperado. Não fazer
nada agora sobre as páginas órfãs de `/temas/` — é dado pro checkpoint, não um
bug a consertar (mesma disciplina do Fato 1 acima).

## Fato 5 — higiene de host canônico + entrada pros hubs na home (#5097/#5099, 12/ago/2026)

Auditoria ao vivo do #5097 (mesmo dia do Fato 4 acima) confirmou o gargalo já
enquadrado em `scripts/lib/shared/hub-page.ts:708`: **é recuperação
(discovery/crawl), não seleção (on-page)** que trava a indexação. O on-page já
tinha sido auditado nos #4558/#4899/#4909 e está correto; esta rodada olhou só
pra grafo de link e cópia de host:

- **Diagnóstico agregado (`npx tsx scripts/hub-index-coverage.ts`, 12/ago):**
  115/310 indexadas somando os 6 hubs (sobreposição de edição entre hubs —
  não é contagem de URL distinta): `anthropic-claude` 27/76, `openai-chatgpt`
  36/96, `google-gemini` 23/61, `meta-ai` 7/20, `brasil-regulacao` 5/11,
  `mercado-trabalho` 17/46. Host `arquivo` isolado, por hub: **1/5 = 20% (só
  `anthropic-claude`), com os outros 4 nunca rastreados** — correção do "2/6
  (33,3%)" que circulava (número que conta a raiz `arquivo.diar.ia.br/` como
  se fosse hub, ver Fato 4 acima; #5120). Essa medição específica
  (`index-status-arquivo-2026-08-12.json`) é anterior ao 6º hub
  `mercado-trabalho` mergear — o sitemap já tem 7 URLs (raiz + 6 hubs) hoje,
  mas os 2 indexados citados aqui ainda são só sobre o conjunto de 6 (raiz +
  5) da rodada anterior.
- **Achado 1 — a home apontava pros hosts NÃO-canônicos.** `https://diar.ia.br/`
  (maior autoridade do domínio) linkava `livros.diaria.workers.dev`,
  `cursos.diaria.workers.dev` e `diaria.beehiiv.com/archive` em vez dos hosts
  de marca. Ação de PAINEL (editor, Beehiiv UI) — código não alcança a home
  publicada. Guard fechado em código (#5099 item 2): 4º eixo
  `legacy-host-link` em `scripts/lib/beehiiv-home-meta-check.ts`
  (`detectLegacyHostLinks`), na task já armada `Diaria-Beehiiv-Home-Meta-Check`
  (6h) — mesmo mecanismo do `og:title`/self-link http/rótulos EN do #4557.
- **Achado 2 — a home não linkava nenhum `/temas/*`.** Cluster de hubs só
  recebia link do corpo das edições (#4907) e do root do arquivo/entre hubs —
  nenhum desses é a página de maior autoridade. Ação de painel (bloco "Temas"
  na home, item C do #5097) — não fechada em código, fica pro editor.
- **Achado 3 — cópia completa e rastreável nos Workers públicos em
  `*.diaria.workers.dev`.** `arquivo`/`cursos`/`livros` respondiam 200 com o
  conteúdo INTEIRO nesse host (canonical cross-host já apontava certo, mas
  não evitava o crawl). Fechado em código (#5097 item D): 301 (métodos
  seguros `GET`/`HEAD`) ou 308 (demais métodos, #5104 — preserva corpo no
  retry do cliente) incondicional pro host canônico quando `Host` não é o
  canônico, função pura `resolveWorkersDevRedirect`
  (`scripts/lib/shared/workers-dev-redirect.ts`), wired nos `fetch` handlers
  ANTES de qualquer outra lógica. **`artigo-mensal` (mesmo padrão
  `workers_dev = true` + `custom_domain`, sem passivo de link-legado)
  aplicado no mesmo mecanismo em #5104** — blind spot da auditoria original
  do #5097, não exclusão deliberada. `poll.diaria.workers.dev` fica DE FORA
  de propósito (compat de voto de ~233 edições publicadas, #3904).
  **`workers/artigos` também fica FORA — exclusão arquitetural, não blind
  spot:** é um Worker de static assets PURO (sem `main`/script — `[assets]`
  serve direto), então não há `fetch` handler pra chamar
  `resolveWorkersDevRedirect`; fechar esse host exigiria converter o Worker
  pra ter script (mesmo salto que `livros` deu no #4558 Parte C), fora de
  escopo de #5097/#5104.
- **Achado 4 — `diaria-dashboard` era público e indexável.** Servia 156 KB de
  HTML sem `X-Robots-Tag`, `robots.txt` sem nenhum `Disallow`. Fechado em
  código (#5097 item E): `X-Robots-Tag: noindex` em toda resposta +
  `GET /robots.txt` com `Disallow: /` incondicional.
- **Contra-verificado, NÃO era problema:** o root do arquivo já linka os 6
  hubs (`buildTemaNav`, #4749) — `href` relativos (`/temas/{slug}`), então
  auditoria por grep de URL absoluta concluiria "órfão" errado.

**Ação:** B/D/E (guard da home, redirect dos 3 Workers, noindex do dashboard)
mergeados com teste nesta mesma sessão — código fechado. A/C (trocar os 3
links da home, bloco "Temas") são ação de painel Beehiiv, pendentes do editor
— o eixo novo do home-meta-check é a prova contínua de que A não regride
depois de feito. **Re-medir no mesmo checkpoint ~29/set/2026 do Fato 1** com
`seo-index-check.ts` + `hub-index-coverage.ts` — não criar métrica, script
nem task nova (a instrumentação já existe); não aumentar a cadência entre
checkpoints (mesma disciplina do Fato 1).

## Fato 6 — `<html lang="en">` em toda página de edição é bug de plataforma da Beehiiv, não algo que se conserte daqui (12/ago/2026, #5101 item 1)

Toda página de edição publicada (`diar.ia.br/p/{slug}`) serve `<html lang="en"...>`
no HTML servido, apesar do conteúdo ser 100% pt-BR e de
`get_publication_settings` (MCP Beehiiv) devolver `"language": "pt"` —
config certa, HTML errado. Confirmado ao vivo em 12/ago/2026, 3 posts:

| Post | `<html lang>` servido | JSON embutido (`"language"`) |
|---|---|---|
| `diar.ia.br/p/empresas-pagam-43-mais-por-habilidades-em-ia` | `en` | `pt` |
| `diar.ia.br/p/openai-anuncia-controles-parentais-para-chatgpt` | `en` | `pt` |
| `diar.ia.br/p/microsoft-lan-a-ia-pr-pria` | `en` | `pt` |

(o 3º slug acima também ilustra o Fato do #5101 item 3 — título NFD virou
slug quebrado, "microsoft-lan-a-ia-pr-pria" em vez de
"microsoft-lanca-ia-propria"; ver PR que implementa 3a — normalização NFC do
título na fronteira de escrita — pra prevenção. **3a não fecha o item 3
inteiro**: o critério de pronto da issue também exige 3c, lint no Stage 4 que
rejeita título não-NFC, que este PR não implementa — ver checklist do #5101.)

O atributo `lang` do `<html>` renderizado é decidido pelo tema/template da
página web da Beehiiv, código que não vive neste repo e não é editável via
API/MCP — **não há workaround no nosso lado**. `edit_post`/`save_post`
(onde um campo de idioma por post, se existisse, estaria) já é conhecido
como gated pelo plano Launch/free (ver memory `beehiiv-plano-nao-sobe.md` e
`context/publishers/beehiiv-playbook.md` #1705/#2501) — mesmo que o campo
existisse, a mesma parede de plano provavelmente bloquearia a escrita.

**Ação:** nenhuma correção de código possível a partir deste repo. Registrar
aqui + recomendar que o editor abra ticket no suporte Beehiiv reportando
`<html lang="en">` servido apesar de `Settings → Publication → Language`
já estar em português — ação de fora do escopo de código (requer conta/
suporte da plataforma, mesma classe de bloqueio do "Label `local`"/bloqueio
externo do CLAUDE.md).

**Não fazer:** não tentar sobrescrever `lang` via JS injetado
(`javascript_tool`) — mesmo que tecnicamente possível num passo do playbook
de publicação, alterar o `<html>` renderizado depois do fato não muda o que
o crawler/bot recebe na 1ª resposta HTTP (SSR), só o DOM pós-hidratação no
browser — sem efeito real em SEO.

## Fato 7 — 1ª citação nominal em prosa (não link) desde o baseline zero, 11/ago/2026 (#5120)

`data/geo-citations/history.jsonl` tem 124 registros, dos quais **3 com
`cited: true`** — todos de **11/ago/2026**, provider `google`
(`gemini-2.5-flash`), painel `geral`, e todos na **mesma pergunta**: *"Existe
alguma newsletter brasileira que resume as notícias de IA todo dia?"*. Um dos
3 snippets erra o horário de envio ("todas as manhãs às 8h" — o envio
canônico é 06:00 BRT).

**Leitura honesta:** é **1 acerto repetido 3×** (mesmo provider, mesma
pergunta, mesmo dia — as 3 chamadas são reamostragens independentes da mesma
pergunta, não 3 perguntas diferentes acertando), não 3 acertos distintos. É
**menção nominal em prosa** ("a diar.ia.br envia...", "o site diar.ia.br
também mostra..."), não citação de fonte com link — o detector
(`scripts/lib/geo-citation-monitor.ts`) faz `indexOf(domain)` no texto da
resposta, então não distingue link de menção solta. O painel `hubs` segue em
**0** citações. Sinal fraco — mas é a 1ª variação da série desde 07/ago
(baseline "0 de 16", ver `docs/geo-citation-monitor-setup.md`), e "nunca
fomos citados" passou a ser factualmente errado a partir desta data.

**Não é ação desta nota** — registro pro checkpoint de acompanhamento
contínuo (`docs/geo-citation-monitor-setup.md` §"Critério de decisão").

## Fato 8 — o `ETag` do Worker `arquivo` não chegava ao cliente apesar de o código estar correto; corrigido com ETag fraco + 304 + fallback de KV na raiz (12/ago/2026, #5134)

**Correção do Fato 3 acima**: o #4909 (10-11/ago) registrou `Last-Modified` +
`ETag` em `GET /temas/{slug}` como entregues. Verificado ao vivo em
12/ago/2026 (#5134): `curl -sSI https://arquivo.diar.ia.br/temas/anthropic-claude`
mostrava `Cache-Control` e `Last-Modified`, mas **nenhum `ETag`** — mesmo
testando com `Accept-Encoding: identity` (descarta compressão como
explicação óbvia via curl). Investigação nesta sessão confirmou que o
código em si estava certo: invocar `worker.fetch()` diretamente (sem
Cloudflare no meio) devolve o header intacto na `Response` final — a mesma
checagem que o #4909 já fazia via teste automatizado, então "escrever um
teste que confere a resposta final" não teria pegado esse bug, porque o bug
não está no código deste repo.

**Hipótese mais provável, não 100% confirmável a partir deste worktree**:
comportamento documentado de CDNs/proxies reversos (Cloudflare incluso) de
descartar um `ETag` FORTE ao aplicar compressão automática (gzip/brotli) em
trânsito — um validador forte declara "byte-idêntico", que a compressão
invalida; um `ETag` FRACO (`W/"..."`) sinaliza "semanticamente
equivalente" e sobrevive à transformação. Isso é consistente com o sintoma
(o header simplesmente desaparece, sem erro) e é o fix padrão documentado
pra essa classe de problema.

**Implementado (não deployado por esta sessão — worktree isolado sem
credencial de produção):**

- `ETag` agora é sempre `W/"{hash}"` (fraco), nunca `"{hash}"` (forte).
- `GET /temas/{slug}` trata `If-None-Match` (RFC 7232, comparação fraca,
  suporta `*` e lista separada por vírgula) e `If-Modified-Since` (RFC 7231),
  com precedência de `If-None-Match` quando os dois headers vêm juntos —
  casando, devolve `304` com corpo vazio.
- A raiz (`/`) não depende mais de o fetch ao vivo do sitemap da Beehiiv dar
  certo pra responder: todo sucesso grava o HTML no KV
  (`cache:arquivo-root:html-v1`, reusa o namespace `CURSOS_SUBSCRIBERS` já
  bindado pros contadores ai-fetch, sem namespace novo); toda falha (rede,
  HTTP não-200, XML malformado) tenta servir esse fallback antes de cair no
  502 — que agora só acontece quando NUNCA houve um sucesso anterior pra
  cachear (ex: 1º request depois de um deploy novo, ou KV indisponível).

**Pendência explícita — verificação AO VIVO pós-deploy**: esta sessão não
teve acesso à Cloudflare de produção (worktree isolado de subagente
overnight). O editor (ou uma sessão local/develop com credencial) deve
rodar, depois do deploy:

```
curl -sSI https://arquivo.diar.ia.br/temas/anthropic-claude   # espera ver ETag: W/"..."
curl -o /dev/null -w '%{http_code}' -H 'If-None-Match: W/"<mesmo-etag>"' \
    https://arquivo.diar.ia.br/temas/anthropic-claude          # espera 304
```

Se o `ETag` fraco AINDA não aparecer, a hipótese de compressão está errada
e o problema é outra coisa na camada Cloudflare — não fica pra próxima
sessão reabrir a investigação sem esse dado.

## Fato 9 — o passo 3 do #4546 (submeter os 3 sitemaps de curadoria no GSC) só executou de verdade em 12/ago/2026

A issue #4546 foi fechada em **04/ago/2026**, mas os 3 sitemaps que
`scripts/gsc-submit-sitemaps.ts` existe pra submeter (`cursos`, `livros`,
`arquivo`) **não estavam** na propriedade. Medição direta da API do Search
Console em 12/ago, antes de qualquer ação desta sessão:

```
sc-domain:diar.ia.br → 2 sitemaps
  diar.ia.br/sitemap.xml          submetido 2026-07-27  0 erros
  arquivo.diar.ia.br/sitemap.xml  submetido 2026-08-11  0 erros
```

`cursos` e `livros` ausentes; o `arquivo` que estava lá entrou em **11/ago
04:09 UTC** — **não** pelo script (que submete os 3 de uma vez; se tivesse
rodado, os outros 2 estariam lá).

**O mecanismo exato dessa entrada é INFERIDO, não confirmado.** A hipótese
plausível é auto-descoberta (ou submissão manual na UI) logo depois que a
propriedade de prefixo `https://arquivo.diar.ia.br/` foi verificada no GSC,
umas 3h antes na mesma madrugada — ver o parágrafo de propriedades abaixo.
**Não atribuir ao `SubmitFeed` do Bing WMT** (Fato 3 acima): Bing Webmaster
Tools e Google Search Console são plataformas separadas e sem integração —
submeter sitemap num não cria entrada no outro. As duas coisas aconteceram na
mesma sessão de trabalho do #4909, o que torna fácil confundir coincidência
temporal com causa (esta nota errou nisso na 1ª redação, achado do review da
PR #5147).

Causa provável do passo nunca ter rodado: o próprio docstring de
`gsc-submit-sitemaps.ts` avisa que ele falha com 403 até o editor reaprovar o
OAuth com o scope `webmasters` de escrita (#4546 comentário 03/ago).

**Executado em 12/ago/2026 19:17 UTC** (`npx tsx scripts/gsc-submit-sitemaps.ts`):
os 3 `PUT` voltaram **HTTP 204**, e o Google baixou os 3 sitemaps entre 1 e 5
segundos depois, com **0 erros e 0 avisos** em cada. `sc-domain:diar.ia.br`
passou de 2 pra 4 sitemaps. Os dois novos são pequenos (1 `<loc>` cada, ambos
HTTP 200 em produção) — o ganho é modesto, mas o passo agora está de fato
fechado.

**Achado lateral: o aviso de 403 no docstring do script está desatualizado.**
O token OAuth atual (`data/.credentials.json`) já tem escrita — os 3 `PUT`
passaram sem nenhuma reaprovação no browser. Quem for ler aquele docstring
não deve concluir que precisa rodar `oauth-setup.ts` antes de tentar.

**Propriedades do GSC hoje** (mesma consulta, 12/ago): `sc-domain:diar.ia.br`
(owner, desde 27/jul, #4089), `https://diar.ia.br/` e
`https://arquivo.diar.ia.br/` (prefixo, criadas em 11/ago durante o #4909 —
foram elas que dispararam os e-mails "Comece a usar o Search Console" que o
editor recebeu), e `https://diaria.beehiiv.com/` como `siteUnverifiedUser`
(host legado; `GET .../sitemaps` nessa devolve **403, e isso é esperado** —
não é owner, não é bug).

**Não fazer:** não re-submeter os sitemaps periodicamente. O `PUT` é upsert e
não falha, mas resubmeter sem mudança de conteúdo não acrescenta informação
pro Google — mesma disciplina de erosão de confiança do `<lastmod>`/IndexNow
(Fato 3). Rodar de novo só se um sitemap NOVO entrar na lista
`CURADORIA_SITEMAPS`.

## Fato 10 — decisão negativa sobre Google News/Publisher Center, Bing News PubHub e MSN Partner Hub (12/ago/2026, #5132)

**Não perseguir Google News/Publisher Center.** Investigação exaustiva do
histórico do repo (`gh issue list --state all`) não achou nenhuma issue
prévia mencionando "Google News" ou "Publisher Center" — a porta nunca foi
avaliada por mérito, só nunca tentada. Quatro motivos fecham essa avaliação:

1. **Publisher Center parou de aceitar cadastro manual em 18/dez/2024** —
   elegibilidade hoje é automática, não existe etapa a cumprir. Ou o Google
   considera o site elegível, ou não; não há ação nossa que force a entrada.
2. **Não há forma ToS-safe de verificar pertencimento** a News ou Discover.
   Não existe API oficial de leitura, e consultar `news.google.com` por
   fetch seria automação de site de terceiro (proibido por princípio, ver
   CLAUDE.md). A única leitura autoritativa é o relatório Discover do
   próprio GSC — que só aparece quando há impressões, e resultado vazio **é**
   resposta. É por isso que o #5119 item 4 (fechado) puxa `type: "discover"`/
   `"news"` nas dimensões da chamada — é o caminho legítimo de resposta.
3. Os requisitos técnicos do Discover (`max-image-preview:large`, imagem
   ≥1200px, `NewsArticle`, autor identificável) moram todos no HTML do
   **apex** (`diar.ia.br/p/...`, servido pela Beehiiv), onde este repo não
   tem alavanca — mesma classe de bloqueio do Fato 6 acima.
4. **Achado novo aproveitável:** o sitemap da Beehiiv já emite markup válido
   de Google News por conta própria — `xmlns:news` declarado e
   `<news:news>` presente nas 2 URLs mais recentes (janela de 48h da spec),
   com `<news:language>pt</news:language>`. Isso **contradiz** o
   `<html lang="en">` do Fato 6 — a mesma plataforma declara `pt` no sitemap
   e serve `en` no HTML da página. Levado como munição concreta ao #5101
   item 1 (comentário postado, ver abaixo).

**Discover não está descartado, só não é acionável no apex hoje.** Se a
decisão do #5125 for construir uma superfície própria (fora do apex Beehiiv),
os requisitos técnicos do item 3 passam a ser implementáveis lá, e a leitura
de resultado segue vindo do #5119 item 4.

**Mesma família de descarte, dois agregadores de notícia adicionais** (bloqueio
externo, não omissão nossa):

- **Bing News PubHub** — aposentado para novos publishers em 2025, sem
  formulário de inscrição disponível.
- **MSN Partner Hub** — exige código de convite; não tem inscrição
  self-service.

Nenhuma linha de código muda por este Fato — decisão de escrita pura, para
que a frente Discover/News da épica #5116 pare de reabrir a cada auditoria.

## Quando adicionar entry aqui

Mesmo critério de `context/agents-known-issues.md`, aplicado a dado de SEO em
vez de comportamento de agent: um número/relatório de `data/seo/` que uma
sessão futura poderia reinterpretar como achado novo sem o contexto de quando
foi medido, por quê, e o que já foi verificado ao vivo.
