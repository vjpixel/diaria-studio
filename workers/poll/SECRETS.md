# workers/poll — Secrets manifest (#1415)

> **Função guard (#1420)**: `requiredSecretsForRoute(path, method)` e
> `missingSecretsForRoute(env, path, method)` em `workers/poll/src/index.ts`.
> Method-aware pra preservar 404 fallback em método errado.


Lista declarativa dos secrets que o Worker `poll` precisa em runtime. Usada
como referência quando o Worker é re-deployado/re-criado (secrets **não**
persistem em `wrangler deploy` após `delete + redeploy` — precisam ser
re-setados via `wrangler secret put`).

## Required secrets

| Nome | Var no `.env` local | Endpoint que depende | Severidade |
|------|---------------------|----------------------|------------|
| `POLL_SECRET` | `POLL_SECRET` | `/vote`, `/set-name` | **boot-critical** — sem ela, votos retornam 503 (#1420) |
| `ADMIN_SECRET` | `ADMIN_SECRET` | `/admin/correct` | **boot-critical** — sem ela, gabarito retorna 503 |

Rotas públicas (`/img/{key}`, `/stats`, `/leaderboard*`) **não** dependem de
secrets e continuam funcionando mesmo com manifest vazio.

## Optional secrets (#3580 — cadastro inline do jogo)

| Nome | Endpoint | Severidade |
|------|----------|------------|
| `BEEHIIV_API_KEY` | `POST /jogar/subscribe` | **opcional** — sem ela o endpoint responde 503 amigável e o form cai no fallback "assine pela página" (não é boot-critical, não usa o guard `missingSecretsForRoute`) |
| `BEEHIIV_PUBLICATION_ID` | `POST /jogar/subscribe` | **opcional** — idem acima |
| `BEEHIIV_NAME_FIELD` (var) | `POST /jogar/subscribe` | **opcional** — nome do custom field da Beehiiv onde gravar o nome; ausente = nome não é enviado (assinatura segue só com e-mail + UTM) |

O cadastro inline do "É IA?" standalone (#3580) assina direto na Beehiiv via
API pública (`POST /publications/{id}/subscriptions`). Enquanto os 2 secrets
acima não forem configurados, o form + validação + anti-abuso já funcionam,
mas a assinatura em si retorna 503 (`subscribe_unavailable`). Para ativar:

```bash
cd workers/poll
echo "$BEEHIIV_API_KEY"        | npx wrangler secret put BEEHIIV_API_KEY
echo "$BEEHIIV_PUBLICATION_ID" | npx wrangler secret put BEEHIIV_PUBLICATION_ID
# (opcional, pra capturar o nome — criar antes um custom field na Beehiiv):
# echo "Nome" | npx wrangler secret put BEEHIIV_NAME_FIELD
```

A `BEEHIIV_API_KEY` do worker deve ser uma key da Beehiiv com escopo de
criação de assinatura. Padrão apoia.se — **nunca** hardcodar no código.

## Optional secrets (#3996 — migração cross-device via link mágico)

| Nome | Endpoint | Severidade |
|------|----------|------------|
| `BREVO_API_KEY` | `POST /jogar/identify` (caminho com histórico órfão) | **opcional** — sem ela, `sendMagicLinkEmail` retorna `not_configured`; o merge fica **pendente indefinidamente** até o secret ser configurado (fail-closed do lado do merge — nunca mergeia sem confirmação, mesmo sem secret) |
| `BREVO_SENDER_EMAIL` (var) | idem | **opcional** — precisa ser um e-mail/domínio verificado na conta Brevo; ausente = mesmo `not_configured` acima |
| `BREVO_SENDER_NAME` (var) | idem | **opcional** — default `"Diar.ia — É IA?"` quando ausente |

Quando um jogador se identifica (`POST /jogar/identify`) com um e-mail que
**já tem histórico de ranking sob outro device/token** (nunca confirmado
como a mesma pessoa), o worker não mergeia na hora — manda um e-mail de
confirmação via API transacional da Brevo (`POST /v3/smtp/email`) com um
link `/confirm-merge?token=...`. Ver rationale completo em
`src/magic-link.ts`.

`BREVO_API_KEY` é um secret **PRÓPRIO** deste worker — **não** é o mesmo
runtime que os scripts Node do repo (`BREVO_CLARICE_API_KEY`, lido de
`process.env` num processo local/CI). O worker roda em Cloudflare Workers e
só enxerga secrets via `wrangler secret put`. O editor **pode** configurar
com o **mesmo valor** de `BREVO_CLARICE_API_KEY` (mesma conta Brevo) —
**desde que essa key tenha permissão de "transactional emails" habilitada**
na conta (não verificável a partir de um ambiente de desenvolvimento sem
acesso à conta Brevo real; confirmar no dashboard antes de configurar).

```bash
cd workers/poll
echo "$BREVO_API_KEY"       | npx wrangler secret put BREVO_API_KEY
# vars (não secrets — podem ir em [vars] do wrangler.toml, ou secret também
# funciona se preferir não deixar em texto plano no repo):
echo "$BREVO_SENDER_EMAIL"  | npx wrangler secret put BREVO_SENDER_EMAIL
echo "$BREVO_SENDER_NAME"   | npx wrangler secret put BREVO_SENDER_NAME
```

Sem estes 3 configurados, o mecanismo inteiro (detecção de histórico órfão +
geração de token + rate-limit + endpoint `/confirm-merge`) já funciona —
só o e-mail em si não sai até os secrets serem configurados.

## Optional secrets/bindings (#4054 — gate por rodada do caminho de fora)

| Nome | Endpoint | Severidade |
|------|----------|------------|
| `COOKIE_HMAC_SECRET` | `POST /jogar/gate/verify`, `POST /jogar/gate/subscribe`, `GET /jogar` (checagem de sessão), `GET /vote?brand=web` (identidade pós-gate) | **opcional** — sem ela, `/jogar/gate/verify` responde 503 mesmo pra assinante confirmado (nunca emite cookie sem segredo), e o resto do fluxo (rodada livre → gate → cadastro) cai de volta 100% no comportamento pré-#4054 (identidade anônima por token, sem sessão) |
| `SUBSCRIBERS_KV` (KV binding) | `POST /jogar/gate/verify` (verificação primária) | **opcional** — sem o binding, `checkWebSubscriber` cai direto no fallback Beehiiv (`BEEHIIV_API_KEY`/`BEEHIIV_PUBLICATION_ID`, já documentados acima) ou, sem os dois, trata todo mundo como "não verificado" — nunca lança |

`/jogar` (brand `web`, visitante de fora) passou a gatear por RODADA (#4054,
espelho de #4052/cursos): 1 rodada anônima livre, depois e-mail exigido pra
continuar/entrar no leaderboard. Login (assinante confirmado) OU cadastro
inline emitem um cookie de sessão HMAC-assinado (`web-gate.ts`) — origem de
identidade PARALELA ao token anônimo em `/vote` (nunca substitui o guard
#3976/#4011 que rejeita `?email=` cru no brand `web`).

```bash
cd workers/poll
openssl rand -hex 32 | npx wrangler secret put COOKIE_HMAC_SECRET
# opcional — pode reusar o MESMO valor do secret homônimo de workers/cursos
# (mesma decisão de design; worker/domínio diferentes, não precisa ser único)
npx wrangler kv namespace create SUBSCRIBERS_KV
# colar o id retornado em workers/poll/wrangler.toml, seção [[kv_namespaces]]
# a população é a MESMA de CURSOS_SUBSCRIBERS (assinante ativo da Diar.ia) —
# pode rodar scripts/sync-cursos-subscribers-kv.ts apontando pra este
# binding também, ou usar o MESMO namespace id nos dois workers
```

Sem `COOKIE_HMAC_SECRET`: o gate por rodada ainda ATIVA visualmente (a tela
de `/jogar/gate` aparece depois da 1ª rodada), mas login/cadastro nunca
emitem sessão — o visitante fica preso na tela de gate até o secret ser
configurado. Considerar isso ANTES de fazer deploy deste PR (o gate por
rodada é client-driven via cookie `eia_web_free_round_used`, não depende do
secret pra ATIVAR, só pra RESOLVER).

## Re-setar pós-deploy

Após qualquer `wrangler deploy` ou `delete + recreate` do worker, garantir
que os secrets estão presentes:

```bash
# Lê valores do .env local e set-a no worker via wrangler.
cd workers/poll
echo "$POLL_SECRET" | npx wrangler secret put POLL_SECRET
echo "$ADMIN_SECRET" | npx wrangler secret put ADMIN_SECRET
```

Validar pós-set:

```bash
cd /c/Users/pixel/Projects/diaria-studio
npx tsx scripts/poll-worker-healthcheck.ts
# Esperado: exit 0; check `secrets_guard` retorna 403 (sig inválido) ou 410
# (edição não-listada). 503 = ainda faltando secret. 500 = Worker crashed.
```

## Histórico

- 260520 (#1415): após `delete + redeploy` do worker pra fix de DNS (#1411),
  `wrangler deploy` re-uploadou código mas perdeu `POLL_SECRET` + `ADMIN_SECRET`.
  Endpoints autenticados retornaram 500 (error 1101) silenciosamente por ~3h
  até editor pedir validação manual. Fix #1420 fez o Worker retornar 503 com
  diagnóstico ao invés de 500. Esse manifest + healthcheck previnem que isso
  passe desapercebido na próxima.

## Quando adicionar secret novo

1. Editar `workers/poll/src/index.ts` `interface Env` adicionando o secret.
2. Editar `requiredSecretsForPath()` no mesmo arquivo se ele for boot-critical
   pra alguma rota.
3. Atualizar esta tabela (linha + descrição + severity).
4. Adicionar ao `.env.example`.
5. `wrangler secret put NOME_NOVO` no setup de cada máquina.
