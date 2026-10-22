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

Retries do Kit (#10722): o corpo do webhook não traz id de evento, então cada
tentativa de entrega ganha chave própria no KV. A ingestão descarta como retry
o evento do mesmo assinante, tipo e URL a até 30 min de um já ingerido
(`KIT_WEBHOOK_RETRY_DEDUPE_MS`); o KV guarda todas as tentativas.

## Estado

Ligado em 21/10/2026 (`/diaria-develop 261021`):
- passo 1: KV `KIT_EVENTS` criado e declarado em `wrangler.toml`;
- passo 2: segredos do Worker `KIT_WEBHOOK_SECRET` e `EVENTS_READ_TOKEN`; no
  Doppler, `KIT_WEBHOOK_SECRET`, `KIT_EVENTS_READ_TOKEN` (mesmo valor do
  `EVENTS_READ_TOKEN`) e `KIT_EVENTS_URL`;
- passo 3: webhooks `unsubscribe`, `bounce`, `complaint` e `activate` registrados
  no Kit. Os de `click` (um por link) não foram registrados;
- passo 5: a ingestão roda como 2º passo da task `Diaria-Kit-Roster-Ingest`
  (04:25 BRT), com `--write`. Rodada manual sem `--write` só lê (escritor único). No `300`, o `.env` precisa das duas vars `KIT_EVENTS_*`
  (`npm run sync-env`); sem elas, a ingestão com `--write` sai 1 e a unit
  fica failed, para o alarme de units falhas avisar (#10788). O dry-run manual
  só avisa.

Se os segredos forem removidos, o Worker volta a não gravar nada (POST responde
404, leitura responde 401/503).

## Como ligar (sessão `/diaria-develop` com o editor)

1. `cd workers/kit-events && npx wrangler kv namespace create KIT_EVENTS` e
   declarar o binding em `wrangler.toml` (bloco `[[kv_namespaces]]` lá), via PR.
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

O segredo faz parte da URL registrada no Kit. Rotação é uma ação de conta,
executada pelo editor em sessão supervisionada; não publicar valores em issues,
PRs, comandos com argumento literal ou logs.

1. Confirmar o deploy da configuração de logs abaixo antes de usar o novo segredo.
2. Gerar um segredo novo com ≥24 caracteres e guardar em local seguro.
3. Executar `npx wrangler secret put KIT_WEBHOOK_SECRET` em `workers/kit-events`
   e informar o valor pelo prompt interativo.
4. Recriar os webhooks no Kit com a URL nova e os mesmos eventos e
   `initiator_value` dos anteriores. Remover os registros antigos.
5. Conferir as entregas no Kit e a ingestão com `--dry-run`, sem copiar URLs
   com segredo para o terminal ou relatórios. Os endpoints antigos retornam 404.

Há uma janela entre os passos 3 e 4 em que as URLs antigas falham; fazer a
troca numa janela supervisionada e conferir eventuais falhas de entrega no Kit.
Rotacionar `EVENTS_READ_TOKEN` separadamente exige atualizar também
`KIT_EVENTS_READ_TOKEN` no servidor.

## Logs e segredo na URL (#10724)

`wrangler.toml` desliga explicitamente a observabilidade persistida
(`enabled = false`, amostragem zero). O workflow de deploy existente aplica
essa política após o merge; alterar só o código do handler não mascara os
metadados de invocação coletados pela plataforma. Reduzir a amostragem para
um valor positivo ainda permite registrar o segredo.
Referência: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

Isso também elimina os logs persistidos de erros do Worker. Acompanhar as
entregas pelo Kit e pela ingestão local. Não usar `wrangler tail` nem adicionar
Tail Workers/Logpush sem revisar a exposição das URLs. Esta configuração não
apaga logs anteriores nem configura coletores externos da conta: se o segredo
já foi usado com coleta ligada, tratá-lo como exposto e executar a rotação
acima após o deploy. Verificar retenção e acesso aos logs históricos é ação
externa, a cargo do editor.
