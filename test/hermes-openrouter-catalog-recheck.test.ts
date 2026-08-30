/**
 * test/hermes-openrouter-catalog-recheck.test.ts (#6803)
 *
 * Guard de regressão: `hermes/scripts/claude-openrouter.sh` não pode mais
 * classificar "model not found"/"invalid model" no stderr como config
 * PERMANENTE (SAW_CONFIG_ERROR_SIGNAL, exit 4) sem antes reconsultar o
 * catálogo público do OpenRouter (`GET /api/v1/models`, sem auth).
 *
 * Medido ao vivo em 30/08/2026: `z-ai/glm-5.2:free` disparou o sinal de
 * "model not found" em 28/08 (exit 4 — "config inválida, não volta
 * sozinha") e voltou a existir no catálogo 2 dias depois — a ausência era
 * TRANSITÓRIA, não permanente. O exit 4 daquele dia teria parado o job
 * pedindo correção manual de uma config que não estava quebrada.
 *
 * Teste de parsing estático (não faz request de rede — mesma técnica de
 * test/hermes-openrouter-error-classification.test.ts e
 * test/hermes-budget-guard.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

describe("reconsulta de catálogo antes do exit 4 de config-inválida (#6803)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("existe uma função que consulta GET /api/v1/models do OpenRouter", () => {
    assert.ok(
      /model_in_openrouter_catalog\s*\(\)\s*\{/.test(source),
      "função de reconsulta do catálogo não encontrada — sem ela, o exit 4 não distingue " +
        "ausência TRANSITÓRIA (indisponibilidade momentânea) de ausência PERMANENTE (id " +
        "removido de verdade), #6803.",
    );
    assert.ok(
      source.includes("https://openrouter.ai/api/v1/models"),
      "a função de reconsulta precisa chamar o endpoint público de catálogo do OpenRouter",
    );
  });

  it("o elif de 'model not found' reconsulta o catálogo ANTES de setar SAW_CONFIG_ERROR_SIGNAL", () => {
    const modelNotFoundIdx = source.indexOf(
      'elif grep -qiE "model not found|invalid model|not a valid model|no endpoints found|no allowed providers" "$STDERR_ONLY_LOG"; then',
    );
    assert.ok(modelNotFoundIdx > -1, "elif de config-inválida (model not found) não encontrado");

    const nextElifIdx = source.indexOf("elif grep -qiE", modelNotFoundIdx + 1);
    assert.ok(nextElifIdx > modelNotFoundIdx, "próximo elif (rate-limit) não encontrado");
    const branch = source.slice(modelNotFoundIdx, nextElifIdx);

    assert.ok(
      /if model_in_openrouter_catalog "\$MODEL"; then/.test(branch),
      "o branch de 'model not found' não reconsulta o catálogo antes de decidir — sem " +
        "isso, toda ausência (transitória ou permanente) vira exit 4 direto (#6803).",
    );

    // O caminho "modelo AINDA está no catálogo" deve setar SAW_QUOTA_SIGNAL
    // (transitório), não SAW_CONFIG_ERROR_SIGNAL (permanente).
    const ifIdx = branch.indexOf('if model_in_openrouter_catalog "$MODEL"; then');
    const elseIdx = branch.indexOf("else", ifIdx);
    const fiIdx = branch.indexOf("fi", elseIdx);
    assert.ok(ifIdx > -1 && elseIdx > ifIdx && fiIdx > elseIdx, "estrutura if/else/fi não encontrada no branch");

    const presentBranch = branch.slice(ifIdx, elseIdx);
    const absentBranch = branch.slice(elseIdx, fiIdx);

    assert.ok(
      /SAW_QUOTA_SIGNAL=1/.test(presentBranch) && !/SAW_CONFIG_ERROR_SIGNAL=1/.test(presentBranch),
      "quando o modelo AINDA está no catálogo, deve setar SAW_QUOTA_SIGNAL (transitório), " +
        "não SAW_CONFIG_ERROR_SIGNAL — senão a reconsulta não muda o veredito (#6803).",
    );
    assert.ok(
      /SAW_CONFIG_ERROR_SIGNAL=1/.test(absentBranch),
      "quando o modelo está CONFIRMADO ausente do catálogo (ou o catálogo está " +
        "inacessível), deve continuar setando SAW_CONFIG_ERROR_SIGNAL — não dá pra " +
        "provar que o id existe só porque a rede falhou, então o comportamento " +
        "conservador anterior (exit 4) precisa ser preservado nesse caso.",
    );
  });

  it("a função de catálogo trata falha de rede como 'não confirmado' (return != 0), nunca como sucesso silencioso", () => {
    const fnIdx = source.indexOf("model_in_openrouter_catalog() {");
    assert.ok(fnIdx > -1, "função não encontrada");
    const fnEndIdx = source.indexOf("\n}", fnIdx);
    const fn = source.slice(fnIdx, fnEndIdx);
    assert.ok(
      /curl -sf/.test(fn),
      "a função precisa usar `curl -sf` (falha silenciosa em HTTP não-2xx, sem imprimir body de erro no meio do stdout capturado)",
    );
    assert.ok(
      /return 2/.test(fn),
      "a função precisa retornar um código de falha explícito quando o curl falhar (rede indisponível/timeout) " +
        "— sem isso, uma falha de rede na reconsulta poderia ser lida como 'modelo ausente' " +
        "silenciosamente, incluindo o cenário oposto ao pretendido.",
    );
  });
});
