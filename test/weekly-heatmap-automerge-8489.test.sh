#!/usr/bin/env bash
# test/weekly-heatmap-automerge-8489.test.sh (#8489)
#
# Exercita o SCRIPT REAL do passo "Merge quando os checks passarem" de
# `.github/workflows/weekly-bug-heatmap.yml` — extraído do YAML e rodado
# com `gh` e `sleep` fakes no PATH. Nenhuma chamada de rede, nenhum sleep
# real.
#
# O guard irmão (`weekly-heatmap-automerge-8489.test.ts`) afirma coisas
# sobre o TEXTO do workflow (o passo existe, o id casa, a ordem é essa).
# Este aqui prova o COMPORTAMENTO que o review do PR #8491 apontou como
# não coberto por regex (finding 1, P1): os ~14 checks vêm de 5 workflows
# distintos e não se registram no mesmo instante, então esperar só "≥1
# check apareceu" podia devolver "tudo verde" tendo observado 1 check de
# 14 — e mergear sem verificação, em silêncio, que é justamente o que o
# passo existe pra impedir.
#
# Uso: bash test/weekly-heatmap-automerge-8489.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/weekly-bug-heatmap.yml"
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

# ── extrai o `run:` do ÚLTIMO passo (o de merge) e de-indenta ──────────────
extract_merge_script() {
  awk '
    /^        run: \|$/ { start = NR; buf = ""; next }
    start && /^          / { buf = buf substr($0, 11) "\n"; next }
    start && /^[[:space:]]*$/ { buf = buf "\n"; next }
    start { start = 0 }
    END { printf "%s", buf }
  ' "$WORKFLOW"
}

SCRIPT="$(extract_merge_script)"
if ! echo "$SCRIPT" | grep -q "gh pr merge"; then
  echo "FAIL: não consegui extrair o script do passo de merge do workflow"
  exit 1
fi

# ── roda o script com `gh`/`sleep` fakes ──────────────────────────────────
# $1: roteiro de contagens de check (uma por chamada de `gh pr view`; a
#     última linha se repete). $2: exit code do `gh pr checks --watch`.
# Ecoa "<rc>|<checks no momento do merge, ou vazio>|<nº de watches>".
run_scenario() {
  local counts="$1" watch_rc="$2"
  local tmp; tmp="$(mktemp -d)"
  printf '%s\n' "$counts" > "$tmp/counts"
  : > "$tmp/merged"; : > "$tmp/watches"; echo 0 > "$tmp/idx"

  cat > "$tmp/gh" <<GH
#!/usr/bin/env bash
sub="\$1 \$2"
case "\$sub" in
  "pr view")
    i=\$(cat "$tmp/idx"); i=\$((i + 1)); echo "\$i" > "$tmp/idx"
    n=\$(sed -n "\${i}p" "$tmp/counts")
    [ -z "\$n" ] && n=\$(tail -n 1 "$tmp/counts")
    echo "\$n" > "$tmp/last-count"
    echo "\$n" ;;
  "pr checks")
    echo x >> "$tmp/watches"
    exit $watch_rc ;;
  "pr merge")
    cat "$tmp/last-count" > "$tmp/merged" ;;
  *) echo "gh fake: subcomando inesperado: \$*" >&2; exit 99 ;;
esac
GH
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/sleep"
  chmod +x "$tmp/gh" "$tmp/sleep"

  PATH="$tmp:$PATH" PR=123 bash -eo pipefail -c "$SCRIPT" >/dev/null 2>&1
  local rc=$?
  echo "$rc|$(cat "$tmp/merged")|$(wc -l < "$tmp/watches" | tr -d ' ')"
  rm -rf "$tmp"
}

# 1. Retardatários: 1 check registrado, os outros 13 chegam depois. O merge
#    só pode acontecer depois da contagem estabilizar em 14 — este é o
#    finding P1 do review; com a versão "espera ≥1 check" o merge saía com 1.
R="$(run_scenario "$(printf '1\n14\n14\n')" 0)"
assert_eq "retardatário: mergeia só com a contagem estável (14, não 1)" "0|14|2" "$R"

# 2. Caminho feliz: os 14 já estão lá desde a 1ª leitura.
R="$(run_scenario "$(printf '14\n14\n14\n')" 0)"
assert_eq "14 checks estáveis desde o início -> mergeia" "0|14|2" "$R"

# 3. Check vermelho: `gh pr checks --watch --fail-fast` sai != 0 e o `-e`
#    default do Actions aborta ANTES do merge.
R="$(run_scenario "$(printf '14\n14\n')" 1)"
assert_eq "check vermelho -> falha e NÃO mergeia" "1||1" "$R"

# 4. Nenhum check jamais se registra: o teto de 3min estoura, o `gh pr
#    checks` erra (é o que ele faz com 0 checks) e nada é mergeado.
R="$(run_scenario "$(printf '0\n')" 1)"
assert_eq "nenhum check dentro do teto -> falha e NÃO mergeia" "1||1" "$R"

if [ "$FAILED" -ne 0 ]; then
  echo "— FALHOU"
  exit 1
fi
echo "— todos os cenários passaram"
