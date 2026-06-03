# draft Worker (#1239)

Worker dedicado pra hospedar HTML preview da newsletter Diar.ia.

URL: `https://draft.diaria.workers.dev/{edition}`

## Por que existe

Separação de responsabilidade — o Worker `poll` (`https://poll.diaria.workers.dev`) faz voto/imagem/stats do É IA?; o Worker `draft` faz HTML preview pra paste no Beehiiv via Chrome MCP. Namespaces KV separados evitam conflito de keys e permitem TTL/policy independentes.

## Rotas

- `GET /{key}` → retorna HTML armazenado no KV
- `PUT /{key}` → grava HTML (auth via HMAC ADMIN_SECRET, TTL 90d — #1782)
- `OPTIONS /{key}` → preflight CORS

## Deploy (one-time setup)

```bash
cd workers/draft

# 1. Criar KV namespace dedicado
npx wrangler kv namespace create DRAFT --remote
# → copia o id retornado e cola em wrangler.toml (substitui REPLACE_WITH_NAMESPACE_ID)

# 2. Setar ADMIN_SECRET (mesmo valor do poll pra compat de assinaturas HMAC)
npx wrangler secret put ADMIN_SECRET
# → cola o valor quando solicitado

# 3. Deploy
npx wrangler deploy
# → confirma URL no output: https://draft.diaria.workers.dev
```

## Tests

```bash
node --import tsx --test test/workers-draft.test.ts
```

Cobre handlers GET/PUT, auth HMAC, validação de input, CORS preflight.
Não testa KV real (mock interno) — smoke test via curl post-deploy.

## Histórico

- **#1239** — Extraído do antigo Worker `diar-ia-poll` (rotas `/html/{key}`). Após grace period, os handlers `/html/{key}` foram removidos do Worker irmão (ver `workers/poll/src/index.ts:481-484`); este Worker é o único caminho ativo pra HTML preview.
- **#1312** — Worker irmão renomeado de `diar-ia-poll` → `poll` (subdomínio público `https://poll.diaria.workers.dev`). Comentários neste pacote referem-se ao nome novo.
