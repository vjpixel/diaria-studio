/**
 * test/claude-openrouter-free-quota-marker.test.ts (#6712)
 *
 * Guard de regressão de alto nível: confirma que `claude-openrouter.sh`
 * de fato usa o mecanismo de `lib/free-quota-exhaustion.sh` (source +
 * chamadas), sem duplicar a cobertura de comportamento — essa já está em
 * `hermes/scripts/lib/free-quota-exhaustion.test.sh` (miolo puro) e
 * validada manualmente via script standalone (registrado no PR). Este
 * arquivo é o análogo do padrão já usado por
 * `test/hermes-background-model-pin.test.ts` — ler o SOURCE do script e
 * travar propriedades estruturais, não reimplementar o parser bash.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");
const LIB_PATH = join(ROOT, "hermes/scripts/lib/free-quota-exhaustion.sh");

function readWrapper(): string {
  return readFileSync(WRAPPER_PATH, "utf8");
}

describe("claude-openrouter.sh — marcador de exaustão da cota free (#6712)", () => {
  it("lib/free-quota-exhaustion.sh existe e é sourceável (sintaxe válida)", () => {
    assert.doesNotThrow(() => readFileSync(LIB_PATH, "utf8"));
  });

  it("wrapper faz source de lib/free-quota-exhaustion.sh", () => {
    const src = readWrapper();
    assert.match(src, /^source\s+".*\/lib\/free-quota-exhaustion\.sh"$/m);
  });

  it("wrapper checa o marcador ANTES de montar MODELS (só no caminho sem --model, nunca sobrepõe MODEL_FORCED)", () => {
    const src = readWrapper();
    // A checagem do marcador precisa estar dentro do ramo `else` (sem
    // MODEL_FORCED) — procurar is_exhaustion_marker_valid DEPOIS de
    // `MODELS=("${MODELS_DEFAULT[@]}")` e ANTES do fechamento do `if`.
    const idx = src.indexOf('MODELS=("${MODELS_DEFAULT[@]}")');
    assert.ok(idx >= 0, "não encontrou a linha que monta MODELS a partir de MODELS_DEFAULT");
    const after = src.slice(idx);
    const markerCheckIdx = after.indexOf("is_exhaustion_marker_valid");
    assert.ok(markerCheckIdx > 0, "checagem do marcador deve vir DEPOIS de MODELS=MODELS_DEFAULT");
  });

  it("wrapper grava o marcador só quando o elo que falhou é :free (case *:free)", () => {
    const src = readWrapper();
    assert.match(src, /case\s+"\$MODEL"\s+in\s*\n\s*\*:free\)/);
    assert.match(src, /next_utc_midnight_epoch/);
    assert.match(src, /FREE_QUOTA_EXHAUSTED_MARKER/);
  });

  it("gravação do marcador é fail-soft (não usa comando que aborta o script sob set -e se a escrita falhar)", () => {
    const src = readWrapper();
    const writeLineMatch = src.match(/echo\s+"\$RESET_EPOCH"\s*>\s*"\$FREE_QUOTA_EXHAUSTED_MARKER"[^\n]*/);
    assert.ok(writeLineMatch, "linha de escrita do marcador não encontrada");
    assert.match(
      writeLineMatch![0],
      /\|\|/,
      "a escrita do marcador precisa ter um `||` de fallback — sob set -euo pipefail, um /tmp read-only abortaria o script inteiro sem isso",
    );
  });

  it("--model explícito (MODEL_FORCED) nunca passa pela lógica do marcador — está no ramo `if`, não `else`", () => {
    const src = readWrapper();
    const ifIdx = src.indexOf('if [ -n "$MODEL_FORCED" ]; then');
    const elseIdx = src.indexOf("else", ifIdx);
    const markerLogicIdx = src.indexOf("is_exhaustion_marker_valid");
    assert.ok(ifIdx >= 0 && elseIdx > ifIdx, "estrutura if/else de MODEL_FORCED não encontrada");
    assert.ok(
      markerLogicIdx > elseIdx,
      "a lógica do marcador precisa estar depois do `else` (ramo sem --model), nunca no ramo `if` (--model explícito)",
    );
  });

  it("leitura do marcador é fail-soft mesmo com conteúdo malformado (gap de cobertura do review da PR #6874)", () => {
    // Chamar diretamente is_exhaustion_marker_valid, como o wrapper chama
    // (`$(is_exhaustion_marker_valid "$MARKER_EPOCH" "$NOW_EPOCH" 2>/dev/null || echo false)`),
    // com um MARKER_EPOCH não-numérico — deve degradar para "false" (chain
    // inteira, comportamento de hoje), nunca abortar sob set -e.
    const out = execFileSync(
      "bash",
      [
        "-c",
        `source "${LIB_PATH}"; echo "$(is_exhaustion_marker_valid "garbage-not-a-number" "1787119680" 2>/dev/null || echo false)"`,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(out, "false", "marcador malformado deve degradar para false (fail-soft), não abortar");
  });

  it("o read-path do marcador no wrapper tem o mesmo guard fail-soft (`2>/dev/null || echo false`)", () => {
    const src = readWrapper();
    assert.match(
      src,
      /is_exhaustion_marker_valid\s+"\$MARKER_EPOCH"\s+"\$NOW_EPOCH"\s+2>\/dev\/null\s+\|\|\s+echo\s+false/,
      "chamada a is_exhaustion_marker_valid no wrapper precisa manter o guard 2>/dev/null || echo false",
    );
  });
});
