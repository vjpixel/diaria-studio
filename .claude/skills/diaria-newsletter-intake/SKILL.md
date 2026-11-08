---
name: diaria-newsletter-intake
description: Audita newsletters por remetente e período, com histórico append-only de leitura, links e falhas.
---

# /diaria-newsletter-intake [remetente] [de AAMMDD] [até AAMMDD]

Invocar `npx tsx scripts/audit-newsletter-intake.ts --sender "{email}" --from {AAMMDD} --to {AAMMDD}`; omitir filtros não fornecidos. Sem filtros, listar o histórico inteiro. Operação read-only: nunca re-capturar nem alterar edições para consultar o log.

Apresentar remetente, assunto, data/thread, classificação e motivo, remetente_status, links extraídos/capturados/no pool/pontuados, estado (`lida`, `parcial` = links que não chegaram ao pool, `falhou`, `ignorada`) e motivo. O JSONL é append-only; revisões de uma thread são eventos distintos (campo `at`), não novas newsletters. Para estado atual, usar o último evento por edição/thread. Decisões de remetentes são duráveis em `seed/newsletter-senders.json`; remetente novo permanece incerto até resposta explícita em lote no gate 4. Nunca inferir IA pelo conteúdo. Ler = extrair e pontuar; sem resumo.

Relatório completo por edição: `_internal/newsletter-intake-gate.md` e `_internal/newsletter-link-scores.json`. Para regenerar: `npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --require-scores` (só quando explicitamente pedido; grava auditoria).
