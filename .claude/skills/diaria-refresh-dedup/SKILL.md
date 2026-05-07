---
name: diaria-refresh-dedup
description: (Opcional) Regenera manualmente `context/past-editions.md`. Normalmente não é necessário — `/diaria-1-pesquisa` e `/diaria-edicao` já fazem isso automaticamente no Stage 0. Útil para forçar refresh fora do fluxo ou inspecionar o diff.
---

# /diaria-refresh-dedup (manual / opcional)

Atualiza o cache de edições passadas usado pelo `scripts/dedup.ts`.

**Normalmente não precisa ser invocado manualmente** — o orchestrator dispara esse mesmo fluxo como primeira etapa de `/diaria-1-pesquisa` e `/diaria-edicao`. Use esta skill apenas para:

- Testar se a Beehiiv API key está válida e respondendo.
- Inspecionar o conteúdo do `context/past-editions.md` fora do fluxo de edição.
- Debugar quando o dedup estiver se comportando de forma inesperada.

## Execução

Rode via Bash:

```bash
npx tsx scripts/refresh-dedup.ts
```

O script (`#895` — substitui o subagente legado `refresh-dedup-runner`) usa a Beehiiv REST API diretamente (token em `BEEHIIV_API_KEY`) e detecta sozinho:

- **Bootstrap** (primeira vez): busca as `dedupEditionCount` edições mais recentes e popula `data/past-editions-raw.json` + `context/past-editions.md` do zero.
- **Incremental** (caso comum): busca só edições mais novas que a última já na base, faz merge, regenera o MD.
- **Sempre regenera o MD**, mesmo com 0 novos posts — cobre o caso do MD ter sido resetado por `git pull` enquanto o raw permanece atualizado.

Ao final, mostre ao usuário o JSON de resultado (`{ mode, new_posts, total_in_base, most_recent_date, skipped: false, md_regenerated: true }`) e, se `new_posts > 0`, as primeiras linhas de `context/past-editions.md` para confirmação visual.
