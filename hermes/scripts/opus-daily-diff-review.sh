#!/usr/bin/env bash
# opus-daily-diff-review.sh (renomeado de daily-consolidated-review.sh, #6865)
# — review Opus (assinatura claude.ai) do diff ACUMULADO do dia no
# diaria-studio, 1x/dia.
#
# Racional (28/08/2026, decisão do editor): o hermes-diaria-continuo implementa
# e mergeia PRs com modelos free do OpenRouter (gate leve por PR). A qualidade
# Anthropic entra AQUI, no atacado: 1 sessão/dia sobre o diff consolidado
# (~25 PRs/dia) em vez de 25 sessões — o overhead fixo por sessão (CLAUDE.md,
# contexto) é pago 1x, e o review enxerga interações ENTRE PRs (ex: PR
# supersedido por outro do mesmo dia — caso real #6238, 26/08).
#
# #6865 (31/08/2026): renomeado de `daily-consolidated-review.sh`. O papel
# deste script (varredura consolidada do diff acumulado, 1x/dia, Opus) NÃO
# mudou — o que mudou é que ele passou a ter um IRMÃO,
# `continuo-pr-review.sh` (Sonnet, ~4h, review de PR individual do
# contínuo) — com dois scripts de review no diretório, "daily-consolidated-
# review" sozinho passou a ler como "o único review que existe", o que
# deixou de ser verdade. Cadência e modelo deste script são os MESMOS de
# antes — só o nome ficou mais específico. **Requer ação manual fora deste
# repo** (não executada por esta PR — ver `hermes/README.md`): recriar o
# symlink `~/.hermes/scripts/opus-daily-diff-review.sh` e rodar `hermes cron
# edit 645d5debb7f0 --script opus-daily-diff-review.sh` — sem isso, o job
# `645d5debb7f0` (agendado, `Script: daily-consolidated-review.sh`) aponta
# pra um symlink que não existe mais até o passo manual rodar.
#
# AUTH: assinatura claude.ai (OAuth), DE PROPÓSITO — este script NÃO seta
# ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY nenhum (#5608: sessão de Claude Code
# autentica pela assinatura; e é o Opus que queremos aqui). Não confundir com
# claude-openrouter.sh, que faz o oposto.
#
# Estado: data/continuo/last-daily-review-sha (avança SÓ após review completo).
set -euo pipefail

REPO="/home/vjpixel/diaria-studio"
STATE_DIR="$REPO/data/continuo"
STATE_FILE="$STATE_DIR/last-daily-review-sha"
MAX_DIFF_LINES=20000

# shellcheck source=./lib/daily-review-coverage.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/daily-review-coverage.sh"

cd "$REPO"
git fetch origin -q
HEAD_SHA=$(git rev-parse origin/master)
mkdir -p "$STATE_DIR"

if [ -f "$STATE_FILE" ]; then
  BASE_SHA=$(cat "$STATE_FILE")
  if ! git cat-file -e "$BASE_SHA" 2>/dev/null; then
    # Fallback NUNCA silencioso (finding P1 do review do PR #6446): marco
    # inválido = janela arbitrária de 20 commits, que pode PULAR dias de
    # história ou re-revisar — o operador precisa saber que degradou.
    echo "[daily-review] AVISO: marco salvo ($BASE_SHA) não existe mais no repo (state corrompido ou history rewrite) — degradando para origin/master~20; a cobertura desta rodada é aproximada" >&2
    BASE_SHA=$(git rev-parse "origin/master~20")
  fi
else
  # Primeira execução: só o último dia de commits, nunca o histórico inteiro.
  BASE_SHA=$(git log origin/master --since="24 hours ago" --format=%H | tail -1)
  [ -n "$BASE_SHA" ] && BASE_SHA=$(git rev-parse "$BASE_SHA~1" 2>/dev/null || echo "$BASE_SHA")
fi

if [ -z "${BASE_SHA:-}" ] || [ "$BASE_SHA" = "$HEAD_SHA" ]; then
  echo "[daily-review] nada novo desde o último review ($HEAD_SHA) — noop"
  exit 0
fi

NLINES=$(git diff --stat "$BASE_SHA..$HEAD_SHA" | tail -1)
echo "[daily-review] range $BASE_SHA..$HEAD_SHA ($NLINES)"

DIFF_LINES=$(git diff "$BASE_SHA..$HEAD_SHA" | wc -l)
RANGE_NOTE=""
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
  RANGE_NOTE="ATENÇÃO: diff tem $DIFF_LINES linhas (> $MAX_DIFF_LINES). Priorize arquivos de scripts/lib/, publishers e hooks; arquivos de teste e docs só se algo neles parecer errado."
  # #6757: degradação de cobertura não pode passar calada — mesmo padrão dos
  # outros dois AVISOs deste script (marco inválido, sed cosmético).
  echo "[daily-review] AVISO: cobertura degradada — diff de $DIFF_LINES linhas excede o teto de $MAX_DIFF_LINES; priorizando scripts/lib/, publishers e hooks (ver RESUMO-DAILY-REVIEW no output para o campo cobertura=)" >&2
fi

# #6757: campo de cobertura do resumo — computado AQUI (determinístico), não
# pelo modelo, pra nunca divergir do teto real; o prompt abaixo instrui o
# Opus a copiar este valor literal, não recalcular.
COVERAGE_FIELD=$(daily_review_coverage_field "$DIFF_LINES" "$MAX_DIFF_LINES")

