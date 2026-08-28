---
name: overnight-track-5948
description: Fix #5948 — classificador overnight não filtrava CLOSED; lições do runtime continuo no Helios.
---

# Overnight-Track Classifier Fix — #5948

Context: 2026-08-23 — runtime Diaria Continuo no Helios (cron 7089586af6cb, modelo laguna:free).

Problema: 5 issues classificadas como `overnight` quando nao deveriam: #5926 (CLOSED); #5908 (bloqueada/humano); #5917 (agendada 24/08); #5140 (agendada 28/08); #5947 (nova).

Root cause: `scripts/lib/issue-exec-track.ts` — `classifyExecTrack()` nao recebia `state` (campo ausente em `ExecTrackInput`; caller `parseIssues` nao passava `i.state`). Operava so em labels + `aguardando-ate:`, entao CLOSED caia no `overnight`.

Fix aplicado (branch `continuo/fix-5948-...`, commit `fdf1c726`):
- `ExecTrackInput`: adicionar `state?: string`.
- `classifyExecTrack`: passo 0 — `if (state === "CLOSED") return "fora-de-rodada";` (antes de qualquer label).
- Caller `studio-issues.ts`: `classifyExecTrack({ labels, body, state: i.state })`.

Verificacao final (tsx): CLOSED→fora-de-rodada; agendada (aguardando-ate)→agendada; bloqueada→bloqueada; overnight real→overnight.

Referencias duraveis:
- Skill `hermes-diaria-continuo`: objetivo = fila (a) vazia; multi-batch = (a) continuo; budget ~120; review `requesting-code-review`; rotação por `coding_fallback` chain (luna indisponivel → laguna).
- Issue #5948 (bug P1, tracking, comentario com causa)
- Issue #5928 (claimed pelo editor — label `bloqueio-execucao`)
