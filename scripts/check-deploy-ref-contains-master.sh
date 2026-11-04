#!/usr/bin/env bash
# scripts/check-deploy-ref-contains-master.sh (#12118)
#
# Guard dos workflows de deploy de Worker: recusa publicar em PRODUÇÃO o
# código de uma branch que está ATRÁS do master.
#
# Por quê: `workflow_dispatch` de um deploy-*.yml a partir de uma branch
# publica o código DA BRANCH no Worker de produção. Em 04/11/2026
# (`/diaria-develop 261103d`, #11412) a branch `develop/blast-11412` estava
# 195 commits atrás do master, e o master tinha uma correção posterior no
# próprio Worker do poll (#12065). Deployar a branch como estava teria
# desfeito essa correção em produção, sem aviso nenhum do workflow.
#
# Regra: se o ref efetivo do deploy não for `master`, `origin/master` precisa
# ser ancestral do HEAD do checkout (`git merge-base --is-ancestor`). Senão,
# sai 1 com a instrução de rebasear. Ref `master` (push em master,
# regen-home.yml com `ref: master`) passa direto: é o fluxo normal, e um
# commit de master mais velho que o tip (push concorrente) não é regressão
# que este guard deva barrar.
#
# Uso: scripts/check-deploy-ref-contains-master.sh <ref-efetivo>
#   <ref-efetivo>: o ref que o deploy publica — no workflow,
#   `${{ inputs.ref || github.ref_name }}` (reusable) ou
#   `${{ github.ref_name }}` (standalone).
#
# Falha de `git fetch` também sai 1 (fail-closed): sem conseguir ler o master,
# não há como provar que a branch está em dia.
#
# Remoto: `origin` (o do actions/checkout). `DEPLOY_GUARD_REMOTE` sobrepõe,
# só para teste.

set -euo pipefail

REF="${1:-}"
REMOTE="${DEPLOY_GUARD_REMOTE:-origin}"

if [ -z "$REF" ]; then
  echo "::error::check-deploy-ref-contains-master (#12118): ref efetivo vazio — não dá para saber o que está sendo deployado. Passe o ref como 1º argumento."
  exit 1
fi

case "$REF" in
  master|refs/heads/master)
    echo "Ref efetivo é master — guard #12118 não se aplica."
    exit 0
    ;;
esac

FETCH_ARGS=(--no-tags "$REMOTE" "+refs/heads/master:refs/remotes/$REMOTE/master")
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  # Checkout raso (fetch-depth 1/2) não tem o histórico que o
  # merge-base precisa. --unshallow completa o histórico do HEAD também.
  FETCH_ARGS=(--unshallow "${FETCH_ARGS[@]}")
fi

if ! git fetch "${FETCH_ARGS[@]}"; then
  echo "::error::check-deploy-ref-contains-master (#12118): git fetch de $REMOTE/master falhou — sem ler o master não dá para provar que '$REF' está em dia. Deploy abortado (fail-closed)."
  exit 1
fi

if git merge-base --is-ancestor "$REMOTE/master" HEAD; then
  echo "OK (#12118): $REMOTE/master é ancestral de HEAD ($REF) — a branch contém tudo do master."
  exit 0
fi

BEHIND="$(git rev-list --count "HEAD..$REMOTE/master")"
echo "::error::check-deploy-ref-contains-master (#12118): a branch '$REF' está $BEHIND commit(s) atrás de $REMOTE/master. Deployar daqui publicaria em PRODUÇÃO código sem as correções mais recentes do master (e desfaria as que já estão no ar). Rebaseie a branch em $REMOTE/master (ou faça merge do master nela), dê push e rode o deploy de novo."
exit 1
