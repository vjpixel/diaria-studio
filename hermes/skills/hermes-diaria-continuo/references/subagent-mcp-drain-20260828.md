---
name: subagent-mcp-drain-pattern
description: Padrão de drain via subagente MCP (ex: beehiiv 6465, epic 6464): limite lote (#6496), anti-fabricação, dedup obrigatório por fronteiras de página, fonte única no disco.
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, drain, subagent, mcp, anti-fabricacao, dedup, fonte-unica]
---

Referência: subagente `claude -p` com MCP (ex: Beehiiv, issue 6465 / epic 6464, 28/08/2026). Rodou no `continuo` Helios via `proc_6f661...` (EXIT=0, 5 posts ok, 847 registros, 5 .jsonl confirmados).

Padrões:
- Lote 5-10 (nunca 20+) — #6496.
- Anti-fabricação: confirmar `.jsonl` + `manifest.json` no disco, não confiar só em EXIT=0.
- Dedup obrigatório — `subscriber_id` e `(sub, url_hash, clicked_at)` devido a duplicados em fronteiras de página.
- Fonte única Helios/Neo: `data/beehiiv-backup/subscriber-engagement/` (`.jsonl` + manifest); `.claude/worktrees/agent-*` NÃO sincronizam automaticamente.
- Claim hygiene (`--kind continuo` obrigatório, unclaim só sem worktree ativo) — ver SKILL.md de `hermes-diaria-continuo`, §Implementar issues elegíveis.
