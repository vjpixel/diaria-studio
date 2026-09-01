#!/usr/bin/env bash
# test/hermes-continuo-tick-continuation-6917.test.sh
#
# Guard de regressão pro #6917 — um tick com 36 issues `track=overnight`
# elegíveis terminou sem reivindicar nenhuma, justificando com "regra de
# prioridade da fila" que NUNCA existiu no SKILL.md. Causa raiz: a instrução
# real ("passar para a próxima issue/PR da fila") era 8 palavras sem negrito,
# em oração subordinada, no fim de 25 linhas cujo peso retórico inteiro
# estava em "NÃO mergear" — o tick preencheu o vazio de ênfase com uma regra
# plausível.
#
# Extrai o bloco literal do §3 (via awk, mesma disciplina do #6885/#6891/
# #6859 — um teste que só confirma "a string existe em algum lugar do
# arquivo" passaria mesmo com a frase no lugar ERRADO, ex: fora deste
# parágrafo, sem a ênfase certa) e verifica ESTRUTURALMENTE que a
# continuação do tick tem estatuto de afirmação própria (negrito, frase
# dedicada) e nega explicitamente a regra fabricada — não só que a frase
# "existe em algum lugar". Travar texto de prompt é teste fraco em geral,
# mas aqui o texto É o mecanismo (#6917).
#
# Uso: bash test/hermes-continuo-tick-continuation-6917.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$DIR/../hermes/skills/hermes-diaria-continuo/SKILL.md"

FAILED=0
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle]"; FAILED=1 ;;
  esac
}
assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "FAIL: $desc — NÃO devia conter [$needle]"; FAILED=1 ;;
    *) echo "ok: $desc" ;;
  esac
}

# ── Extração do bloco §3 real, via awk ──────────────────────────────────────
# Marca de início: a linha que introduz o rótulo do gate de autenticidade.
# Marca de fim: a próxima seção ("Pickup existe desde o #6823"). Se os
# marcadores sumirem (SKILL.md reestruturado), este teste falha alto — não
# silenciosamente vira no-op.
#
# Achado do review (#6917/#6919, P2): `awk '/inicio/,/fim/'` só falha alto se
# o marcador de INÍCIO sumir (padrão vazio detectado abaixo). Se o marcador
# de FIM sumir/mudar, o range NUNCA fecha e o awk estende silenciosamente até
# EOF — verificado empiricamente. Isso degradaria de volta pro exato teste
# fraco ("a frase existe em algum lugar do arquivo") que este arquivo existe
# pra evitar. Guard: checar os DOIS marcadores via grep -qF ANTES do awk, e
# confirmar que a ÚLTIMA linha do bloco extraído de fato contém o marcador de
# fim (prova que o range fechou onde devia, não que rodou até EOF por acaso).
if ! grep -qF "ROTULO informativo no relatório do tick" "$SKILL"; then
  echo "FAIL: marcador de INÍCIO não encontrado em $SKILL (SKILL.md reestruturado?)"
  exit 1
fi
if ! grep -qF "Pickup existe desde o #6823" "$SKILL"; then
  echo "FAIL: marcador de FIM não encontrado em $SKILL — sem ele, awk '/inicio/,/fim/' " \
    "estenderia o bloco silenciosamente até EOF (achado do review #6919)"
  exit 1
fi

BLOCK_RAW=$(awk '/ROTULO informativo no relatório do tick/,/Pickup existe desde o #6823/' "$SKILL")

if [ -z "$BLOCK_RAW" ]; then
  echo "FAIL: não conseguiu extrair o bloco do §3 de $SKILL (marcadores mudaram?)"
  exit 1
fi

LAST_LINE=$(echo "$BLOCK_RAW" | tail -1)
case "$LAST_LINE" in
  *"Pickup existe desde o #6823"*) ;;
  *)
    echo "FAIL: a última linha extraída não contém o marcador de fim — o range awk pode ter " \
      "vazado até EOF em vez de fechar no lugar certo (última linha: [$LAST_LINE])"
    exit 1
    ;;
esac

# Markdown quebra linha em ~72-80 col — normaliza pra 1 linha (colapsa
# whitespace) antes de casar frases que atravessam quebra de linha no
# arquivo, sem perder a checagem estrutural (a ordem/adjacência das
# palavras continua exigida, só a formatação de linha deixa de importar).
BLOCK=$(echo "$BLOCK_RAW" | tr '\n' ' ' | tr -s ' ')

# ── Estrutura ────────────────────────────────────────────────────────────

assert_contains \
  "proibição de merge continua presente (não removida pelo conserto)" \
  "$BLOCK" '**NÃO mergear.**'

assert_contains \
  "continuação do tick é AFIRMAÇÃO PRÓPRIA em negrito — não cauda de frase" \
  "$BLOCK" '**PR aberta NUNCA encerra o tick'

assert_contains \
  "nega EXPLICITAMENTE a regra fabricada pelo incidente real (#6917)" \
  "$BLOCK" 'não existe regra que limite o contínuo a uma PR por vez'

assert_contains \
  "cita o incidente real que motivou o conserto (evidência, não só a regra)" \
  "$BLOCK" 'regra de prioridade da fila'

assert_contains \
  "instrui explicitamente a trabalhar a fila mesmo com PR aberta aguardando review" \
  "$BLOCK" 'o tick trabalha'

# A frase de continuação não pode ser meramente uma oração subordinada presa
# à frase de proibição — checa que ela abre sua PRÓPRIA sentença em negrito
# (não "...passar para a próxima issue/PR da fila." sem estatuto próprio).
assert_not_contains \
  "a frase antiga (proibição+continuação na MESMA sentença, sem negrito na continuação) não sobrevive" \
  "$BLOCK" 'NÃO mergear** — deixar o'

# ── Cabeçalho do §3 (achado P1 do review #6919) ─────────────────────────────
# O cabeçalho da seção 3 dizia LITERALMENTE "nenhuma issue nova é
# reivindicada" enquanto PR estivesse pendente — a MESMA regra fabricada que
# o tick citou (já que #6864 faz "PR pendente de merge" ser quase sempre
# verdade). Corrigir só o corpo do parágrafo e deixar o CABEÇALHO
# contradizendo é insuficiente — o header extraído separadamente porque ele
# vem ANTES do marcador de início usado acima.
HEADER_RAW=$(awk '/### 3\. Fila de PRs abertos PRIMEIRO/,/^ordem:$/' "$SKILL")
HEADER=$(echo "$HEADER_RAW" | tr '\n' ' ' | tr -s ' ')

# Nota: a frase fabricada "nenhuma issue nova é reivindicada" É CITADA no
# corpo da correção (mesmo princípio de nomear-e-negar do #6849/#6917) — não
# checa AUSÊNCIA da string, checa que ela aparece só como CITAÇÃO qualificada
# ("dizia"), nunca como afirmação viva do título da seção.
assert_not_contains \
  "cabeçalho do §3 NÃO afirma mais 'nenhuma issue nova é reivindicada' como REGRA VIVA no título (só como citação qualificada no corpo)" \
  "$(echo "$HEADER" | head -c 90)" 'nenhuma issue nova é reivindicada'

assert_contains \
  "cabeçalho do §3 nomeia e corrige explicitamente a leitura fabricada (não só remove a frase em silêncio)" \
  "$HEADER" 'não bloqueia reivindicar'

assert_contains \
  "correção do cabeçalho cita a frase fabricada explicitamente (nomear, não só negar em abstrato)" \
  "$HEADER" 'dizia "nenhuma issue nova é reivindicada"'

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
