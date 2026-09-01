#!/usr/bin/env bash
# test/continuo-pr-review-gh-api-sha-6923.test.sh (#6923)
#
# Regressão: `gh pr view --json baseRefOid/headRefOid` não existe no `gh`
# 2.46 do helios (pacote ESM da distro) — a chamada falhava com
# "Unknown JSON field: \"baseRefOid\"" ANTES de qualquer diff ser lido, e
# por ser a primeira coisa que o laço faz por PR, TODA PR era pulada em
# TODA rodada (nenhum teste exercitava esse caminho, por isso a quebra
# total passou despercebida — ver corpo da issue).
#
# Mecanismo (mesmo padrão do #6885/#6891/#6910 — extrai e roda o
# FRAGMENTO REAL, não uma reimplementação): isola via `sed` o bloco exato
# de obtenção de SHA/title entre o comentário `# #6923:` e o `read` final,
# e roda esse bloco como processo bash de verdade contra um `gh` FAKE no
# PATH — um que devolve o erro EXATO de campo desconhecido para
# `gh pr view` (provando que o script não depende mais desse caminho) e um
# TSV determinístico para `gh api repos/.../pulls/N`, como a REST v3 real.
#
# Uso: bash test/continuo-pr-review-gh-api-sha-6923.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"

FAILED=0
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle], obtido [$haystack]"; FAILED=1 ;;
  esac
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Sanity estrutural primeiro — se o script voltou a chamar o campo morto,
# o teste falha aqui em vez de silenciosamente testar o caminho errado.
if grep -q 'baseRefOid\|headRefOid' "$SCRIPT"; then
  echo "FAIL: $SCRIPT ainda referencia baseRefOid/headRefOid (regressão do #6923)"
  FAILED=1
fi

BLOCK=$(sed -n '/# #6923: os dois campos/,/read -r BASE_SHA HEAD_SHA PR_TITLE/p' "$SCRIPT")
if [ -z "$BLOCK" ]; then
  echo "FAIL: não encontrei o bloco de obtenção de SHA/title (marcador #6923 mudou?)"
  FAILED=1
fi
case "$BLOCK" in
  *'gh api "repos/{owner}/{repo}/pulls/$PR"'*) ;;
  *) echo "FAIL: bloco extraído não chama gh api repos/.../pulls/\$PR"; FAILED=1 ;;
esac

if [ "$FAILED" -eq 0 ]; then
  mkdir -p "$WORKDIR/bin"
  cat > "$WORKDIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo 'Unknown JSON field: "baseRefOid"' >&2
  exit 1
fi
if [ "$1" = "api" ]; then
  printf 'deadbeefbase\tdeadbeefhead\tTítulo de teste #6923\n'
  exit 0
fi
exit 1
EOF
  chmod +x "$WORKDIR/bin/gh"

  # `PR` e `log_infra_error`/`INFRA_ERRORS`/`continue` (fora de loop, no-op
  # aqui) precisam existir pro bloco extraído rodar standalone.
  {
    echo 'PR=6901'
    echo 'INFRA_ERRORS=0'
    echo 'log_infra_error() { :; }'
    echo 'continue() { :; }'
    echo "$BLOCK"
    echo 'echo "BASE_SHA=$BASE_SHA HEAD_SHA=$HEAD_SHA PR_TITLE=$PR_TITLE" > "'"$WORKDIR/out.txt"'"'
  } > "$WORKDIR/runnable.sh"

  PATH="$WORKDIR/bin:$PATH" bash "$WORKDIR/runnable.sh" >"$WORKDIR/stdout.txt" 2>"$WORKDIR/stderr.txt"

  if [ ! -f "$WORKDIR/out.txt" ]; then
    echo "FAIL: bloco extraído não chegou a resolver BASE_SHA/HEAD_SHA/PR_TITLE"
    echo "  stdout: $(cat "$WORKDIR/stdout.txt")"
    echo "  stderr: $(cat "$WORKDIR/stderr.txt")"
    FAILED=1
  else
    RESULT="$(cat "$WORKDIR/out.txt")"
    assert_contains "BASE_SHA vem do gh api (não do gh pr view morto)" "$RESULT" "BASE_SHA=deadbeefbase"
    assert_contains "HEAD_SHA vem do gh api" "$RESULT" "HEAD_SHA=deadbeefhead"
    assert_contains "PR_TITLE vem do gh api, preserva espaços/acentos" "$RESULT" "PR_TITLE=Título de teste #6923"
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
