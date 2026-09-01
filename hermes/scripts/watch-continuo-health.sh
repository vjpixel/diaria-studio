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
# shellcheck source=./lib/continuo-branch-prefix.sh
source "$REPO/hermes/scripts/lib/continuo-branch-prefix.sh"
FAILS=0

# Dedup: existe issue ABERTA cujo título CONTÉM o marcador?
# Filtro LOCAL de propósito (bug achado no teste ao vivo do PR #6469: a busca
# do GitHub tokeniza/ignora colchetes, então `"[watch-continuo] ..." in:title`
# retornava 0 SEMPRE e o dedup nunca deduplicou — 2 issues idênticas em 10min).
# Falha do gh aqui retorna 2 (indeterminado): quem chama trata como "não sei"
# e NÃO cria (na dúvida, não spammar; a próxima rodada tenta de novo).
have_issue() {
  local marker="$1"
  local titles
  titles=$(gh issue list --state open --limit 100 --json title --jq '.[].title' 2>/dev/null) || return 2
  printf '%s' "$titles" | grep -qF "$marker"
}

file_issue() {
  local marker="$1" title="$2" label="$3" body="$4"
  have_issue "$marker"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "[watch] $marker: issue aberta já existe — sem duplicar"
    return 0
  elif [ $rc -eq 2 ]; then
    echo "[watch] $marker: dedup INDETERMINADO (gh falhou) — não criando pra não duplicar" >&2
    FAILS=$((FAILS + 1))
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
  MTIME=$(stat -c %Y "$MARCO" 2>/dev/null || echo "")
  if [ -z "$MTIME" ]; then
    # arquivo sumiu entre o -f e o stat (sync OneDrive) — indeterminado, nunca "ok"
    echo "[watch] review diário: INDETERMINADO (stat falhou)" >&2; FAILS=$((FAILS+1)); MTIME=0
  fi
  AGE_H=$(( ( $(date +%s) - MTIME ) / 3600 ))
  if [ "$MTIME" -eq 0 ]; then AGE_H=-1; fi
  if [ "$AGE_H" -ge 0 ] && [ "$AGE_H" -gt 26 ]; then
    file_issue "[watch-continuo] review Opus diário não roda" \
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
# Sentinela __ERR__ (finding P1 do review #6469): "não consegui checar" tem
# de ser distinguível de "ok" — a versão anterior colapsava os dois em string
# vazia e um jobs.json corrompido viraria "streak ok" pra sempre.
STREAK=$(python3 -c "
try:
    import json
    found='__ERR__'
    for x in json.load(open('/home/vjpixel/.hermes/cron/jobs.json'))['jobs']:
        if x['id']=='5d791ef6fc2c': found=x.get('failure_streak',0); break
    print(found)
except Exception: print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$STREAK" = "__ERR__" ] || [ -z "$STREAK" ]; then
  echo "[watch] streak: INDETERMINADO (jobs.json ilegível ou job ausente)" >&2; FAILS=$((FAILS+1))
elif [ "$STREAK" -ge 2 ] 2>/dev/null; then
  file_issue "[watch-continuo] Diária Contínuo com failure_streak" \
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
    now = dt.datetime.now(dt.timezone.utc)
    for s in d.get('sessions', []):
        claims = s.get('claimed_issues') or []
        hb = s.get('lastHeartbeat')
        if not claims or not hb: continue
        age_min = (now - dt.datetime.fromisoformat(hb.replace('Z', '+00:00'))).total_seconds() / 60
        if age_min > 45:
            print(f\"{s['sessionId']}: claims={claims} heartbeat parado há {age_min:.0f}min\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$LEAK" = "__ERR__" ]; then
  echo "[watch] claims: INDETERMINADO (registry/parse falhou)" >&2; FAILS=$((FAILS+1)); LEAK=""
fi
if [ -n "$LEAK" ]; then
  file_issue "[watch-continuo] claims do contínuo presos" \
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
    for r in rows:
        if isinstance(r, dict) and r.get('vazamento_pago'):
            # #6880: 'pedido' foi removido (artefato de JOIN com
            # sessions.model, fabricava substituicoes que nunca
            # aconteceram — foi isso que abriu o #6708 como falso P1).
            print(f\"{r['dia']} {r['modelo']} est=\${r['custo_estimado']}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$VAZ" = "__ERR__" ]; then
  echo "[watch] custo: INDETERMINADO (cost-report falhou)" >&2; FAILS=$((FAILS+1)); VAZ=""
fi
if [ -n "$VAZ" ]; then
  file_issue "[watch-continuo] cobrança em modelo pago" \
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
# #6771 (absorve #6709): a checagem original marcava TODA branch das últimas
# 24h sem prefixo autônomo, incluindo sessão interativa do editor — investigado
# ao vivo em #6709: as 7 branches acusadas eram TODAS de sessão interativa
# (#6707, #6675, #6639, #6632, worktree de subagente), nenhuma do contínuo, e
# o alarme disparava TODO DIA pelo mesmo motivo. Falso positivo recorrente
# treina quem lê a ignorar o alarme inteiro — o próprio objetivo do check.
# Fix: aceitar também os prefixos convencionais de sessão interativa/develop
# manual já em uso neste repo, via o filtro compartilhado
# `lib/continuo-branch-prefix.sh` (extraído pra arquivo próprio, não inline,
# porque `continuo-branch-prefix.test.sh` precisa exercitar exatamente o
# mesmo filtro que roda em produção — mesma disciplina de
# `scripts/lib/pr-review-authenticity.ts`, #6732). O check continua pegando
# o caso real que motivou #6461: um PR do contínuo que saiu sem nenhum
# prefixo reconhecido.
if ! NOPREFIX=$(gh pr list --state all --limit 30 --json headRefName,createdAt,author \
     --jq "$CONTINUO_BRANCH_PREFIX_JQ_FILTER" 2>/dev/null); then
  echo "[watch] convenção de branch: INDETERMINADO (gh pr list falhou)" >&2; FAILS=$((FAILS+1)); NOPREFIX=""
fi
if [ -n "$NOPREFIX" ]; then
  file_issue "[watch-continuo] PRs autônomos" \
    "[watch-continuo] PRs autônomos das últimas 24h sem prefixo de trilha" \
    "enhancement,P3" \
    "Detectado por watch-continuo-health.sh — branches sem nenhum prefixo autônomo/interativo reconhecido criados nas últimas 24h: \`$NOPREFIX\` (lista completa dos prefixos aceitos em \`hermes/scripts/lib/continuo-branch-prefix.sh\`, #6771). Se forem do contínuo, a skill v0.5.0 não está seguindo a convenção do #6461 e os PRs aparecem como \`other\` na Triagem. Se forem PRs manuais do editor, fechar como esperado. P3: cosmético/observabilidade, sem impacto funcional."
else
  echo "[watch] convenção de branch ok"
fi

# ── 6. composição de modelo por tick (degradação silenciosa, #6912) ─────────
# Diferente das checagens 1-5 (que só criam issue se degradar), esta SEMPRE
# ecoa a composição no resumo diário — a issue #6912 pede explicitamente
# uma linha de base ANTES de calibrar qualquer limiar de alarme (por isso
# nenhum threshold de "% aceitável de fallback" existe ainda; a mera
# PRESENÇA de uma chamada no fallback local já prova que o primário falhou
# naquele tick, então o gate de issue não precisa de limiar pra ser real).
TICKCOMP=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --tick-composition --days 1 --json 2>/dev/null)
if [ -z "$TICKCOMP" ]; then
  echo "[watch] composição de tick: INDETERMINADO (cost-report --tick-composition falhou)" >&2
  FAILS=$((FAILS + 1))
else
  echo "[watch] composição de tick (últimas 24h):"
  echo "$TICKCOMP" | python3 -c "
import sys, json
try:
    ticks = json.load(sys.stdin)
    if not ticks:
        print('  nenhum tick do continuo nas últimas 24h')
    for t in ticks:
        flag = '  <-- DEGRADADO' if t.get('degraded') else ''
        print(f\"  {t['dia']} {t['session_id']}  primario={t['primary_pct']}%  local={t['local_fallback_pct']}%  pago={t['paid_fallback_pct']}%{flag}\")
except Exception:
    print('  __ERR__ (json malformado)')
"
  DEGRADED=$(printf '%s' "$TICKCOMP" | python3 -c "
import sys, json
try:
    ticks = json.load(sys.stdin)
    bad = [t for t in ticks if t.get('degraded')]
    for t in bad:
        print(f\"{t['dia']} {t['session_id']} local={t['local_fallback_pct']}%\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  if [ "$DEGRADED" = "__ERR__" ]; then
    echo "[watch] composição de tick: parse do resultado falhou" >&2; FAILS=$((FAILS + 1))
  elif [ -n "$DEGRADED" ]; then
    file_issue "[watch-continuo] degradação de modelo por tick" \
      "[watch-continuo] tick(s) do contínuo caíram no fallback local nas últimas 24h" \
      "bug,P2" \
      "Detectado por watch-continuo-health.sh via hermes-model-cost-report.py --tick-composition — tick(s) com chamadas no fallback local (qwen), sinal de que o modelo primário (CONTINUO_PRIMARY_MODEL_IDS, hardcoded em hermes-model-cost-report.py) falhou naquele tick:

\`\`\`
$DEGRADED
\`\`\`

Sem limiar de alarme calibrado ainda (#6912 pede baseline medida antes de decidir o que é aceitável) — esta issue É a coleta da baseline. P2: sintoma 'agente burro hoje' sem custo pago associado (diferente da checagem 4, que é vazamento pago)."
  else
    echo "[watch] composição de tick ok (sem degradação nas últimas 24h)"
  fi
fi

echo "[watch] varredura concluída (checagens indeterminadas/falhas de infra: $FAILS)"
# Exit honesto (finding P2 do review #6469): FAILS>0 = o observador NÃO pôde
# garantir a varredura — o cron do Hermes registra a falha e o failure_streak
# do próprio job de watch vira o alarme de quem vigia o vigilante.
[ "$FAILS" -eq 0 ] || exit 1
exit 0
