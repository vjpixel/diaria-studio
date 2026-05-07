# Cloudflare Worker `diaria-linkedin-cron` Setup

One-time setup pra ativar agendamento real de posts LinkedIn da Diar.ia. Substitui a abordagem Make.com Data Store (que não funcionou — ver `feedback_make_searchrecord_mapping_unsolved.md` na memory). PC pode estar desligado — o cron roda na Cloudflare.

## Arquitetura

```
publish-linkedin.ts --schedule
        │
        │ POST /queue { text, image_url, scheduled_at, destaque }
        ▼
┌──────────────────────────────┐
│  diaria-linkedin-cron        │
│  (Cloudflare Worker)         │
│  ─ KV: queue:{uuid}          │
│  ─ cron */30 * * * *         │ ← a cada 30min
└──────────────────────────────┘
        │ scheduled_at <= now?
        │ se sim: POST {payload}
        ▼
┌──────────────────────────────┐
│  Make webhook                │
│  Scenario "Integration       │
│  LinkedIn"                   │
└──────────────────────────────┘
        │ Make → LinkedIn API
        ▼
   LinkedIn company page
```

## Pré-requisitos

- Conta Cloudflare ativa
- `wrangler` instalado globalmente (`npm i -g wrangler`)
- Make webhook do Scenario `Integration LinkedIn` funcionando (ver `make-linkedin-setup.md`)
- Token aleatório pra autenticar `POST /queue` (gera com `openssl rand -hex 32`)

## Passo 1 — Login Cloudflare

```bash
wrangler login
```

## Passo 2 — Criar KV namespace

```bash
cd workers/linkedin-cron
wrangler kv:namespace create LINKEDIN_QUEUE
```

Saída:
```
🌀 Creating namespace with title "diaria-linkedin-cron-LINKEDIN_QUEUE"
✨ Success! Add the following to your wrangler.toml:
[[kv_namespaces]]
binding = "LINKEDIN_QUEUE"
id = "abc123..."
```

Cole o `id` retornado em `workers/linkedin-cron/wrangler.toml` substituindo `REPLACE_WITH_KV_ID`.

## Passo 3 — Configurar secrets

```bash
# Token compartilhado entre Worker e publish-linkedin.ts
wrangler secret put DIARIA_TOKEN
# Cola um valor random hex 32 bytes (gera com `openssl rand -hex 32`)

# URL do webhook Make (Scenario A)
wrangler secret put MAKE_WEBHOOK_URL
# Cola: https://hook.us2.make.com/2alvu89nbn9uo5tpvnjnhpbu22uf1sb6
```

## Passo 4 — Deploy

```bash
cd workers/linkedin-cron
npm install
npm run deploy
```

Saída esperada:
```
Total Upload: ~10 KiB / gzip: ~3 KiB
Uploaded diaria-linkedin-cron
Deployed diaria-linkedin-cron
  https://diaria-linkedin-cron.diaria.workers.dev
Triggers
  - Schedule: */30 * * * *
```

## Passo 5 — Configurar a Diar.ia

Em `.env.local` (gitignored, recomendado):

```bash
DIARIA_LINKEDIN_CRON_URL=https://diaria-linkedin-cron.diaria.workers.dev
DIARIA_LINKEDIN_CRON_TOKEN=<mesmo token que setou via wrangler secret>
```

Ou em `platform.config.json` → `publishing.social.linkedin.cloudflare_worker_url` (já preenchido). Token só vai em env (não commitar).

## Passo 6 — Testar

### 6.1 Health check (sem auth)

```bash
curl https://diaria-linkedin-cron.diaria.workers.dev/health
```

Saída esperada:
```json
{
  "status": "ok",
  "queue_size": 0,
  "next_scheduled": null,
  "server_time": "2026-05-07T01:00:00.000Z"
}
```

### 6.2 Enfileirar um post de teste

```bash
curl -X POST https://diaria-linkedin-cron.diaria.workers.dev/queue \
  -H "X-Diaria-Token: <seu-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Teste do cron do LinkedIn — Diar.ia",
    "image_url": null,
    "scheduled_at": "2026-05-07T01:35:00-03:00",
    "destaque": "d1"
  }'
```

Saída:
```json
{
  "queued": true,
  "key": "queue:abc-123-...",
  "scheduled_at": "2026-05-07T01:35:00-03:00",
  "destaque": "d1"
}
```

### 6.3 Verificar fila

```bash
curl -H "X-Diaria-Token: <seu-token>" \
  https://diaria-linkedin-cron.diaria.workers.dev/list
```

### 6.4 Aguardar cron

O cron roda a cada 30min. Quando `scheduled_at` chegar, o item é firado. Verifique:
- Logs do Worker: `wrangler tail` (em `workers/linkedin-cron/`)
- Logs Make: dashboard scenarios → execuções
- LinkedIn company page: post deve aparecer

## Como funciona no pipeline

`publish-linkedin.ts --schedule` decide route baseado em `scheduled_at`:

- Se `scheduled_at > now` E Worker URL+Token configurados: **POSTa pro Worker `/queue`**. Worker grava em KV. Cron fira na hora certa.
- Se `scheduled_at <= now` OU Worker não configurado: **POSTa direto pro Make webhook** (comportamento original — Make posta imediatamente).

Resume-aware: posts já com `worker_queue_key` em `06-social-published.json` são pulados na re-rodagem (status `scheduled`).

## Custos

Cloudflare Workers (free tier):
- 100k requests/dia (sobra)
- 30 cron triggers/dia (usamos 48 — pode upgrade pra Workers Paid $5/mês se virar problema, ou aumentar interval)
- 1GB KV storage (mais que suficiente)

Free tier deve cobrir.

## Troubleshooting

| Erro | Causa | Solução |
|------|-------|---------|
| 401 unauthorized em /queue | Token errado | Conferir `wrangler secret put DIARIA_TOKEN` e env `DIARIA_LINKEDIN_CRON_TOKEN` |
| 503 / scheduled_at parsing | Data invalida | Usar ISO 8601 com timezone (ex: `2026-05-07T09:00:00-03:00`) |
| Cron não dispara | Worker desativado / kv vazio | `wrangler tail` pra ver logs; checar `/health` |
| Post não chega no LinkedIn | Make webhook quebrou | Verificar Scenario A do Make ativo + connection LinkedIn válida |

## Referências

- Setup Make: `docs/make-linkedin-setup.md`
- Memory: `project_linkedin_scheduling_pivot.md`
- Memory: `reference_make_diaria_ids.md`
