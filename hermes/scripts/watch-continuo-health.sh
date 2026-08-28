#!/usr/bin/env bash
# watch-continuo-health.sh — observador DETERMINÍSTICO (zero LLM) da saúde da
# arquitetura contínuo v0.5.0 + review Opus diário. Roda 1x/dia via cron do
# Hermes (--no-agent). Cada checagem que degrada vira ISSUE no GitHub com
# P-label (regra do CLAUDE.md: nunca perguntar, criar com prioridade), com
# dedup contra issue aberta equivalente.
#
# Por que existe (28/08/2026, pedido do editor: "eu não vou lembrar de
# observar nada"): a v0.5.0 saiu com pendências de observação que dependiam
# de alguém olhar log — este script é o alguém. Checa:
#   1. review Opus diário rodou nas últimas 26h (marco fresco);
#   2. cron do contínuo sem failure_streak >= 2;
#   3. claims não voltaram a vazar (sessão continuo com claims e heartbeat
#      parado > 45min — tick é de 30min, higiene deveria limpar);
#   4. vazamento pago (hermes-model-cost-report --json, campo vazamento_pago);
#   5. adoção do wrapper: se surgiram PRs novos do fluxo autônomo SEM prefixo
#      continuo/ nem overnight/ nem develop/, a skill não está seguindo a
#      convenção (#6461) — informational.
#
# Fail-soft por checagem: uma checagem quebrada reporta e segue pras demais;
# só o exit final agrega. Sem estado próprio além do GitHub (dedup por título).
set -uo pipefail

REPO="/home/vjpixel/diaria-studio"
cd "$REPO" || { echo "ERRO: repo ausente"; exit 1; }
FAILS=0

# Dedup: existe issue ABERTA com este marcador no título?
have_issue() {
  local marker="$1"
  local n
  n=$(gh issue list --state open --search "\"$marker\" in:title" --json number --jq 'length' 2>/dev/null || echo "")
  [ -n "$n" ] && [ "$n" -gt 0 ]
}

file_issue() {
  local marker="$1" title="$2" label="$3" body="$4"
  if have_issue "$marker"; then
    echo "[watch] $marker: issue aberta já existe — sem duplicar"
    return 0
  fi
  if gh issue create --title "$title" --label "$label" --body "$body" >/dev/null 2>&1; then
    echo "[watch] $marker: ISSUE CRIADA"
  else
    echo "[watch] $marker: FALHA ao criar issue (gh indisponível?)" >&2
    FAILS=$((FAILS + 1))
  fi
}

# ── 1. Review Opus diário rodou? ─────────────────────────────────────────────
MARCO="$REPO/data/continuo/last-daily-review-sha"
if [ -f "$MARCO" ]; then
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$MARCO") ) / 3600 ))
  if [ "$AGE_H" -gt 26 ]; then
    file_issue "[watch-continuo] review diário parado" \
      "[watch-continuo] review Opus diário não roda há ${AGE_H}h — marco estagnado" \
      "bug,P2" \
      "Detectado por hermes/scripts/watch-continuo-health.sh: \`data/continuo/last-daily-review-sha\` sem escrita há ${AGE_H}h (esperado: avanço diário ~12:00 UTC, cron 645d5debb7f0). Checar: \`hermes cron list\`, transcript em \`data/continuo/last-daily-review-output.txt\`, e se o gate RESUMO-DAILY-REVIEW segurou o marco de propósito (nesse caso o problema é o review incompleto, não o cron). P2: a auditoria Opus é a rede de qualidade dos merges autônomos."
  else
    echo "[watch] review diário ok (${AGE_H}h)"
  fi
else
  echo "[watch] marco do review ainda não existe (1ª execução pendente) — sem issue"
fi

