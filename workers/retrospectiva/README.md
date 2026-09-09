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

## Cutover — FEITO em 09/09/2026

Executado e verificado ao vivo. Os três domínios estão anexados a este Worker; `anual` e `artigo-mensal` foram apagados da conta. O que ficou registrado, porque o roteiro original estava errado num ponto que tirou dois hosts do ar por **2min46s** — janela fechada, medida em `wrangler deployments list`:

| horário (UTC) | versão | o que foi |
|---|---|---|
| 03:39:49 | `76791f17` | deploy automático da CI no merge — anexa os TRÊS domínios |
| **03:41:28** | `13d60da8` | meu "passo 1" com as rotas legadas comentadas — **remove** `anual.` e `artigo.`, apaga o DNS |
| 03:41:54 | `77bdffe0` | `wrangler secret put KIT_API_KEY` |
| **03:44:14** | `7a9e9e9a` | re-deploy com o arquivo íntegro — os três domínios voltam |

(a propagação de DNS acrescenta uma cauda além dessa janela; o intervalo acima é o tempo em que os domínios não estavam anexados a Worker nenhum.)

**`deploy-retrospectiva.yml` dispara no merge.** No instante em que a PR entra em `master`, a CI publica o Worker com o `wrangler.toml` versionado — incluindo os três `custom_domain`. Ou seja, a CI faz o passo de mover os domínios sozinha, antes de qualquer ação manual.

O roteiro anterior mandava começar com um "deploy só do host novo", com as rotas legadas comentadas, "sem tocar em nada que já serve tráfego". Depois que a CI já anexou os domínios aqui, essa frase deixa de valer: **comentar uma rota e deployar REMOVE o custom domain e apaga o DNS**. Foi o que derrubou `anual.` e `artigo.` entre 03:41:28 e 03:44:14, até o re-deploy com o arquivo íntegro.

### Se um dia for preciso repetir isto (outro Worker, outro rename)

1. Faça o trabalho de CONTEÚDO antes do merge — republicar o KV sob as chaves novas, criar as secrets no Worker novo (**secrets não migram no rename**; `KIT_API_KEY` teve que ser recriada), e conferir pelo `*.workers.dev`, que não depende de custom domain.
2. Só então mergeie. A CI publica e move os domínios de uma vez.
3. Confira o estado real com `GET /accounts/{id}/workers/domains` — foi o que detectou o problema — e com um 301 de verdade em cada host antigo.
4. Apague os Workers antigos só depois, e só depois de conferir que não têm mais domínio nem rota: enquanto existem, reanexar um domínio a eles é o rollback mais rápido.

Nunca deploye este Worker com rota comentada esperando que isso "adie" alguma coisa.

## KV

| binding | uso |
|---|---|
| `ARTICLES` | HTML pré-renderizado, `article:{path}` (completo) e `article:{path}:teaser` (trecho). Namespace **único** — a chave já distingue mensal de anual pelo formato do path. |
| `ALLOWLIST` | `emails` (JSON array) — apoio Mantenedor/Patrono, populada por `scripts/build-apoiador-allowlist.ts --push`. Só `/AAMM` consulta. |
| `RATE_LIMIT` | contadores do rate-limit por IP do gate de cadastro. |

Os ids vivem no `wrangler.toml` e são lidos pelos publishers via `scripts/lib/shared/retrospectiva-kv-namespaces.ts` — uma fonte só, a mesma que o `wrangler deploy` consome.
