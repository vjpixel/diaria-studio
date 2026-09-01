#!/usr/bin/env bash
# scripts/lib/glm-lane-headref-guard.sh (#6954)
#
# Validação do `headRefName` de uma PR ANTES de interpolá-lo dentro da
# string `--tools` de `scripts/dispatch-glm-lane-unit.sh` (modo `--pr N`).
#
# Achado de review independente (P0, reproduzido ao vivo — não teorizado):
# as regras de nome de branch do git (`git check-ref-format --branch`)
# proíbem espaço/`:`/`~`/`^`/`*`/`?`/`[`/`\`, mas NÃO proíbem vírgula nem
# parênteses. Um `headRefName` como `x),Bash(git` é um nome de branch
# VÁLIDO segundo o git, e interpolado sem validação numa string como
#   Bash(git push origin ${BRANCH}:*)
# produz
#   Bash(git push origin x),Bash(git:*)
# — uma concessão IRRESTRITA de `Bash(git:*)`, a mesma classe que o #6941
# já demonstrou permitir `git push origin HEAD:master`. O `--tools`/
# `--allowedTools` do Claude Code é parseado literalmente como lista de
# patterns separados por vírgula — a string produzida por essa injeção é
# gramaticalmente válida pro parser, não um erro que ele rejeitaria.
#
# Extraído como função isolada (mesmo molde de `scripts/lib/wait-pr-
# checks.sh`) pra ser testável executando a substituição de verdade com
# valores hostis (ver `glm-lane-headref-guard.test.sh`), não só regex
# estática sobre o código-fonte do chamador.
#
# Toda branch que `dispatch-glm-lane-unit.sh` cria segue
# `continuo/glm-<issue>-<timestamp>` — o allowlist abaixo é
# deliberadamente mais permissivo que isso (aceita qualquer coisa em
# [A-Za-z0-9._/-]) pra não quebrar se alguém renomear a branch da PR à
# mão, mas ainda assim exclui TODO caractere que a gramática de
# `--allowedTools` trata como especial (vírgula, parênteses, espaço,
# aspas, `$`, `` ` ``, etc.).

# is_safe_glm_branch_ref REF — devolve 0 (seguro, pode interpolar) ou 1
# (contém caractere fora do allowlist — NUNCA interpolar).
is_safe_glm_branch_ref() {
  local ref="$1"
  [[ -n "$ref" && "$ref" =~ ^[A-Za-z0-9._/-]+$ ]]
}
