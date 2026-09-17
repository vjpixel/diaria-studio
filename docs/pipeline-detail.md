# Pipeline — detalhe por etapa (scripts/subagentes/outputs)

Movido do `CLAUDE.md` na rodada de enxugamento do #8228. A fonte viva desse
detalhe são os playbooks `.claude/agents/orchestrator-stage-{0-preflight,
1-research,2,3,4,5,6}.md` — esta tabela é um resumo de referência rápida,
não a fonte canônica; se divergir do playbook, o playbook vence.

| # | Etapa | Subagentes / Scripts | Output |
|---|---|---|---|
| 1 | Pesquisa | N× `source-researcher` + M× `discovery-searcher` + `eia-composer` (em paralelo, É IA? em background) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 2 | Escrita | **`writer-destaque` × 3** (paralelo, #1158/#1451) + `social-writer` (#3991, reverte #3486 — texto único LinkedIn/Facebook/Instagram) + `social-curto` (#3992) em paralelo, todos a partir de `_internal/01-approved.json` → stitch + merge → humanizador × 2 → Clarice × 2 | `02-reviewed.md` + `03-social.md` |
| 3 | Imagens | É IA? gate (coleta `eia-composer` do background) + `scripts/image-generate.ts` × 3 destaques (Gemini/ComfyUI via `platform.config.json`) + `scripts/gen-carousel-cards.ts` (#6005 Parte B — 3 slides de parágrafo + CTA do carrossel do Instagram por destaque) | `01-eia.md` + `01-eia-A/B.jpg` + `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` + `04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg` |
| 4 | Revisão (#1694) | pré-render técnico (HTML + imagens + upload Worker + close-poll) → resumo consolidado (destaques, títulos, lints, preview) → **gate humano pré-publicação** | `_internal/.step-4-done.json` + `_internal/newsletter-final.html` |
| 5 | Publicação (#1694) | Newsletter: `publish-newsletter` (Chrome → Beehiiv draft) OU `publish-newsletter-kit.ts` (Kit broadcast, `publishing.newsletter.backend === "kit"`, #464) + `scripts/kit-diaria-stage5-dispatch.ts` (canal Kit PARALELO pra quem se cadastrou depois do corte, roda ao lado da Beehiiv, #6114). Social: `scripts/publish-facebook.ts` (Graph API × 3, `--schedule`) + `scripts/publish-linkedin.ts` (Worker queue + Make webhook × 3) + `scripts/publish-instagram.ts` (Worker queue `channel:"instagram"` × 3, `--schedule`) + `scripts/publish-threads.ts` (Worker queue `channel:"threads"`, `--schedule`, #3944 Parte B) + `scripts/prep-twitter-posts.ts` + Buffer MCP (X, #3994/#4103). Mais `scripts/brevo-diaria-stage5-dispatch.ts` (canal Brevo diária, segmento Pending/reativação — cria só o RASCUNHO, `--max-add` derivado sem gate, #5772) **em paralelo** → `review-test-email` (loop até 10×) | `_internal/05-published.json` + `_internal/06-social-published.json` + `_internal/brevo-diaria-published.json` + `_internal/kit-diaria-published.json` |
| 6 | Agendamento (#1694) | resumo → **parada ÚNICA** (e-mail de teste + agendamento, #8205) → Schedule Beehiiv/Kit + `scripts/schedule-daily-brevo.ts` (mesmo `scheduled_at`, #5772) → `verify-scheduled-post.ts` → auto-reporter → `send-edition-report.ts` | `_internal/05-published.json` (com `scheduled_at`) + `_internal/brevo-diaria-published.json` (com `scheduled_at`) + `_internal/edition-report.html` |

## Revisão fora do terminal (mobile) — só pipeline DIÁRIO (#3636, #3729)

O Studio (`npm run studio`, acesso remoto via Cloudflare Tunnel desde #3560)
cobre a revisão/edição dos outputs de cada etapa fora do terminal —
inclusive no celular. O Google Drive sync que cumpria esse papel antes do
Studio existir foi aposentado da edição **diária** (#3636); nenhuma etapa de
`/diaria-edicao`/`/diaria-N-*` invoca mais `scripts/drive-sync.ts`
automaticamente. **O digest MENSAL continua 100% dependente do Drive** —
`.claude/skills/diaria-mensal/SKILL.md` tem 4 call sites ativos de
`drive-sync.ts --mode push/pull` (Etapas 1, 2, 4 e 5), porque o Studio ainda
não cobre a revisão do fluxo mensal. `scripts/drive-sync.ts` e
`scripts/oauth-setup.ts` **não são código morto** — não remover nem tratar
como legado sem checar `/diaria-mensal` primeiro (achado #3729, review
consolidado 260719).

## Reports Drive sync — descontinuado (#3713)

`scripts/upload-report-to-drive.ts` e `scripts/sync-report.ts` (Google Doc em
`Work/Startups/diar.ia.br/relatorios/`) foram removidos — mecanismo
confirmado sem uso ad-hoc fora do fluxo de relatório de fim-de-trabalho, que
está migrando pra superfície própria no Studio (#3714, em progresso). Docs
já criados no Drive permanecem como estão (histórico), sem ação automática
sobre eles. A árvore de edições (`edicoes/{YYMM}/{AAMMDD}/`) segue no Drive
até arquivamento manual pelo editor (mover pra `_arquivo/`, #3713).
