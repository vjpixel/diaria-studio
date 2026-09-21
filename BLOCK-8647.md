# BLOCK-8647 — instrumentação segura (não confirma duplicação)

## O que é
Opcional `eventSourceUrl` no caminho `MetaCapiLogEvent` / `buildMetaCapiLogEvent` / `logMetaCapiSendResult`, com repasse de `request.url` de `workers/poll/src/subscribe.ts`. Nenhuma mudança de dedup (`#8646` claim KV + `resolveCompleteRegistrationDedup`) nem de `event_id`.

## O que NÃO é
- Não confirma a causa da proporção ~2× (`diar.ia.br` vs `eia.diar.ia.br`) — evidência ainda não existe (sem `ads_get_dataset_stats` no repo, sem .env/KV autorizado).
- Não reverte nem altera `#8577`/`#8646`.
- Não adiciona `eventSourceUrl` ao payload da Meta (só ao log interno).

## Regresso segurança
- `buildMetaCapiLogEvent` aceita `eventSourceUrl?: string`; quando ausente, comportamento igual ao anterior (não forçado).
- `subscribe.ts` passa `request.url`; dedup/claim intactos.
- Teste `#7776` atualizado com 2 assertions focais (`#8647`).

## PR
Base limpo: `origin/master` (isolado via worktree `../diaria-8647-worktree`). Nenhum conteúdo de `#8543`/`#8572` (confirmation event id / dedup pair) importado do branch contaminado (`continuo/fix-8647-meta-capi-log-host` / PR #8653).
