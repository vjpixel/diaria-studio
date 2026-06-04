# Editorial invariants (auto-generated)

Gerado por `npx tsx scripts/list-invariants.ts` a partir de `scripts/lib/invariant-checks/stage-*.ts` + `STATIC_RULES` em `scripts/check-invariants.ts`. **NÃO editar à mão** — re-rodar o script regenera.

Cada regra é verificada por `check-invariants.ts` antes do gate humano de cada stage. Violations com `severity: error` bloqueiam transição; `warning` só registra.

**Total**: 35 invariants.

## Static (estrutura do repo)

| id | descrição | issue |
|---|---|---|
| `no-forensic-in-drive-sync` | drive-sync nunca inclui _internal/_forensic/ (#959) | #959 |
| `no-html-in-monthly-drive-sync` | drive-sync mensal nunca inclui HTML render (#1022) | #1022 |

## Stage 0 — Setup + dedup

| id | descrição | issue |
|---|---|---|
| `beehiiv-key-set` | BEEHIIV_API_KEY env var presente (#895) | #895 |
| `clarice-key-set` | CLARICE_API_KEY env var presente (#1370) | #1370 |
| `drive-creds-valid` | data/.credentials.json existe e tem refresh_token (#121) | #121 |
| `gemini-model-valid` | platform.config.json > gemini.model resolve em /v1beta/models (#1396) | #1396 |
| `image-generator-key-set` | API key do image_generator configurado em platform.config.json presente (#1370) | #1370 |
| `linkedin-cron-creds-set` | DIARIA_LINKEDIN_CRON_URL + TOKEN presentes (#1370) | #1370 |
| `mcp-binaries-exist` | stdio MCPs em .mcp.json apontam pra binários que existem (#1382) | #1382 |
| `past-editions-raw-parseable` | data/past-editions-raw.json existe e parseável (#162) | #162 |
| `poll-secrets-set` | POLL_SECRET + ADMIN_SECRET presentes (#1370) | #1370 |

## Stage 1 — Pesquisa

| id | descrição | issue |
|---|---|---|
| `approved-has-3-highlights` | 01-approved.json tem 3 highlights (#159) | #159 |
| `categorized-has-eia-section` | 01-categorized.md inclui seção '## É IA?' (#481) | #481 |
| `coverage-line-present` | 01-approved.json tem coverage.line (#592) | #592 |

## Stage 2 — Escrita

| id | descrição | issue |
|---|---|---|
| `humanizer-ran` | humanizer rodou em 02-reviewed.md + 03-social.md (#1385) | #1385 |
| `por-que-isso-importa-separate-line` | 'Por que isso importa:' em linha separada (editorial-rules) | #editorial-rules |
| `reviewed-passes-all-lints` | 02-reviewed.md passa lint-newsletter-md granulares (#964) | #964 |
| `social-passes-lints` | 03-social.md passa linkedin-schema + relative-time (#595) | #595 |

## Stage 3 — Imagens

| id | descrição | issue |
|---|---|---|
| `all-images-exist` | 6 imagens (eia A/B + d1 2x1/1x1 + d2/d3 1x1) presentes | #stage-3 |
| `eia-answer-resolved` | 01-eia.md tem eia_answer A\|B resolvido (#192) | #192 |
| `prompts-clean` | Prompts não mencionam pixels nem Noite Estrelada | #editorial-rules |

## Stage 4 — Publicação (pré-dispatch)

| id | descrição | issue |
|---|---|---|
| `facebook-page-id-set` | FACEBOOK_PAGE_ID env var presente | #facebook |
| `facebook-token-set` | FACEBOOK_PAGE_ACCESS_TOKEN env var presente | #facebook |
| `image-content-fresh` | imagem de destaque bate com highlight D{N} atual (#1730) | #1730 |
| `intro-count-consistent` | intro line Z = contagem real de items visíveis (#1578) | #1578 |
| `linkedin-worker-token-set` | DIARIA_LINKEDIN_CRON_TOKEN env var presente (#971) | #971 |
| `linkedin-worker-url-set` | DIARIA_LINKEDIN_CRON_URL env var presente e HTTPS (#971) | #971 |
| `public-images-populated` | 06-public-images.json com URLs d1/d2/d3 (#999) | #999 |
| `social-hash-fresh` | social.md hash bate com approved.json highlights (#1413) | #1413 |

## Stage 5 — Publicação (pós-dispatch)

| id | descrição | issue |
|---|---|---|
| `close-poll-marker-exists` | _internal/.close-poll-done.json escrito (#1367) | #1367 |
| `consent-binding` | canais com consent=auto devem ter dispatch real (#1575) | #1575 |
| `social-published-complete` | 06-social-published.json não-vazio, sem failed (#272) | #272 |
| `stage-4-review-completed` | review-test-email loop rodou + terminou (#1577) | #1577 |
| `stage-4-review-loop-enforced` | review_status=issues_unfixable exige review_attempts>=2 (#1410) | #1410 |
| `step-4-sentinel-exists` | _internal/.step-4-done.json escrito (#780) | #780 |

---

_Para adicionar nova invariant_: criar função `(editionDir) => InvariantViolation[]` em `scripts/lib/invariant-checks/stage-{N}.ts`, registrar em `STAGE_N_RULES`, e re-rodar este script.
