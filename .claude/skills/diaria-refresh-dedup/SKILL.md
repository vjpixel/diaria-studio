---
name: diaria-refresh-dedup
description: (Opcional) Regenera manualmente `context/past-editions.md`. Normalmente não é necessário — `/diaria-research` e `/diaria-edicao` já fazem isso automaticamente no Stage 0. Útil para testar a conexão Beehiiv MCP, forçar refresh fora do fluxo, ou inspecionar o diff.
---

# /diaria-refresh-dedup (manual / opcional)

Atualiza o cache de edições passadas usado pelo `deduplicator`.

**Normalmente não precisa ser invocado manualmente** — o orchestrator dispara esse mesmo fluxo como primeira etapa de `/diaria-research` e `/diaria-edicao`. Use esta skill apenas para:

- Testar se o MCP Beehiiv está autenticado e respondendo.
- Inspecionar o conteúdo do `context/past-editions.md` fora do fluxo de edição.
- Debugar quando o dedup estiver se comportando de forma inesperada.

## Execução

Dispare o subagente `refresh-dedup-runner` via `Task` (sem argumentos).

O subagente detecta sozinho:
- **Bootstrap** (primeira vez): busca as `dedupEditionCount` edições mais recentes e popula `data/past-editions-raw.json` + `context/past-editions.md` do zero.
- **Incremental** (caso comum): busca só edições mais novas que a última já na base e faz merge.

Ao final, mostre ao usuário o JSON de resultado do runner (`{ mode, new_posts, total_in_base, most_recent_date, skipped }`) e, se `new_posts > 0`, as primeiras linhas de `context/past-editions.md` para confirmação visual.