PROMPT="Você é o review consolidado diário do diaria-studio. Revise o diff acumulado \`git diff $BASE_SHA..$HEAD_SHA\` (commits: \`git log --oneline $BASE_SHA..$HEAD_SHA\`), mergeado em sua maior parte por modelos não-Anthropic via fila autônoma — seu papel é pegar o que o gate leve por PR deixou passar.

$RANGE_NOTE

Procure, nesta ordem de prioridade:
1. Bugs de correção (lógica errada, edge case quebrado, regressão de comportamento).
2. Interações ENTRE mudanças do range (dois PRs que se pisam; fix supersedido; mesma constante alterada 2x de formas incompatíveis).
3. Violações das regras do CLAUDE.md (ex: bugfix sem teste de regressão #633, edição não-cirúrgica #495, custo recorrente novo).
4. Falhas silenciosas (catch vazio, fallback que mascara erro).

Para CADA finding com confiança alta ou média: crie uma issue via \`gh issue create\` com label de tipo (bug/enhancement) + prioridade P0-P3 justificada no corpo (regra do CLAUDE.md: nunca perguntar, sempre criar com prioridade), corpo citando arquivo:linha e o commit do range. Prefixe o título com [daily-review]. Antes de criar, cheque \`gh issue list --search\` para não duplicar issue aberta equivalente.

Além do commit, resolva a ORIGEM do defeito até a PR e a trilha de execução (#6756): rode \`gh pr list --search <sha> --state all --json number,headRefName\` (o sha é o commit citado no finding) para achar a PR que o introduziu, e derive a trilha do prefixo de \`headRefName\` (\`continuo/\`→continuo, \`overnight/\`→overnight, \`develop/\`→develop, qualquer outro prefixo→other). Inclua no corpo da issue, em linha própria, o marcador HTML invisível (mesmo padrão do \`<!-- aguardando-ate: -->\` que \`classifyExecTrack\` já consome — não aparece na renderização, é feito pra ser parseado):
<!-- origem: pr=<numero> trilha=<continuo|overnight|develop|other> commit=<sha> -->
Se a PR não for encontrada (\`gh pr list --search\` vazio), use \`pr=desconhecida trilha=desconhecida\` em vez de adivinhar.

Se nada de confiança alta/média: não crie issue nenhuma.

OBRIGATÓRIO ao final, como ÚLTIMA linha da sua resposta, o marcador literal (o script só avança o marco de review se ela existir) — copie o campo cobertura EXATAMENTE como fornecido abaixo, não recalcule:
RESUMO-DAILY-REVIEW: commits=<N> findings=<M> issues_criadas=<links ou nenhuma> issues_falharam=<K> $COVERAGE_FIELD
Se alguma chamada de gh issue create FALHOU, conte em issues_falharam e liste o finding perdido no corpo do resumo — nunca omita falha de tool."

# Finding P1 do review do PR #6446: exit 0 do claude -p NÃO prova review
# completo (pode parar cedo, gh pode falhar sem propagar rc). O marco só
# avança se o marcador de resumo existir no output capturado. timeout de 90min
# cobre o P2 de stall indefinido (CLAUDE.md: stall silencioso é inaceitável).
OUT_FILE="$STATE_DIR/last-daily-review-output.txt"
echo "$PROMPT" | timeout 5400 claude -p \
  --allowedTools "Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(gh issue create:*),Bash(gh issue list:*),Bash(gh pr list:*)" \
  --model opus --effort low | tee "$OUT_FILE"

if ! grep -q "RESUMO-DAILY-REVIEW:" "$OUT_FILE"; then
  echo "[daily-review] ERRO: output não contém o marcador RESUMO-DAILY-REVIEW — review possivelmente incompleto; marco NÃO avançado (transcript em $OUT_FILE)" >&2
  exit 4
fi

# Cosmético: separa os links do resumo com espaço, pra clientes que autolinkam
# (Telegram) não grudarem URL na vírgula/no `=` e gerarem link quebrado.
#
# ESCOPADO à linha do resumo (`/RESUMO-DAILY-REVIEW:/{...}`). O OUT_FILE é o
# transcript INTEIRO do Opus, e sem o endereço a substituição reescreveria
# qualquer `,https://` em prosa ou código citado no corpo do review — mutação
# silenciosa de conteúdo que ninguém pediu (achado do review da PR #6738).
#
# O degrade é fail-soft POR DESIGN, mas não silencioso: o script roda sob
# `set -euo pipefail`, então sem o `||` uma falha deste sed (arquivo
# read-only, disco cheio) abortaria ANTES de `echo "$HEAD_SHA" >
# "$STATE_FILE"` — o marco não avançaria, e o review Opus daquele dia, já
# pago e concluído, seria refeito sobre o mesmo range no dia seguinte.
# Formatação nunca deve custar um review inteiro. O AVISO em stderr segue o
# mesmo padrão do fallback de BASE_SHA inválido mais acima neste script.
#
# Roda DEPOIS do gate `grep -q RESUMO-DAILY-REVIEW`, então não pode mascarar
# review incompleto. Nenhum consumidor parseia `issues_criadas=`
# programaticamente (só este grep, que é anterior) — verificado em 29/08/2026.
sed -i '/RESUMO-DAILY-REVIEW:/{s|,\(https\?://\)|, \1|g; s|issues_criadas=\(https\?://\)|issues_criadas= \1|g}' "$OUT_FILE" || echo "[daily-review] AVISO: formatação de links do resumo falhou — cosmético, marco segue avançando" >&2

# Marco avança só depois do review completar sem erro (set -e garante).
echo "$HEAD_SHA" > "$STATE_FILE"
echo "[daily-review] concluído — marco avançado para $HEAD_SHA"
