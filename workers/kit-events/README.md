# kit-events (#10648): webhooks do Kit com horário

Grava cada cancelamento, clique, bounce, reclamação e ativação de assinante do
Kit, com o horário em que chegou, para responder "o que essa pessoa fez, com dia
e hora, antes de sair". A API v4 do Kit não tem endpoint de atividade por
assinante, então o webhook é o único caminho.

Contrato (rotas, chave do KV, formato do registro):
`scripts/lib/kit-webhook-events-contract.ts`. Ingestão local:
`scripts/diaria-subscribers-ingest-kit-webhooks.ts`, que grava na tabela
`kit_webhook_event` do `diaria-subscribers-db`.

Aberturas não têm webhook no Kit e continuam vindo da ingestão por broadcast.

## Estado

Código e deploy automático prontos. Sem KV e sem segredos, o Worker publicado
não grava nada (POST responde 404, leitura responde 401/503). Nenhum webhook do
Kit aponta pra cá ainda.

## Como ligar (sessão `/diaria-develop` com o editor)

1. `cd workers/kit-events && npx wrangler kv namespace create KIT_EVENTS` e
   declarar o binding em `wrangler.toml` (bloco comentado lá), via PR.
2. Gerar 2 segredos longos (≥24 caracteres; ex. `openssl rand -hex 24`):
   - `npx wrangler secret put KIT_WEBHOOK_SECRET` — vai na URL dos webhooks.
   - `npx wrangler secret put EVENTS_READ_TOKEN` — mesmo valor em
     `KIT_EVENTS_READ_TOKEN` no `.env` do servidor, junto com
     `KIT_EVENTS_URL=https://kit-events.<conta>.workers.dev`.
3. Registrar um webhook por evento no Kit (`POST /v4/webhooks`, ou o MCP
   `create_webhook`), com `target_url` = `{KIT_EVENTS_URL}/webhook/{KIT_WEBHOOK_SECRET}/{tipo}`:

   | `{tipo}`      | `event.name` no Kit                    |
   |---------------|----------------------------------------|
   | `unsubscribe` | `subscriber.subscriber_unsubscribe`    |
   | `bounce`      | `subscriber.subscriber_bounce`         |
   | `complaint`   | `subscriber.subscriber_complain`       |
   | `activate`    | `subscriber.subscriber_activate`       |
   | `click`       | `subscriber.link_click` (ver abaixo)   |

   O tipo vai na URL porque o corpo do webhook do Kit não diz qual evento
   disparou. O corpo também não traz horário: o registrado é o de recebimento.

   `subscriber.link_click` exige `initiator_value` com a URL de UM link, então
   é um webhook por link acompanhado. Repetir a URL no endpoint para ela ficar
   gravada: `.../webhook/{segredo}/click?url={URL codificada}`.
4. Conferir com `GET /v4/webhooks` e, depois do 1º evento real,
   `npx tsx scripts/diaria-subscribers-ingest-kit-webhooks.ts --dry-run`.
5. Agendar a ingestão (ex. junto da ingestão diária do Kit).

## Trocar o segredo

O segredo faz parte da URL registrada no Kit. Para trocar: `wrangler secret put
KIT_WEBHOOK_SECRET` com o novo valor e recriar os webhooks no Kit com a URL
nova (os antigos passam a receber 404).
