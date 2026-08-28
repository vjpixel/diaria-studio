# Processamento em lote de PRs abertos (evidência 26/08)

Sessão real: 5 PRs acumulados por ~1 dia foram revisados e mergeados em um único ciclo
usando o pipeline `requesting-code-review` em paralelo.

## Fluxo validado

1. **Coleta**: `gh pr list --author @me --state open` + `gh pr diff N > /tmp/pr-N.diff`
   para cada PR.
2. **Scan estático em lote** (uma passada): grep de segredos/injection/eval nas linhas
   `+` de todos os diffs.
3. **Baseline**: testes afetados rodando no `master` limpo ANTES dos merges.
4. **Reviewers paralelos**: um `delegate_task` por PR, todos disparados no MESMO bloco,
   cada um lendo seu `/tmp/pr-N.diff`. Veredito JSON fail-closed. Custo: ~20–35s cada.
5. **Merge sequencial** dos `passed:true`.

## Pitfall crítico: checar SUPERSEDED antes de mergear

Na sessão 26/08 o PR #6238 (fix DMARC) passou no review mas estava **supersedido**:
o master já tinha recebido (PR #6239) um fix melhor para a mesma issue — query com
AMBOS os remetentes + teste, contra a troca 1-por-1 do PR pendente. Merge teria
REGREDIDO o master.

Regra: antes de mergear cada PR, verificar se o master atual ainda precisa dele:

```bash
git fetch origin -q
git log origin/master --oneline -- <arquivos-do-pr> | head -5
gh pr view N --json files --jq '[.files[].path]'
```

Se outra PR/commit recente já tratou a mesma issue de forma igual ou melhor:
`gh pr close N --comment "superseded por <ref>, motivo"` — nunca mergear por inércia.

## Conflito no merge: resolver no worktree do branch

Padrão usado no #6241 (conflito de snapshot hash + line budget):

1. `cd <worktree-do-branch> && git fetch origin && git merge origin/master`
2. Resolver conflitos SEMANTICAMENTE (combinar comentários de ambos os lados quando
   ambos descrevem mudanças reais — ex: comentários #6098 + #6202 no mesmo map).
3. Se teste de budget falhar porque o arquivo ficou acima do teto: condensar prosa
   redundante preservando os fatos (refs de issue, comandos, decisões) até caber.
4. Snapshot drift (`content changed`): rodar com flag de update-snapshots DEPOIS de
   resolver o conteúdo — nunca antes (senão grava hash do conteúdo quebrado).
5. Rodar os testes afetados do PR no worktree pós-merge (`npm ci` em worktree novo),
   commit do merge, push, então `gh pr merge`.
6. Depois do merge, sincronizar checkout principal: `git pull` pode divergir se houve
   rebase local — usar `git merge --ff-only` e, em último caso, `git rebase origin/master`.

## Evidência da sessão 26/08

- #6218 (tsconfig.test.json) → merged 12:49:12Z
- #6237 (provenance labels) → merged 12:49:15Z
- #6216 (kit click fields) → merged 12:49:20Z
- #6241 (beehiiv schedule guard) → conflito resolvido → merged 12:53:29Z
- #6238 (dmarc query) → closed superseded (#6239 superior já em master)
