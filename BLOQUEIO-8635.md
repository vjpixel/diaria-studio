# #8635 BLOQUEIO — review-test-email: Gmail MCP indisponível no subagente

Data: 2026-09-21. Branch: continuo/fix-8635-slug-blocked.

## Por que parou (regra do continuo / CLAUDE.md)

- Achado virou issue (não PR): #8635 já aberta. Nenhum código alterado.
- Proposta contém 2 caminhos sem decisão documentada:
  (a) rodar `lint-test-email-*` determinísticos sobre `newsletter-final-kit.html` mesmo sem Gmail;
  (b) rodar review no top-level quando `gmailMcp: false` no subagente.
- Nenhum playbook (`.claude/agents/review-test-email.md`), nenhum `docs/`, nenhum `context/` define (a) vs (b) nem em que stage (5 vs gate 6) o fallback roda.
- Isso é trade-off editorial + de pipeline real (critério 2 de "Perguntar é exceção") — não é detalhe cosmético.

## Ação já feita (apenas registro, nada implementado)

- Comentário na #8635 (https://github.com/vjpixel/diaria-studio/issues/8635#issuecomment-5754761253) registrando bloqueio.
- Branch `continuo/fix-8635-slug-blocked` criada (worktree `agent-8635-gmail-mcp-lints`, isolamento #6509 obedecido).
- Nenhum arquivo editado, nenhum `git add -A`; master intacto.

## O que ainda precisa (para implementar depois)

1. Decisão do editor: (a) ou (b) ou ambos?
2. Se (a): qual arquivo de saída (`_internal/`, `test-email-*.txt`?); o `lint-test-email.ts` já existe — precisa de wrapper no agent ou no orquestrador?
3. Se (b): o top-level precisa de `gmailMcp` false guard no Stage 5 — onde está o hook (`preflight-state.ts` já registra, mas o orquestrador não age sobre ele)?
4. Teste de regressão: precisa demonstrar que quando `gmailMcp` é false o resultado não é `inconclusive` vazio (o bug de #1212: `email_not_found` interpretado como limpo).
5. Prioridade P2 já declarada; nenhum PR aberto.
