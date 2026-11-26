# Inventário de retry HTTP — #14127

Levantamento em 26/11/2026, antes da substituição. A estimativa de ~20 da
issue não é um total confirmado: a busca abaixo encontra também polling,
locks, filesystem, subprocessos e operações compostas. Não se deve migrar
um loop só porque ele contém uma chamada HTTP.

Busca reproduzível (fora de `test/`):

```sh
rg -n 'for \(let (attempt|attemptIndex|i = 0; i <.*(attempt|retr))|while .*retr' scripts --glob '*.ts'
rg -n 'maxRetries|MAX_ATTEMPTS|RETRY.*MS' scripts --glob '*.ts'
rg -l 'fetch-retry' scripts --glob '*.ts'
```

## HTTP: decisão por contrato

| Local / operação | Decisão e motivo |
| --- | --- |
| `lib/jev.ts::askJev` | Migrado. Avaliação, não publicação. Só 429 autoriza repetir; `maxRetries + 1` tentativas, backoff exponencial, sem Retry-After, sem retry de rede/5xx/JSON. Preservados erro original, corpo final e timeout inclusive durante leitura do corpo. |
| `lib/drive-helpers.ts::gFetchRetry` | Preservado. Compartilhado por GET, PATCH e POST de criação de pasta; sem chave idempotente. Também lança no último status transitório, tem jitter e não estabelece timeout próprio. Não mudar o contrato de escrita por causa dos leitores. |
| `lib/brevo-client.ts::withBrevo429Retry`, `brevoGet` | Preservados. Quota por conta/hora, headers de quota, desistência imediata quando Retry-After excede orçamento, erro tipado e reconciliação de allowlist. `honorRetryAfter` genérico limita espera e retenta; não equivale à desistência da Brevo. |
| `lib/brevo-client.ts::brevoGetWithNetworkRetry`, lookup de committed | Preservados. Só TypeError, mesmo erro relançado; lookup agrega duas consultas e lista histórica. Não são retry de uma Response. |
| `lib/worker-queue-client.ts::postToWorkerQueue` | Preservado. Payload aceita chave opcional; retry inclui parse/schema, logs e erro HTTP tipado com corpo/code. Não ampliar retry de POST sem chave. |
| `publish-linkedin.ts` (Make webhook) | Preservado: publisher POST sem idempotency key, dependências #14010/#14011 citadas na issue. |
| `publish-threads.ts` | Preservado: operação composta container/poll/publicação, raiz parcial e send_unknown impedem republicação. |
| `lib/facebook-publish-retry.ts` | Preservado: lookup de scheduled_posts após envio ambíguo e estado send_unknown. |
| `lib/instagram-immediate-publish.ts` | Preservado: criação de container separada da publicação do mesmo container; reconcilia PUBLISHED antes de repetir. |
| `verify-emails-mv.ts`, `verify-pending-emails-mv.ts` | Preservados: API paga; retentam erro no JSON e corpo ilegível além de 429/5xx, interrompem em key/crédito e o primeiro suporta interrupção. Helper de Response não representa esse contrato. |
| `lib/diaria/clarice-correct-engine.ts` | Preservado: operação de correção/parse com política e callback de observabilidade por tentativa, não só Response. |
| `lib/backup-offsite.ts` (bulk get KV) | Preservado: operação decodificada; 401/403 abortam, falhas esgotadas acionam fallback GET por chave e registram causas. |
| `lib/r2-object-upload.ts::reuseOrUploadToR2` | Preservado: só R2NetworkError, reconfirma tamanho/ETag por HEAD antes de repetir PUT; 5xx e timeout não retentam. |
| `lib/drive-download.ts` | Preservado: só tamanho divergente repete download inteiro, orçamento único, streaming e posse exclusiva de .part. |
| `lib/diaria/video-montage-drive.ts` | Preservado: upload resumível, probe dos bytes confirmados e lookup de arquivo antes de nova sessão; evita duplicar arquivo. |
| `clarice-sync-brevo.ts` (CSV exportado) | Preservado: só 404 após export; retry da operação `downloadCsv` com contrato próprio, não de qualquer erro HTTP. |
| `lint-test-email-image-freshness.ts` | Preservado: repete fetch + leitura de bytes; null engloba falha do corpo. Helper encerra na Response. |

## Polling e operações que não são retry HTTP

| Locais | Condição real de repetição / motivo para preservar |
| --- | --- |
| `lib/worker-queue-client.ts::findWorkerQueueEntryByIdempotencyKey` | Ausência da chave no KV após leitura bem-sucedida; erro aborta imediatamente. |
| `lib/threads-api.ts`, `lib/brevo-process-poll.ts`, `lib/brevo-client.ts` pós-sendNow | Esperam estado terminal do container/processo/campanha, mesmo com HTTP 200. |
| `lib/artigo-especial-probe.ts` | Espera documento correto (og:url + gate), não apenas 200. |
| `lib/clarice-list-consolidation.ts` (spot-check pós-add) | Espera contato aparecer na lista histórica antes de autorizar remoção; HTTP 200 ainda pode não confirmar associação. |
| `lib/diaria/instagram-first-comment-retry.ts`, `retry-instagram-first-comment.ts` | Retry persistido entre execuções do timer; sending/uncertain impedem novo POST. Não é loop HTTP em memória. |
| `lib/onboarding-kit-pilot.ts`, `clarice-schedule-ramp.ts` | Esperam propagação de tag/audiência e contagem mínima. |
| `verify-social-worker-dispatch.ts` | Verificação de dispatch, não reenvio do POST. |
| `check-pr-bugfix.ts`, `check-agent-eval-required.ts`, `check-editorial-signoff.ts`, `lib/pr-body-fetch.ts` | Subprocesso gh; API não exposta como Response. |
| `lib/mcp-guard.ts` | Operação MCP com timeout e halt banner. |
| `lib/transient-step-retry.ts` | Retry de passo com classificação de falha, não uma Response. |
| `onboarding-kit-transport-run.ts` | Marcação idempotente de tag; 429 detectado na exceção da dependência Kit, sem Response disponível. |
| `lib/sqlite-busy-retry.ts`, `lib/sessions/store.ts`, `lib/atomic-write.ts`, `lib/source-runs.ts`, `lib/task-runner.ts`, `overnight-statusline.ts` | Banco/arquivo/log local e concorrência. |
| `publish-edition-site-page.ts` | Lock de publicação; não reenvio HTTP. |
| `publish-shorts.ts` | Upload Facebook por blocos: mesma sessão/offset, interpreta JSON inclusive em 2xx; não é reenvio genérico. |
| `archive-video-brutos.ts` | Lock local com detecção de PID vivo e remoção de lock obsoleto. |
| `video-montagem.ts` | Rename com arquivo aberto e render/cópia com verificação de frames. |
| `eia-compose.ts` | Busca outra data do Wikimedia até encontrar imagem elegível; requests diferentes. |
| `lib/edition-stage-runner.ts` | Espera de processo em background. |

`lib/fetch-retry.ts` já contém o loop canônico; seus importadores existentes
não são duplicação a migrar. As exceções acima são deliberadas: uma migração
futura exige preservar o contrato específico, sem somar retries aninhados nem
habilitar reenvio de publisher POST sem chave idempotente.
