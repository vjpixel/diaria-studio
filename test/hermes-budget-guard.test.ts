/**
 * test/hermes-budget-guard.test.ts (#6666)
 *
 * Guard de regressao contra o bug descrito na #6666: o wrapper
 * `claude-openrouter.sh` usava `BUDGET="0.25"`, mas o CLAUDE.md tem 76KB
 * (~19k tokens de entrada), e o CLI rastreia o custo de carregar o contexto
 * contra `--max-budget-usd`. A chamada com CLAUDE.md carregado ja excede
 * $0.25 no primeiro request, e o erro "Exceeded USD budget" vai pro STDOUT
 * (nao stderr), entao o classify-grep de stderr nunca o via — a cadeia
 * falha silenciosamente com rc=1 e stderr vazio.
 *
 * Este teste lê o wrapper e confirma:
 *   1. BUDGET >= 2.0 (folga para CLAUDE.md ~19k tokens a ~$15/M input)
 *   2. O classification loop cobre "exceeded.*budget" no ATTEMPT_LOG
 *   3. O stdout e capturado no ATTEMPT_LOG no RC!=0 (para budget errors
 *      serem visiveis)
 *
 * Nao executa o CLI (test de parsing estatico).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

describe("guard de budget do wrapper (#6666)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("BUDGET default e >= 2.0 (folga para CLAUDE.md ~19k tokens)", () => {
    const m = source.match(/^BUDGET="([^"]+)"/m);
    assert.ok(m, `BUDGET="..." nao encontrado em ${WRAPPER_PATH}`);
    const budget = parseFloat(m![1]);
    assert.ok(
      budget >= 2.0,
      `BUDGET=${budget} e menor que 2.0 — CLAUDE.md (~19k tokens de entrada a ~$15/M) ja excede $0.25 no primeiro request, e o erro "Exceeded USD budget" vai pro STDOUT (nao stderr), entao o classify-grep de stderr nunca o ve (#6666)`,
    );
  });

  it("o loop de classificacao cobre 'exceeded.*budget' no ATTEMPT_LOG", () => {
    // Procura pelo elif que detecta budget-exceeded, exatamente como o
    // #6617 fez com os patternos de rate-limit/config-error.
    const budgetPattern = /elif grep -qiE "exceeded\.budget|budget\.exceeded|too expensive|cost\.exceed" "\$ATTEMPT_LOG"/;
    assert.ok(
      budgetPattern.test(source),
      "o elif de classificacao do budget-exceeded nao esta presente no wrapper — sem isso, 'Exceeded USD budget' (que vai pro STDOUT) e classificado como 'sem sinal claro' e a cadeia falha silenciosamente (#6666)",
    );
  });

  it("o stdout e capturado no ATTEMPT_LOG no RC!=0 (para budget errors serem visiveis)", () => {
    // A ordem correta: echo "$OUT" >> "$ATTEMPT_LOG" ANTES do classify-grep.
    // Procura pelo padrao exato: echo "$OUT" >> "$ATTEMPT_LOG"
    assert.ok(
      /echo "\$OUT" >> "\$ATTEMPT_LOG"/.test(source),
      "stdout nao e capturado no ATTEMPT_LOG — sem isso, erros do CLI que vai pro STDOUT (como 'Exceeded USD budget') nunca sao vistos pelo classify-grep de stderr (#6666)",
    );
  });

  it("o classify-grep roda sobre o ATTEMPT_LOG completo (stdout + stderr combinados)", () => {
    // O ATTEMPT_LOG deve conter tanto stderr (redirecionado 2>) quanto stdout
    // (echo "$OUT" >>) antes dos greps de classificacao. Verifica que o
    // echo "$OUT" >> "$ATTEMPT_LOG" vem ANTES do primeiro elif grep.
    const stdoutCapture = source.indexOf('echo "$OUT" >> "$ATTEMPT_LOG"');
    const firstClassifyGrep = source.indexOf('grep -qiE "model not found');
    assert.ok(
      stdoutCapture > -1 && firstClassifyGrep > -1,
      "padroes de busca nao encontrados no wrapper",
    );
    assert.ok(
      stdoutCapture < firstClassifyGrep,
      `echo "$OUT" >> "$ATTEMPT_LOG" (pos ${stdoutCapture}) deve vir ANTES do primeiro classify-grep (pos ${firstClassifyGrep}) — o stdout com o erro do CLI precisa estar no ATTEMPT_LOG antes de ser classificado (#6666)`,
    );
  });
});