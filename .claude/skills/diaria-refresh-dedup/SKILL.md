---
name: diaria-refresh-dedup
description: (Opcional) Regenera manualmente `data/past-editions.md`. Normalmente não é necessário — `/diaria-1-pesquisa` e `/diaria-edicao` já fazem isso automaticamente no Stage 0. Obrigatório só depois de publicação manual (fora de `/diaria-5-publicacao`); útil também para forçar refresh fora do fluxo ou inspecionar o diff.
---

# /diaria-refresh-dedup (manual / opcional)

Atualiza o cache de edições passadas usado pelo `scripts/dedup.ts`.

**Normalmente não precisa ser invocado manualmente** — o orchestrator dispara esse mesmo script no Stage 0 de `/diaria-1-pesquisa` e `/diaria-edicao`. Use esta skill para:

- **Depois de publicação manual** (edição publicada sem `/diaria-5-publicacao`) — o único uso obrigatório (regra "Publicação manual requer refresh-dedup" do `CLAUDE.md`). Sem isso a próxima edição pode repetir URLs já publicadas.
- Inspecionar `data/past-editions.md` fora do fluxo de edição.
- Debugar quando o dedup estiver se comportando de forma inesperada.

**Não serve para testar credencial da Beehiiv** (#10027): o script não fala com a Beehiiv por padrão nem usa MCP nenhum (ver "Backend" abaixo).

## Execução

Rode via Bash:

```bash
npx tsx scripts/refresh-dedup.ts
```

Flags opcionais: `--dry-run` (não grava nada), `--no-resolve-tracking` (pula os HEAD requests de resolução de links), `--no-auto-stamp` (pula os efeitos colaterais por edição, abaixo).

## Backend

O script (`#895` — substitui o subagente legado `refresh-dedup-runner`) lê as edições via `listRecentNewsletterPosts` (`scripts/lib/shared/newsletter-read-source.ts`), que segue `publishing.newsletter.backend` em `platform.config.json` — hoje `"kit"` (broadcasts do Kit); `"beehiiv"` usa a REST API da Beehiiv. Credencial faltando para o backend configurado → exit 2 com o motivo.

## Modos

Detectados sozinhos a partir de `data/past-editions-raw.json`:

- **Bootstrap** (raw não existe): busca as `dedupEditionCount` (default 35, `beehiiv.dedupEditionCount` no config) edições mais recentes e popula raw + MD do zero.
- **Backfill** (#9955 — raw existe mas tem menos que `dedupEditionCount` edições): lista as `dedupEditionCount` mais recentes e baixa só as que faltam, completando a janela. O JSON reporta `mode: "incremental"`.
- **Incremental** (caso comum): busca só edições mais novas que a última já na base e faz merge.

Em todos os modos o MD **sempre** é regenerado, mesmo com 0 novos posts — cobre o caso do MD ter sido resetado enquanto o raw permanece atualizado.

## Efeitos colaterais

Além de `data/past-editions-raw.json` e `data/past-editions.md`, o script grava:

- **Excerto de voz** (`writeVoiceExcerpt`, #9978) — recorte de ~12 seções do MD que os agentes de escrita leem (o MD completo fica pros scripts de dedup).
- Para cada edição da janela que existe localmente em `data/editions/` (pulado com `--dry-run` ou `--no-auto-stamp`):
  - **auto-stamp** de `05-published.json` (#978);
  - **relatório da edição** `_internal/edition-report.html` se ausente (`writeEditionReport`, #1950) — registrado em `/relatorios`, sem e-mail.

Ao final, mostre ao usuário o JSON de resultado (`{ mode, new_posts, total_in_base, most_recent_date, skipped: false, md_regenerated: true }`) e, se `new_posts > 0`, as primeiras linhas de `data/past-editions.md` para confirmação visual.
