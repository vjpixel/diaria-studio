#!/usr/bin/env bash
# Teste de regressão pro #6875/#6879/#6891 — o preflight compartilhado
# precisa: (1) passar direto quando o binário já responde `--version`; (2)
# reparar UMA vez e seguir, avisando no stderr, quando o reparo resolve; (3)
# sair com exit 5 + mensagem nomeada quando o binário está quebrado E o
# reparo não resolve.
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

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle], obtido [$haystack]"; FAILED=1 ;;
  esac
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# ── Caminho 1: binário já saudável — reparo nunca é acionado ──────────────

cat > "$WORKDIR/claude-ok" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$WORKDIR/claude-ok"

set +e
STDERR_OK="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ok"
    # REPAIR_CMD que, se executado, provaria (via marker) que o reparo foi
    # acionado sem necessidade — não deve ser chamado neste caminho.
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/repair-called-unnecessarily"
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_OK=$?
set -e
assert_eq "binário OK: preflight não sai (exit 0)" "0" "$RC_OK"
assert_eq "binário OK: reparo NUNCA acionado (marker ausente)" "false" "$([ -f "$WORKDIR/repair-called-unnecessarily" ] && echo true || echo false)"
assert_eq "binário OK: nenhum AVISO/ERRO no stderr" "" "$STDERR_OK"

# ── Caminho 2: binário quebrado, reparo RESOLVE (marker-based fake) ───────

# claude-broken-then-fixed simula o binário real: falha até o marker
# aparecer (é o que o "reparo" cria), depois passa a responder OK — mesmo
# comportamento do install.cjs real corrigindo o binário no disco.
cat > "$WORKDIR/claude-broken-then-fixed" <<EOF
#!/usr/bin/env bash
[ -f "$WORKDIR/fixed-marker" ] && exit 0 || exit 1
EOF
chmod +x "$WORKDIR/claude-broken-then-fixed"
rm -f "$WORKDIR/fixed-marker"

set +e
STDERR_REPAIRED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken-then-fixed"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/fixed-marker"
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_REPAIRED=$?
set -e
assert_eq "reparo resolve: preflight NÃO sai (exit 0, segue normalmente)" "0" "$RC_REPAIRED"
assert_contains "reparo resolve: AVISO no stderr (#6891 — nunca silencioso)" "$STDERR_REPAIRED" "AVISO: binário Claude Code estava quebrado — reparado automaticamente"

# ── Caminho 3: binário quebrado, reparo NÃO resolve → exit 5 como antes ───

cat > "$WORKDIR/claude-broken" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/claude-broken"

set +e
STDERR_BROKEN="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="true"  # reparo roda, mas não conserta nada
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_BROKEN=$?
set -e
assert_eq "reparo não resolve: preflight sai com exit 5" "5" "$RC_BROKEN"
assert_contains "reparo não resolve: mensagem nomeada, não enigmática" "$STDERR_BROKEN" "ERRO: binário Claude Code quebrado"
assert_contains "reparo não resolve: mensagem cita que o reparo foi tentado" "$STDERR_BROKEN" "reparo automático não resolveu"

# ── npm root -g falha/vazio: reparo NUNCA é tentado (mensagem distinta) ───
# Achado do review PR #6894 (P3): sem prefixo npm resolvido, "reparo não
# resolveu" seria enganoso — o reparo nem chegou a rodar.

cat > "$WORKDIR/npm-fail" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/npm-fail"

set +e
STDERR_NO_NPM_ROOT="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fail"
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_NO_NPM_ROOT=$?
set -e
assert_eq "npm root -g falha: preflight sai com exit 5" "5" "$RC_NO_NPM_ROOT"
assert_contains "npm root -g falha: mensagem diz que o reparo NÃO foi tentado (nunca 'não resolveu')" "$STDERR_NO_NPM_ROOT" "reparo automático NÃO foi tentado"

# ── Binário ausente (sem override de reparo) — mesmo comportamento de antes ─

set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ausente-nao-existe"
  CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="true"
  claude_binary_preflight
) >/dev/null 2>&1
RC_ABSENT=$?
set -e
assert_eq "binário ausente: preflight sai com exit 5" "5" "$RC_ABSENT"

# ── Derivação do install.cjs a partir do prefixo do npm (não hardcoded) ───
# #6891: o caminho vem de `npm root -g`, config da máquina, não constante.
# Testado com um `npm` FAKE (via CLAUDE_BINARY_PREFLIGHT_NPM_CMD) + um
# install.cjs de verdade (roda com o `node` real) que grava um marker —
# prova a derivação ponta a ponta sem depender do npm/instalação reais.

mkdir -p "$WORKDIR/fakeroot/@anthropic-ai/claude-code"
cat > "$WORKDIR/fakeroot/@anthropic-ai/claude-code/install.cjs" <<EOF
const fs = require("fs");
fs.writeFileSync("$WORKDIR/derived-install-ran", "ok");
EOF

cat > "$WORKDIR/npm-fake" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "root" ] && [ "\$2" = "-g" ]; then
  echo "$WORKDIR/fakeroot"
  exit 0
fi
exit 1
EOF
chmod +x "$WORKDIR/npm-fake"

cat > "$WORKDIR/claude-broken-then-fixed-2" <<EOF
#!/usr/bin/env bash
[ -f "$WORKDIR/derived-install-ran" ] && exit 0 || exit 1
EOF
chmod +x "$WORKDIR/claude-broken-then-fixed-2"
rm -f "$WORKDIR/derived-install-ran"

set +e
STDERR_DERIVED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken-then-fixed-2"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fake"
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_DERIVED=$?
set -e
assert_eq "derivação via npm root -g: preflight resolve (exit 0)" "0" "$RC_DERIVED"
assert_eq "derivação via npm root -g: install.cjs derivado de fato rodou" "true" "$([ -f "$WORKDIR/derived-install-ran" ] && echo true || echo false)"
assert_contains "derivação via npm root -g: AVISO cita o caminho derivado (não hardcoded)" "$STDERR_DERIVED" "$WORKDIR/fakeroot"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
