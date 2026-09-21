# Diagnóstico CI #8644 / #8631 (2026-09-21)

- Escopo satisfeito: Blog do Google Brasil (IA) removido de seed/sources.csv; Google Codelabs (IA) preservado.
- Teste regressão 8631: 8/8 pass.
- Tests categorização afetados (audience-affinity, categorize-overrides-misc, categorize-provenance, use-melhor-sources): todos pass.
- CI vermelho é exclusivamente baseline (@types/node no worktree, conforme corpo da PR #8644), NÃO causado pela mudança de categorização.
- Nenhuma edição editorial não documentada; #8632 não implementado (BLOCK-8632.md não incluso, conforme comentário da issue).
- PR #8644 permanece aberta para review independente; não mergeado; master não tocado.
