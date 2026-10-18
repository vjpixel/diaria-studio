#!/usr/bin/env bash
# scripts/dispatch-glm-lane-unit.sh (#6930) — LÁPIDE desde o #10431
#
# Despachava UMA unidade do piloto da lane #6930 (modelo pago de gateway:
# `z-ai/glm-5.3-flash`, depois `deepseek/deepseek-v4-flash` no #10367).
#
# A lane foi ENCERRADA no #10387 (18/10/2026, decisão do editor: "não estou
# mais usando modelos pagos no OpenRouter"). O #10387 pôs um `exit 3`
# incondicional no topo e deixou o corpo como histórico; o #10431 removeu
# esse corpo morto junto com o harness que só ele consumia
# (`check-glm-lane-gate.ts`, `lib/glm-lane-gate.ts`, `record-glm-lane-unit.ts`,
# `lib/glm-lane-headref-guard.sh`). O código completo do piloto está no
# histórico do git; condições, critérios de morte e medições estão em
# `docs/lane-glm.md`.
#
# O arquivo continua existindo só pra que `npm run glm-lane-dispatch` (ou um
# atalho antigo) falhe ALTO, com o motivo, em vez de "arquivo não encontrado".
# `hermes/scripts/claude-delegate.sh` também recusa `--model` pago (exit 2),
# então reabrir a lane exige nova decisão do editor revertendo o #10387 —
# nunca restaurar só este script.
set -euo pipefail

echo "ERRO: lane de piloto do #6930 encerrada no #10387 — sem modelo pago do OpenRouter. Ver docs/lane-glm.md." >&2
exit 3
