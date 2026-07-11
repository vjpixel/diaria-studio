# Índice — docs/

Ativo vs histórico. `context/` é o que entra no prompt cache (curado, ver `CLAUDE.md`); `docs/` é documentação de apoio — setup one-time, runbooks operacionais, análises/decisões de produto, e o arquivo histórico de spikes/investigações encerradas.

## Setup (one-time, por máquina ou por integração)

| Doc | O que cobre |
|---|---|
| [`installation.md`](./installation.md) | Passo-a-passo completo do zero ao primeiro `/diaria-edicao` funcional (~30-45min) |
| [`comfyui-setup.md`](./comfyui-setup.md) | Instalar/configurar ComfyUI + LoRA Van Gogh impasto pras imagens da Fase 2 |
| [`browser-publish-setup.md`](./browser-publish-setup.md) | MCP Claude in Chrome pros Stages 5-6 (publicação Beehiiv/LinkedIn/Facebook) |
| [`gmail-inbox-setup.md`](./gmail-inbox-setup.md) | Forward + label pro inbox editorial `diariaeditor@gmail.com` |
| [`facebook-setup.md`](./facebook-setup.md) | Facebook Graph API do publisher do Stage 5 |
| [`make-linkedin-setup.md`](./make-linkedin-setup.md) | Scenario Make.com pra publicação LinkedIn "fire-now" via webhook |
| [`make-595-comments-setup.md`](./make-595-comments-setup.md) | Extensão do scenario Make (#595) pra suportar comments automáticos no LinkedIn |
| [`linkedin-cron-worker-setup.md`](./linkedin-cron-worker-setup.md) | Cloudflare Worker `diaria-linkedin-cron` pra agendamento real de posts (substitui Make Data Store) |
| [`telegram-setup.md`](./telegram-setup.md) | Plugin oficial de channels do Telegram pra acompanhar sessões pelo celular |
| [`clarice-dashboard-access-setup.md`](./clarice-dashboard-access-setup.md) | Cookie-token auth do clarice-dashboard |
| [`google-oauth-production.md`](./google-oauth-production.md) | Publicar app OAuth Google em "Produção" (fix causa-raiz da expiração de 7 dias) |
| [`branch-protection.md`](./branch-protection.md) | Exigir CI verde antes de merge em `master` |
| [`scheduled-edicao-setup.md`](./scheduled-edicao-setup.md) | **DEPRECATED (260711, #3259)** — Agendamento automático (Task Scheduler) da edição diária (#2068); task removida, doc mantido como histórico |
| [`overnight-watchdog-setup.md`](./overnight-watchdog-setup.md) | Watchdog de stall do `/diaria-overnight` via Task Scheduler (#2688) |

## Operação (runbooks, manutenção contínua)

| Doc | O que cobre |
|---|---|
| [`secret-rotation.md`](./secret-rotation.md) | Ponto único de consulta pra rotação/expiração das 7 credenciais da pipeline |
| [`archival.md`](./archival.md) | `scripts/archive-editions.ts` — mover edições antigas de `data/editions/` pra manter o working tree leve |
| [`editorial-invariants.md`](./editorial-invariants.md) | **Auto-gerado** (`npx tsx scripts/list-invariants.ts`) — não editar à mão |
| [`bug-heatmap.md`](./bug-heatmap.md) | **Auto-gerado** (`scripts/bug-heatmap.ts`) — não editar à mão |
| [`validate-stage-1-output-semantics.md`](./validate-stage-1-output-semantics.md) | Semântica canônica dos exit codes de `scripts/validate-stage-1-output.ts` (#581, #828, #832) |
| [`dashboard-schedule.md`](./dashboard-schedule.md) | Agendamento do push do clarice-dashboard (#2471) |
| [`cohorts-schedule.md`](./cohorts-schedule.md) | Agendamento do crawl de coortes de engajamento do dashboard (#2426) |
| [`coupon-kv-refresh.md`](./coupon-kv-refresh.md) | Refresh automático do KV de cupons do dashboard (#2750) |
| [`runbooks/poll-secret-rotation.md`](./runbooks/poll-secret-rotation.md) | Runbook de rotação do secret HMAC do poll É IA? |

## Produto / estratégia / análises vivas

| Doc | O que cobre |
|---|---|
| [`agent-migration-triage.md`](./agent-migration-triage.md) | Triagem viva agente-a-agente (LLM vs script determinístico), source-of-truth desde 2026-05-11 (#1094) |
| [`clarice-unified-db.md`](./clarice-unified-db.md) | Store único SQLite de usuários da Clarice (#2647) |
| [`beehiiv-mcp-write-evaluation.md`](./beehiiv-mcp-write-evaluation.md) | Avaliação custo/benefício do upgrade de plano pro MCP Write do Beehiiv |
| [`claude-pilot-design.md`](./claude-pilot-design.md) | Design do piloto de newsletter focada em Claude/Anthropic (#60) |
| [`lean-canvas-vigil-ia.md`](./lean-canvas-vigil-ia.md) | Lean Canvas do guarda-chuva Vigil.ia.br (#856) — living document |
| [`token-reduction-analysis.md`](./token-reduction-analysis.md) | Análise de redução de tokens da pipeline de edição (#2452) |

## Histórico (spikes e análises encerradas — `docs/archive/`, `docs/agents-archive/`)

Preservados por valor histórico (racional de decisões passadas), mas superados ou já resolvidos — não refletem necessariamente o estado atual do código. Cada doc tem um header "Status" explicando o desfecho.

| Doc | Desfecho |
|---|---|
| [`archive/beehiiv-vs-kit-migration.md`](./archive/beehiiv-vs-kit-migration.md) | Migração Beehiiv→Kit **pausada indefinidamente** (briefing 2026-06-13); consolida o comparativo de mercado + spike técnico de inventário/esforço |
| [`archive/spike-275-beehiiv-automation.md`](./archive/spike-275-beehiiv-automation.md) | Mapeamento inicial da DOM do editor Beehiiv (#275) — alimentou a Phase 2 de automação |
| [`archive/spike-1046-clipboard-paste.md`](./archive/spike-1046-clipboard-paste.md) | Investigação de paste HTML grande no TipTap (#1046/#312) — método encontrado depois substituído pelo fluxo Worker-hosted atual |
| [`archive/spike-1113-embeddings-filtro2.md`](./archive/spike-1113-embeddings-filtro2.md) | Proposta de embeddings pro Filtro 2 do `research-reviewer` (#1113) — nunca implementada, hold indefinido |
| [`archive/eai-poll-api-test.md`](./archive/eai-poll-api-test.md) | Teste de hipótese pra Trivia Poll API (#107) — issue fechada por rota diferente (`fetch-beehiiv-poll-stats.ts`) |
| [`archive/llm-ts-migration-analysis.md`](./archive/llm-ts-migration-analysis.md) | Análise original de migração LLM→TS — superada por `agent-migration-triage.md` |
| [`archive/script-migration-plan.md`](./archive/script-migration-plan.md) | Plano original de migração LLM→TS — superado por `agent-migration-triage.md` |
| [`agents-archive/eia-composer.md`](./agents-archive/eia-composer.md) | Spec do agente `eia-composer`, substituído pelo script determinístico `scripts/eia-compose.ts` |

## Outros diretórios

- `docs/audience-history/` — snapshots datados do perfil de audiência (gerados, não são docs de referência).
