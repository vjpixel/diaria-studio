# draft Worker (#1239)

Worker dedicado pra hospedar HTML preview da newsletter Diar.ia.

URL: `https://draft.diaria.workers.dev/{edition}`

Substitui (em conjunto com migração no `upload-html-public.ts`) a rota legada
`https://diar-ia-poll.diaria.workers.dev/html/{edition}` que ficava no Worker
`diar-ia-poll`. Separação de responsabilidade — poll faz voto/imagem/stats,
draft faz HTML preview.

## Rotas

- `GET /{key}` → retorna HTML armazenado no KV
- `PUT /{key}` → grava HTML (auth via HMAC ADMIN_SECRET, TTL 12h)
- `OPTIONS /{key}` → preflight CORS

## Deploy (one-time setup)

```bash
cd workers/draft

# 1. Criar KV namespace dedicado
npx wrangler kv namespace create DRAFT --remote
# → copia o id retornado e cola em wrangler.toml (substitui REPLACE_WITH_NAMESPACE_ID)

# 2. Setar ADMIN_SECRET (mesmo valor do diar-ia-poll pra compat de assinaturas)
npx wrangler secret put ADMIN_SECRET
# → cola o valor quando solicitado

# 3. Deploy
npx wrangler deploy
# → confirma URL no output: https://draft.diaria.workers.dev
```

## Migração

Plano:

1. **Deploy** este Worker (acima)
2. **Atualizar** `scripts/upload-html-public.ts` pra apontar pra
   `https://draft.diaria.workers.dev/{edition}` em vez de
   `https://diar-ia-poll.diaria.workers.dev/html/{edition}`
3. **Grace period** (~1 semana): manter rota `/html/{key}` no Worker
   `diar-ia-poll` ativa pra emails antigos
4. **Cleanup**: remover handlers HTML do `workers/poll/src/index.ts`

## Update do `upload-html-public.ts`

Já foi feito em conjunto com este PR — script tenta nova URL primeiro,
faz fallback pra `diar-ia-poll` se nova retorna erro. Esse comportamento
permite o PR mergear antes do deploy do novo Worker (sem quebrar fluxo
atual).

Depois do deploy do novo Worker, abrir issue follow-up pra remover o
fallback.

## Tests

```bash
node --import tsx --test test/workers-draft.test.ts
```

Cobre handlers GET/PUT, auth HMAC, validação de input, CORS preflight.
Não testa KV real (mock interno) — smoke test via curl post-deploy.
