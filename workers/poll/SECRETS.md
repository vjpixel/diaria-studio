# workers/poll — Secrets manifest (#1415)

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
