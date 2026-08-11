# SEO — registro de fatos apurados (#4548)

Notas operacionais sobre a leitura do output de `scripts/seo-pull.ts` e
`scripts/seo-index-check.ts` (task semanal `Diaria-Seo-Weekly`,
`scripts/run-seo-weekly.ps1`, grava em `data/seo/`). Não é runbook de setup —
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

## Fato 3 — `/temas/` ganhou `lastmod`/`Last-Modified`/`ETag`, entrou na checagem de indexação, Bing WMT fechou ao vivo; IndexNow segue com o ping automático de deploy pendente (10-11/ago/2026, #4909)

Achado de auditoria (#4909, Refs #4558): o sitemap do Worker `arquivo`
(`arquivo.diar.ia.br/sitemap.xml`) não emitia `<lastmod>`, `GET
/temas/{slug}` não emitia `Last-Modified`/`ETag`, e as URLs `/temas/*`
nunca entravam na medição de `seo-index-check.ts` — ficavam fora de toda
medição de indexação do projeto.

**Implementado em `develop/fix-4909` (10/ago/2026):**

- `<lastmod>` por `<url>` no sitemap do `arquivo` (raiz = data mais recente
  entre os hubs; cada hub = seu `contentDate`, o mesmo valor já usado no
  JSON-LD — nunca uma fonte de data nova/paralela).
- `Last-Modified` + `ETag` em `GET /temas/{slug}`.
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

**O que ainda falta, e é a única pendência real desta issue:** o workflow
(`deploy-arquivo.yml:94`) lê a chave de `${{ secrets.INDEXNOW_KEY }}` — um
**secret separado do repositório no GitHub Actions**, não o secret do Worker
acima (são dois lugares distintos que precisam da MESMA string, achado
original do #4909). Confirmado em 11/ago/2026 via `gh secret list`: esse
secret **não existe** no repo. Resultado: todo deploy de `arquivo` que tocar
um `.generated.ts` cai no gate "`INDEXNOW_KEY` ausente" e sai sem pingar,
silenciosamente (não quebra o deploy — só não pinga). O ping automático a
cada deploy, que é o item 2 pedido pela issue original, **não está
funcional ainda** — só o CLI manual foi validado. Ação: `gh secret set
INDEXNOW_KEY` com o MESMO valor usado no `wrangler secret put` do Worker (o
valor não está recuperável do Worker, que é write-only — se ele não estiver
anotado em algum lugar seguro, mais simples gerar uma chave nova e
reprovisionar as duas pontas juntas).

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
em `.env.example`. Item 3 (Bing WMT) e item 1 (lastmod/ETag) fechados sem
pendência. **Item 2 (IndexNow) segue com uma pendência real** — ver acima:
falta o secret `INDEXNOW_KEY` no GitHub Actions do repo pro ping automático
de deploy funcionar.

## Quando adicionar entry aqui

Mesmo critério de `context/agents-known-issues.md`, aplicado a dado de SEO em
vez de comportamento de agent: um número/relatório de `data/seo/` que uma
sessão futura poderia reinterpretar como achado novo sem o contexto de quando
foi medido, por quê, e o que já foi verificado ao vivo.
