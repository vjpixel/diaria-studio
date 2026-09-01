#!/usr/bin/env bash
# Teste de regressão #6891 Parte A — DISABLE_AUTOUPDATER=1 precisa estar
# presente no AMBIENTE DO PROCESSO que de fato invoca `claude`, não só como
# linha no arquivo (#6859 já ensinou que um teste de conteúdo de linha passa
# mesmo com a linha comentada, num bloco morto, ou colocada DEPOIS da
# invocação — nenhum desses erros seria pego por `grep`).
#
# Mecanismo: extrai (via `awk`, não reescreve) as linhas REAIS de cada
# script de hermes/scripts/ desde o topo até a chamada de
# `claude_binary_preflight` (inclusive) — a MESMA fração de código que
# roda antes de qualquer invocação real do binário `claude`. Executa essa
# fração como processo bash de verdade, com um `claude` FAKE na frente do
# PATH que só grava o próprio ambiente (o do processo filho de verdade,
# não o arquivo-fonte) num arquivo e sai 0. Corta ali de propósito — o
# resto de cada script faz chamadas de rede reais (git fetch, gh, `claude
# -p`), que este teste não deve disparar.
#
# Uso: bash hermes/scripts/disable-autoupdater-scope.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAILED=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $desc — esperado [$expected], obtido [$actual]"
    FAILED=1
  else
    echo "ok: $desc"
  fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/bin"
cat > "$WORKDIR/bin/claude" <<'EOF'
#!/usr/bin/env bash
# Fake do binário real: responde --version com sucesso (preflight passa
# sem precisar reparar nada) e grava o AMBIENTE REAL deste processo filho
# — é isto, e não o arquivo-fonte, que o teste inspeciona.
env > "${FAKE_CLAUDE_ENV_DUMP:?}"
exit 0
EOF
chmod +x "$WORKDIR/bin/claude"

check_script() {
  local script="$1" name="$2"
  # O fragmento precisa viver NO MESMO DIRETÓRIO do script real — cada
  # script resolve `lib/claude-binary-preflight.sh` via
  # `dirname "${BASH_SOURCE[0]}"`, então rodar o fragmento de outro
  # diretório (ex: $WORKDIR) quebraria esse `source` por um motivo
  # completamente alheio ao que este teste verifica.
  local fragment="$DIR/.fragment-$name-$$.sh"
  local envfile="$WORKDIR/env-$name.txt"
  rm -f "$envfile"
  trap 'rm -f "$fragment"' RETURN

  # Extrai da linha 1 até a 1ª ocorrência de `claude_binary_preflight`
  # sozinha numa linha (a chamada da função, não a definição/import) —
  # awk, não sed/grep de conteúdo: o script RODA de verdade até ali.
  awk '{print} /^claude_binary_preflight$/{exit}' "$script" > "$fragment"

  if ! grep -q '^claude_binary_preflight$' "$fragment"; then
    echo "FAIL: $name — não encontrei a chamada claude_binary_preflight no script real (script mudou de forma inesperada?)"
    FAILED=1
    return
  fi

  PATH="$WORKDIR/bin:$PATH" FAKE_CLAUDE_ENV_DUMP="$envfile" bash "$fragment" >/dev/null 2>&1
  # Ignora o exit code do fragmento (ele termina logo após o preflight,
  # sem cleanup — irrelevante pra este teste).

  if [ ! -f "$envfile" ]; then
    echo "FAIL: $name — o \`claude\` fake nunca foi invocado (preflight não rodou dentro do fragmento extraído?)"
    FAILED=1
    return
  fi

  if grep -q '^DISABLE_AUTOUPDATER=1$' "$envfile"; then
    echo "ok: $name — DISABLE_AUTOUPDATER=1 presente no AMBIENTE REAL do processo que invocou claude"
  else
    local seen
    seen="$(grep '^DISABLE_AUTOUPDATER=' "$envfile" || echo '(variável ausente do ambiente)')"
    echo "FAIL: $name — DISABLE_AUTOUPDATER ausente/incorreto no ambiente real do processo (visto: $seen)"
    FAILED=1
  fi
}

check_script "$DIR/claude-openrouter.sh" "claude-openrouter"
check_script "$DIR/continuo-pr-review.sh" "continuo-pr-review"
check_script "$DIR/opus-daily-diff-review.sh" "opus-daily-diff-review"

# ── Escopo: não deve vazar pro AMBIENTE DESTE processo de teste (nunca export persistente) ──
assert_eq "DISABLE_AUTOUPDATER não vaza pro processo do TESTE em si (escopado aos 3 scripts, não ao shell chamador)" "" "${DISABLE_AUTOUPDATER:-}"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
