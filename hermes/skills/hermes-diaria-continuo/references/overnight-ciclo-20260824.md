# Evidência — ciclo 2026-08-24 (`7089586af6cb`)

- Causa raiz (`/tmp/causa-raiz.md`): `plan.json` `260823` vazio (`last_scan_at`: 2026-08-18, 6 dias desatualizado) → ciclo `13:44` não encontrou as 6 `overnight`.
- Correção aplicada (`plan.json` `260826`): `scan_type: full`, `issues`: 6 `overnight` (`#6043`, `#6041`, `#6031`, `#6016`, `#6005`, `#5995`), `last_scan_at`: 2026-08-24T18:21:49Z, `batch_approval`: `default_proposed`.
- Comentários (`gh issue comment`) registrados: #6043 (`#5399536988`), #6041 (`#5399537371`), #6031 (`#5399537811`), #6016 (`#5399538381`), #6005 (`#5399539045`), #5995 (`#5399539468`).
- `#6043` (P0 onboarding): `delegado_outra_sessao` (editor confirmou resolução em outra sessão; branch `continuo/fix-6043-onboarding` + worktree preservados).
- 5 restantes: `in_progress` no contínuo; nenhuma implementação feita ainda (`modificado=False`, nenhuma PR, nenhum `requesting-code-review`, nenhum `npm ci` nos worktrees).
- Verificação pós-ciclo (`/tmp/final-verification.md`): `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`) confirma 13 `overnight`, 0 `develop`, 9 `agendada`, 15 `bloqueada`, 0 `fora-de-rodada`; `overnight` contínuo replicado da `.claude/skills/diaria-overnight/`.
