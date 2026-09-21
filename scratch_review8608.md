Review automatizado (1 agente, effort low): guard novo (`summary-matches-title.ts` + lint warn-only) bem isolado, com regressão coberta (#633) — sem findings de confiança alta/média — approve.

## Achados

**P3 / baixa confiança — cap de fallback-fetch non-inbox é compartilhado com o novo guard.** Em `enrich-inbox-articles.ts`, ao descartar um summary trocado (`shouldDiscardSummary`), o artigo passa a `needsEnrichment()=true` e entra em `targets`, competindo pelo mesmo `nonInboxFallbackFetchCount < fallbackCap` que já protegia os itens non-inbox legitimamente sem summary (#2545). Numa edição com muitos itens descartados isso pode esgotar o cap antes de itens "normais" sem summary conseguirem seu fetch. Não é regressão de comportamento anterior (o cap já era compartilhado entre todos os non-inbox), só um efeito colateral novo de volume.

**P3 / baixa confiança — sidecar `enriched.json` escrito mas sem consumidor no repo.** `main()` grava `enriched.json` ao lado do `--in` com `summary_discarded`/`summary_restored`, mas não há leitor desse arquivo em `scripts/` ou `.claude/` (grep vazio) — parece preparação para o Stage 4/relatório consolidado usar depois, mas hoje é um artefato morto. Sem impacto funcional.

**P3 / baixa confiança — `--edition` só aceita AAMMDD estrito.** `flagEdition && /^\d{6}$/.test(flagEdition)` ignora silenciosamente qualquer valor de `--edition` fora do formato e cai pro parse do path. Comportamento provavelmente intencional (fail-soft pro log, nunca bloqueia o script), mas vale checar se algum caller passa a flag em formato diferente.

Nenhum dos três achados é bug de correção, violação de regra do CLAUDE.md ou falha silenciosa mascarando erro real — a lógica core (discard só com evidência positiva, restauração no refetch-fail, isenção de inbox/newsletter_extracted) está correta e testada em `test/radar-summary-matches-title.test.ts`.

<!-- continuo-review: run=1789953823-130357-13156 at=2026-09-21T01:23:43Z verdict=approve head=4b3a8bc38357803e835872308db703ffce94c4a8 -->
