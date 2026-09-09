# `workers/retrospectiva`

Serve as **três retrospectivas** da diar.ia.br num domínio só — `retrospectiva.diar.ia.br` — com o gate decidido pelo **formato do path**:

| path | conteúdo | gate | fonte da decisão |
|---|---|---|---|
| `/AAMM` | Retrospectiva do Mês | apoio **R$25+** (Mantenedor) | allowlist de e-mails no KV `ALLOWLIST` |
| `/AAAA` | retrospectiva anual (janeiro, ano civil) | cadastro grátis | assinante `active` no Kit |
| `/aniversarioAAAA` | retrospectiva de aniversário (agosto) | cadastro grátis | assinante `active` no Kit |

`especial.diar.ia.br` (**Artigo Especial**, apoio R$10+) **não** mora aqui: é outro produto, outro tier e outro mecanismo de gate (KV por hash de e-mail + cookie de sessão). Ver `workers/artigos`.

## Origem (#7658)

Este Worker é o antigo `workers/anual` renomeado — a base mais completa das duas, com rate-limit por IP, sitemap, robots e anti-probing — absorvendo o `workers/artigo-mensal`. Antes eram dois Workers, dois esquemas de URL (`anual.diar.ia.br/{slug}`, `artigo.diar.ia.br/{ciclo}`) e dois nomes de diretório que colidiam com o Artigo Especial (`workers/artigos` × `workers/artigo-mensal` — produtos diferentes, nomes quase idênticos).

A classificação do path é `scripts/lib/shared/retrospectiva-path.ts`, **compartilhada com os publishers** — é o que garante que a chave gravada no KV e a chave lida aqui não divirjam. Divergir daria 404 com o conteúdo publicado do lado.

## `/AAMM` × `/AAAA` colidem, e a regra é explícita

Os dois são 4 dígitos: `2607` é julho/2026, `2026` é o ano de 2026. A desambiguação é **os 2 últimos dígitos entre 01 e 12 fazem mês; o resto faz ano** — num módulo puro e testado, nunca improvisada no roteador. Consequências conhecidas e aceitas estão na docstring do módulo (`/2601` lê-se janeiro/2026, nunca o ano 2601).

## Fail-closed, nos dois gates

Qualquer ambiguidade — KV fora do ar, Kit indisponível, allowlist ausente ou corrompida, e-mail vazio — **nunca** serve a edição completa. O gate de cadastro é, além disso, **anti-probing**: não-cadastrado, estado desconhecido e falha de verificação devolvem a mesma resposta, então testar e-mails em massa não distingue os três.

## Hosts antigos

`anual.diar.ia.br` e `artigo.diar.ia.br` continuam respondendo — por este mesmo Worker — com **301** pro path novo, preservando a query. Os links antigos já saíram em e-mail com UTM; quebrar perde clique e mede errado. A tradução usa as mesmas funções puras dos publishers (`anualPathFromSlug`, `mensalPathFromCycle`), não um mapa à mão por edição.

## Cutover (uma vez, na primeira publicação)

⚠️ Os dois domínios legados estão atrelados aos Workers `anual` e `artigo-mensal`. Um `wrangler deploy` daqui **não os toma sozinho** — o deploy falha com "domínio já em uso". Ordem segura, que não derruba o que está no ar:

1. **Deploy só do host novo.** Comentar temporariamente os dois blocos `[[routes]]` legados no `wrangler.toml` e rodar `npx wrangler deploy`. Isso publica `retrospectiva.diar.ia.br` sem tocar em nada que já serve tráfego.
2. **Republicar o conteúdo sob as chaves novas**, no namespace `ARTICLES` deste Worker:
   ```bash
   npx tsx scripts/build-article-page.ts --cycle 2608-09 --push   # → article:2608
   npx tsx scripts/build-article-page.ts --cycle 2607-08 --push   # → article:2607
   npx tsx scripts/build-article-page.ts --cycle 2606-07 --push   # → article:2606
   npx tsx scripts/build-article-page.ts --cycle 2605-06 --push   # → article:2605
   npx tsx scripts/build-article-page.ts --cycle 2604-05 --push   # → article:2604
   ```
   (a anual entra por `scripts/build-annual-page.ts --slug {slug} --push` quando houver edição publicada).
3. **Conferir** cada path novo ao vivo, com e sem `?email=`, antes de mexer nos domínios antigos.
4. **Soltar os domínios legados**: remover os blocos `[[routes]]` de `workers/anual`/`workers/artigo-mensal` e re-deployar os dois — ou desanexar pelo painel da Cloudflare.
5. **Reanexar aqui**: descomentar os dois blocos legados e `npx wrangler deploy` de novo. A partir daí os hosts antigos redirecionam.
6. **Apagar os Workers antigos** (`anual`, `artigo-mensal`) no painel, já sem domínio.

O passo 3 é o que torna isso reversível: enquanto os domínios antigos não se moveram, o estado anterior continua servindo normalmente.

## KV

| binding | uso |
|---|---|
| `ARTICLES` | HTML pré-renderizado, `article:{path}` (completo) e `article:{path}:teaser` (trecho). Namespace **único** — a chave já distingue mensal de anual pelo formato do path. |
| `ALLOWLIST` | `emails` (JSON array) — apoio Mantenedor/Patrono, populada por `scripts/build-apoiador-allowlist.ts --push`. Só `/AAMM` consulta. |
| `RATE_LIMIT` | contadores do rate-limit por IP do gate de cadastro. |

Os ids vivem no `wrangler.toml` e são lidos pelos publishers via `scripts/lib/shared/retrospectiva-kv-namespaces.ts` — uma fonte só, a mesma que o `wrangler deploy` consome.