# ── 2. failure_streak do contínuo ────────────────────────────────────────────
STREAK=$(python3 -c "
import json
try:
    for x in json.load(open('/home/vjpixel/.hermes/cron/jobs.json'))['jobs']:
        if x['id']=='5d791ef6fc2c': print(x.get('failure_streak',0)); break
except Exception: print('')" 2>/dev/null)
if [ -n "$STREAK" ] && [ "$STREAK" -ge 2 ] 2>/dev/null; then
  file_issue "[watch-continuo] cron em falha" \
    "[watch-continuo] Diária Contínuo com failure_streak=$STREAK" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh: job 5d791ef6fc2c com failure_streak=$STREAK. Ver \`~/.hermes/logs/agent.log\` e \`last_error\` no jobs.json. P1: fila de produção parada sem workaround automático (o watchdog de rotação só troca o modelo do ORQUESTRADOR)."
else
  echo "[watch] streak do continuo ok (${STREAK:-indisponível})"
fi

# ── 3. claims vazando de novo? ───────────────────────────────────────────────
LEAK=$(npx tsx scripts/lib/session-registry.ts active-of-kind --kind continuo 2>/dev/null | python3 -c "
import sys, json, datetime as dt
try:
    d = json.load(sys.stdin)
except Exception:
    print(''); raise SystemExit
now = dt.datetime.now(dt.timezone.utc)
for s in d.get('sessions', []):
    claims = s.get('claimed_issues') or []
    hb = s.get('lastHeartbeat')
    if not claims or not hb: continue
    age_min = (now - dt.datetime.fromisoformat(hb.replace('Z', '+00:00'))).total_seconds() / 60
    if age_min > 45:
        print(f\"{s['sessionId']}: claims={claims} heartbeat parado há {age_min:.0f}min\")" 2>/dev/null)
if [ -n "$LEAK" ]; then
  file_issue "[watch-continuo] claims presos" \
    "[watch-continuo] claims do contínuo presos de novo (higiene de fim de tick falhou)" \
    "bug,P2" \
    "Detectado por watch-continuo-health.sh — sessão continuo com claims e heartbeat parado > 45min (tick é de 30min; a higiene da SKILL.md v0.5.0 deveria limpar):

\`\`\`
$LEAK
\`\`\`

Mesma classe do incidente 28/08 (7 issues presas invisíveis pro develop). Workaround: \`session-registry.ts end --kind continuo --session-id <id>\`. Fix estrutural pendente: #6443 (TTL mecânico de claim)."
else
  echo "[watch] claims ok"
fi

# ── 4. vazamento pago ────────────────────────────────────────────────────────
VAZ=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --days 1 --json 2>/dev/null | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
except Exception:
    print(''); raise SystemExit
bad = [r for r in rows if r.get('vazamento_pago')]
for r in bad:
    print(f\"{r['dia']} {r['modelo']} (pedido: {r['pedido']}) est=\${r['custo_estimado']}\")" 2>/dev/null)
if [ -n "$VAZ" ]; then
  file_issue "[watch-continuo] vazamento pago" \
    "[watch-continuo] cobrança em modelo pago fora da allowlist nas últimas 24h" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh via hermes-model-cost-report.py:

\`\`\`
$VAZ
\`\`\`

Mesma classe do incidente 27/08 (USD 0,459 em z-ai/glm-5.2 sem :free via substituição de modelo). Checar overrides de sessão persistidos (\`~/.hermes/sessions/sessions.json\`) e a cadeia em config.yaml. P1: dinheiro saindo em silêncio — o teto diário da chave limita, mas não zera."
else
  echo "[watch] custo ok (sem vazamento pago em 24h)"
fi

# ── 5. adoção da convenção de branch (informational) ─────────────────────────
NOPREFIX=$(gh pr list --state all --limit 30 --json headRefName,createdAt,author --jq '
  [.[] | select(.createdAt > (now - 86400 | todate))
       | select(.author.login == "vjpixel")
       | .headRefName
       | select((startswith("continuo/") or startswith("overnight/") or startswith("develop/") or startswith("dependabot/")) | not)
  ] | join(", ")' 2>/dev/null)
if [ -n "$NOPREFIX" ]; then
  file_issue "[watch-continuo] branch sem prefixo" \
    "[watch-continuo] PRs autônomos das últimas 24h sem prefixo de trilha" \
    "enhancement,P3" \
    "Detectado por watch-continuo-health.sh — branches sem \`continuo/\`/\`overnight/\`/\`develop/\` criados nas últimas 24h: \`$NOPREFIX\`. Se forem do contínuo, a skill v0.5.0 não está seguindo a convenção do #6461 e os PRs aparecem como \`other\` na Triagem. Se forem PRs manuais do editor, fechar como esperado. P3: cosmético/observabilidade, sem impacto funcional."
else
  echo "[watch] convenção de branch ok"
fi

echo "[watch] varredura concluída (falhas de infra: $FAILS)"
exit 0
