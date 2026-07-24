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
