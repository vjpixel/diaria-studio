# Editorial invariants (auto-generated)

Gerado por `npx tsx scripts/list-invariants.ts` a partir de `scripts/lib/invariant-checks/stage-*.ts` + `STATIC_RULES` em `scripts/check-invariants.ts`. **NÃO editar à mão** — re-rodar o script regenera.

Cada regra é verificada por `check-invariants.ts` antes do gate humano de cada stage. Violations com `severity: error` bloqueiam transição; `warning` só registra.

**Total**: 58 invariants.

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
| `poll-secrets-set` | ADMIN_SECRET presente (#1370, #1186: POLL_SECRET removido — modo merge-tag) | #1370 |

## Stage 1 — Pesquisa

| id | descrição | issue |
|---|---|---|
| `approved-has-3-highlights` | 01-approved.json tem 2 ou 3 highlights (#2343) | #2343 |
| `categorized-has-eia-section` | 01-categorized.md inclui seção '## É IA?' (#481) | #481 |
| `coverage-line-present` | 01-approved.json tem coverage.line (#592) | #592 |
| `has-negative-impact-highlight` | ≥1 destaque tagueado negative_impact:true (#3916, #3918, warning-only) | #3916 |
| `no-use-melhor-highlights` | highlights[] nunca contém item do bucket USE MELHOR/tutorial (#3436) | #3436 |

## Stage 2 — Escrita

| id | descrição | issue |
|---|---|---|
| `humanizer-ran` | humanizer rodou em 02-reviewed.md + 03-social.md (#1385) | #1385 |
| `por-que-isso-importa-separate-line` | 'Por que isso importa:' em linha separada (editorial-rules) | #editorial-rules |
| `reviewed-passes-all-lints` | 02-reviewed.md passa lint-newsletter-md granulares (#964) | #964 |
| `social-no-trailing-editorial-hook` | 03-social.md sem gancho editorial emendado via ', e' — warn-only (#2658) | #2658 |
| `social-passes-lints` | 03-social.md passa linkedin-schema + relative-time + post_pixel-matches-d1 + personal-post-no-newsletter-deixis + platform-headers-unicos + humanizer-section-coverage (#595, #1861, #2148, #3388) | #595 |
| `use-melhor-beginner-minimum` | USE MELHOR (pós-caps) tem ≥2 itens acessíveis a iniciantes — warn-only (#3213) | #3213 |

## Stage 3 — Imagens

| id | descrição | issue |
|---|---|---|
| `all-images-exist` | imagens obrigatórias (eia A/B + d1/d2 2x1/1x1; d3 2x1/1x1 condicional a destaque_count=3) (#2133/#2141/#2352) | #stage-3 |
| `eia-answer-resolved` | 01-eia.md tem eia_answer A\|B resolvido (#192) | #192 |
| `prompts-clean` | Prompts não mencionam pixels nem Noite Estrelada (d3 condicional a destaque_count=3, #2352) | #editorial-rules |

## Stage 4 — Publicação (pré-dispatch)

| id | descrição | issue |
|---|---|---|
| `capture-failed-submission-count` | captura de newsletters (0b-bis) falhou — coverage line não pode afirmar '0 submissões' (#2878) | #2878 |
| `eia-credit-synced` | crédito do bloco É IA? em 02-reviewed.md bate com 01-eia.md, a fonte real do render (#3825) | #3825 |
| `has-negative-impact-highlight` | ≥1 destaque tagueado negative_impact:true — repetido no gate consolidado (#3916, #3918, warning-only) | #3916 |
| `image-content-fresh` | imagem de destaque bate com highlight D{N} atual (#1730) | #1730 |
| `intro-count-consistent` | intro line Z = contagem real de items visíveis (#1578) | #1578 |
| `narrative-not-generic-placeholder` | narrative ERRO INTENCIONAL é declaração real de primeira pessoa (#2377) | #2377 |
| `no-trailing-ellipsis` | descrição de item secundário não termina em reticências herdadas da fonte (#2881) | #2881 |
| `public-images-populated` | 06-public-images.json com URLs d1/d2/d3 (#999) | #999 |
| `social-hash-fresh` | social.md hash bate com approved.json highlights (#1413) | #1413 |
| `title-publisher-suffix` | título sem sufixo residual de veículo (' \| Veículo' / ' - Veículo', #2664) | #2664 |
| `title-trailing-period` | título de destaque/item sem ponto final único (#2672) | #2672 |
| `truncated-secondary-item-summary` | descrição de item secundário não termina em reticências de truncamento (#2596) | #2596 |
| `use-melhor-sentinel` | itens USE MELHOR sem descrição real (sentinel [DESCRIÇÃO PENDENTE] presente, #2464) | #2464 |
| `use-melhor-tempo` | cada item USE MELHOR tem estimativa de tempo na descrição (#2372) | #2372 |

## Stage 5 — Publicação (pós-dispatch)

| id | descrição | issue |
|---|---|---|
| `close-poll-marker-exists` | _internal/.close-poll-done.json escrito (#1367) | #1367 |
| `consent-binding` | canais com consent=auto devem ter dispatch real (#1575) | #1575 |
| `edition-url-file-exists` | _internal/05-edition-url.txt existe e contém URL válida antes do dispatch social (#2454) | #2454 |
| `facebook-page-id-set` | FACEBOOK_PAGE_ID env var presente (necessário para Stage 5 dispatch) | #facebook |
| `facebook-token-set` | FACEBOOK_PAGE_ACCESS_TOKEN env var presente (necessário para Stage 5 dispatch) | #facebook |
| `instagram-creds-set` | INSTAGRAM_BUSINESS_ACCOUNT_ID + INSTAGRAM_ACCESS_TOKEN presentes — ausente pula Instagram (#49) | #49 |
| `linkedin-worker-token-set` | DIARIA_LINKEDIN_CRON_TOKEN env var presente (#971) | #971 |
| `linkedin-worker-url-https` | DIARIA_LINKEDIN_CRON_URL deve ser HTTPS quando presente (#971) | #971 |
| `linkedin-worker-url-set` | DIARIA_LINKEDIN_CRON_URL env var presente — ausente degrada pra Make webhook (#971) | #971 |
| `social-published-complete` | 06-social-published.json não-vazio, sem failed (#272) | #272 |
| `stage-5-review-completed` | review-test-email loop rodou + terminou (#1577) | #1577 |
| `stage-5-review-loop-enforced` | review_status=issues_unfixable exige review_attempts>=2 (#1410) | #1410 |
| `step-4-sentinel-exists` | _internal/.step-4-done.json escrito (#780) | #780 |
| `step-5-sentinel-exists` | _internal/.step-5-done.json escrito pelo pipeline-sentinel (#1694) | #1694 |
| `threads-creds-set` | THREADS_USER_ID + THREADS_ACCESS_TOKEN presentes — ausente pula Threads (#2479) | #2479 |

## Stage 6 — Agendamento

| id | descrição | issue |
|---|---|---|
| `edition-report-exists` | _internal/edition-report.html escrito pelo send-edition-report.ts (#1510) | #1510 |
| `scheduled-at-present` | 05-published.json tem scheduled_at ou status=published (#1694) | #1694 |
| `step-5-sentinel-exists` | _internal/.step-5-done.json escrito pelo Stage 5 (#1694) | #1694 |
| `step-6-sentinel-exists` | _internal/.step-6-done.json escrito pelo pipeline-sentinel (#1694) | #1694 |

---

_Para adicionar nova invariant_: criar função `(editionDir) => InvariantViolation[]` em `scripts/lib/invariant-checks/stage-{N}.ts`, registrar em `STAGE_N_RULES`, e re-rodar este script.
