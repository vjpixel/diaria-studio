#!/usr/bin/env bash
# Teste de regressão pro #6875/#6879 — o preflight compartilhado precisa
# passar quando o binário responde `--version` com sucesso e sair com exit 5
# + mensagem nomeada quando o binário está ausente/quebrado.
#
# Uso: bash hermes/scripts/lib/claude-binary-preflight.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./claude-binary-preflight.sh
source "$DIR/claude-binary-preflight.sh"

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

# Binário OK: cria um comando fake que responde --version com sucesso.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/claude-ok" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$WORKDIR/claude-ok"

set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ok"
  claude_binary_preflight
)
RC_OK=$?
set -e
assert_eq "binário OK: preflight não sai (exit 0)" "0" "$RC_OK"

# Binário quebrado: comando existe mas --version falha.
cat > "$WORKDIR/claude-broken" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/claude-broken"

set +e
STDERR_BROKEN="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken"
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_BROKEN=$?
set -e
assert_eq "binário quebrado: preflight sai com exit 5" "5" "$RC_BROKEN"
case "$STDERR_BROKEN" in
  *"ERRO: binário Claude Code quebrado"*) echo "ok: mensagem nomeada, não enigmática" ;;
  *) echo "FAIL: mensagem esperada ausente — obtido [$STDERR_BROKEN]"; FAILED=1 ;;
esac

# Binário ausente (comando não existe no PATH nem como path absoluto).
set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ausente-nao-existe"
  claude_binary_preflight
) >/dev/null 2>&1
RC_ABSENT=$?
set -e
assert_eq "binário ausente: preflight sai com exit 5" "5" "$RC_ABSENT"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
