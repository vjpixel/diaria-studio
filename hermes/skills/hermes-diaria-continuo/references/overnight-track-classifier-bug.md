---
name: overnight-track-classifier-bug
description: Correção #5948 aplicada e pendente (23/08) — contexto de merge lock cross-sessão.
---

# Referência — correção aplicada e pendente (23/08, sessão continuado)

Fonte: conversa entre Pixel (editor/dono) e Hermes Agent — ciclo Diária Contínuo, 23/08/2026 (BRT, UTC-03).

## O que foi feito (verificado com tool output real, não relato)

1. **Investigação das 5 issues classificadas 'overnight'**: verificadas com `gh issue view N --json title,state,updatedAt` para #5926, #5917, #5908, #5140, #5947 (+ #5116 epic). Resultado documentado no comentário da issue #5948 (bug P1, criada via `gh issue create`, body-file /tmp/new-bug.md, label `bug` + `P1`).
2. **Regra do editor incorporada na skill** (`SKILL.md`): objetivo atualizado ("fila vazia de (a), com (b) perguntados e (c) registrados"), seção "Orçamento por ciclo" adicionada (limite ~120 iterações, nunca morrer com worktree sujo), regra do review independente (`requesting-code-review`) adicionada com 5 passos, e a regra "multi-batch = (a) contínuo" adicionada à seção 5.
3. **Pipeline `requesting-code-review` testado no mundo real**: PR #5932 (refactor #5894, box handlers, diff 31757 chars, +314/−346) passou pelo reviewer independente (`delegate_task` com contexto isolado) — veredito `passed=true`, `behavior_drift_found=false`, com 4 sugestões non-blocking registradas no PR. Mergeado via `gh pr merge 5932 --squash`; master atualizado (`git log -1` confirma `610474f2`). Branch `continuo/fix-5894-server-ts-routes` removida após merge.
4. **Correção preventiva no cron**: `model.max_tokens: 16384` no `~/.hermes/config.yaml` (motivo: truncamento em 150 iterações no ciclo 22/08). `project: diarios/continuous-run` + `priority: P1` adicionados ao `plan.json`.

## Pendências (não executadas nesta sessão — requerem sessão com usuário presente ou próximo ciclo)

- `hermes curator adopt hermes-diaria-continuo` — a skill é user-owned; sem `adopt`, patches autônomos são recusados (erro visto: "Refusing background curator patch for skill 'hermes-diaria-continuo': the skill is not curator-managed").
- Corrigir o classificador (`scripts/lib/issue-exec-track.ts` ou `.claude/hooks/*overnight*`) para excluir `CLOSED`, `bloqueio-execucao`/`aguardando-ate`/`develop-track` antes de classificar `overnight` — a causa raiz da #5948.
- Atualizar as labels das 4 restantes (#5926 já CLOSED; #5908 já `bloqueio-execucao`; #5917 precisa `aguardando-ate` e/ou `develop-track`; #5140 precisa `aguardando-ate`).
- Continuar o batch 3 do refactor #5894 (apoios, review, utms/tasks/ads, chat) — só começa se (i) orçamento disponível e (ii) batch 2 (boxes) já mergeado no master — condição (ii) confirmada (`git log master` confirma `610474f2`).

## Verificação (reprodutível — não relato)

Cada item acima tem um handle verificável: `gh issue view 5948`, `git log --format=%h master`, `gh pr view 5932 --json state`, `grep "model.max_tokens" ~/.hermes/config.yaml`, leitura do `SKILL.md` atualizado. Nenhum dos resultados acima vem de relato de subagente: o reviewer independente de #5932 retornou JSON parseável (`passed:true`) que li diretamente; o diagnóstico das 5 issues veio de chamadas `gh` com saída real.
