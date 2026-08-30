#!/usr/bin/env bash
# continuo-branch-prefix.sh (#6771, absorve #6709)
#
# Único ponto de verdade do filtro jq que classifica um `headRefName` como
# "prefixo autônomo reconhecido" ou "suspeito, sem prefixo reconhecido" — usado
# pelo check 5 de `watch-continuo-health.sh` ("adoção da convenção de
# branch"). Extraído pra arquivo próprio (em vez de inline no script) porque
# esta é a 2ª vez que o allowlist precisa crescer (#6709 → #6771) e um teste
# de regressão (`continuo-branch-prefix.test.sh`) precisa exercitar o MESMO
# filtro que roda em produção — duplicar a string entre script e teste seria
# o mesmo risco de drift que motivou extrair `pr-review-authenticity.ts` em
# vez de inline no hook (#6732).
#
# Prefixos aceitos:
#   - continuo/, overnight/, develop/, dependabot/ — autônomos de verdade
#     (a única coisa que este check quer flagar quando ausente).
#   - fix/, docs/, feat/, chore/, refactor/, test/ — convenção de branch de
#     sessão interativa/manual já em uso neste repo. As 5 primeiras cobrem os
#     7 casos reais do #6709 (fix/6691-..., docs/6674-..., fix/6643-...,
#     fix/tokens-panel-day-aggregation, feat/diaria-desbloqueia-skill).
#     `refactor/`/`test/` não aparecem nesses 7, mas têm histórico real
#     confirmado no fleet review do #6821 via `gh pr list --search
#     "head:refactor/"`/`"head:test/"` (dezenas de PRs, ex: #2661, #2001,
#     #1042, #947) — `git branch`/`for-each-ref` local não os acha porque as
#     branches já foram deletadas pós-merge, mas o PR (e o padrão de uso)
#     é real; mantidos por evidência histórica, não por suposição.
#   - hotfix/ — exceção documentada em CLAUDE.md ("1 PR aberto por vez",
#     hotfix P0 pode abrir em paralelo) e com uso real recente (achado do
#     fleet review do #6821: hotfix/onboarding-mass-send-killswitch,
#     hotfix/6060-restaura-plumbing-continuo, ambas 24/08/2026) — faltava na
#     1ª versão deste allowlist e teria reproduzido o mesmo falso-positivo.
#   - worktree- (sem barra) — branches efêmeras de worktree de subagente
#     (ex: worktree-fix-6664-desbloqueia-track-guard).
# Nenhum destes é usado pelo contínuo, que sempre gera `continuo/fix-N-slug`
# (hermes-diaria-continuo/SKILL.md, seção "4. Implementar issues elegíveis",
# passo 2 "Delegar a implementação ao harness" — SKILL.md não tem
# subseções numeradas tipo "4.2", não citar como se tivesse) — o filtro
# continua pegando o caso real do #6461 (PR do contínuo sem prefixo
# reconhecido).
CONTINUO_BRANCH_PREFIX_JQ_FILTER='
  [.[] | select(.createdAt > (now - 86400 | todate))
       | select(.author.login == "vjpixel")
       | .headRefName
       | select((startswith("continuo/") or startswith("overnight/") or startswith("develop/") or startswith("dependabot/")
                 or startswith("fix/") or startswith("docs/") or startswith("feat/") or startswith("chore/")
                 or startswith("refactor/") or startswith("test/") or startswith("worktree-")
                 or startswith("hotfix/")) | not)
  ] | join(", ")'
