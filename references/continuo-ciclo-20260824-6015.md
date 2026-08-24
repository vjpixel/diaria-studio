# Ciclo Diária Continuo — 24/08/03:08 (fix #6015)

Status: runtime contínuo `7089586af6cb` ativo; PR #6020 (`continuo/fix-6015-4xx-fallback`) aberta.

## O que funcionou
- `script/sync-code.ts` → `synced_stashed` (worktree sujo restaurado via stash, sem conflito).
- `gh auth status` → autenticado; `git log` → branch `master` atualizado com `origin/master`.
- `cronjob list` → 4 jobs ativos; `Diária Continuo` (`last_status: ok`, `next_run: 01:13`).
- `gh issue list --open --json ...` → 31 issues; classificação feita (P1/P2/P3).
- `node --test test/publish-linkedin.test.ts` → 104/104 pass (30s).
- `gh pr create` → PR #6020 aberta; `git push` → branch `continuo/fix-6015-4xx-fallback` no origin.

## Correções aplicadas (#6015 — P2 bug, 23/08 ao vivo)
Ver `scripts/publish-linkedin.ts`:
- `DispatchInput.allowImmediateFallback?: boolean` (default `true`; `false` → falha hard).
- `isClientError(msg)` → detecta `HTTP 4xx` (validação do payload, nunca deve cair no fallback que publica imediatamente).
- `dispatchEntry`: se 4xx ou `allowImmediateFallback === false` → propaga como falha (`throw` → capturado pelo `catch` externo → `entry.status = "failed"`, `reason = msg + motivo`).

Referência durável: PR #6020 (`branch` → `commit 61df2d52`).

## Classificação deste ciclo
- (a) acionável: #6015 (implementado — PR aberta; ainda precisa de review independente `requesting-code-review` antes de merge — regra dura da skill).
- (a) ainda acionáveis mas não iniciados: #6014 (atualizar skill artigo-especial — pode ser iniciado após merge de #6015); #6011 (docs review-test-email); #6008; #6005; #6004; #6003; #6001; #5995; #5969; #5808.
- (b) perguntas: #5998 (STOP spam, 3 opções, recomendação a); #5125 (acervo canônica, 3 opções, recomendação c).
- (c) bloqueios: #5942/#5826/#5653 (`systemd-failed-units`, ref #5548 sync `onedrive.service` morto desde 16/08); #5734 (reconciliação conversão, `aguardando-ate: 2026-08-28`, D0 do teste de canais #5524).

## Regra que este ciclo reforça (para a skill, quando adotada)
Quando um fix envolve `publish-linkedin.ts` (ou qualquer `publish-*`), o pipeline `requesting-code-review` (scan estático, baseline, reviewer independente via `delegate_task`, auto-fix loop) é obrigatório antes de merge. A PR #6020 ainda precisa desse passo — a evidência do veredito do reviewer independente deve ser registrada no PR antes de qualquer merge.
