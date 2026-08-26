/**
 * test/pr-checks-gate.test.ts (#6225)
 *
 * Cobre `scripts/lib/pr-checks-gate.ts` — a lógica pura da condição 1 do
 * gate de merge autônomo. O I/O (`gh pr view`) fica no entrypoint
 * `scripts/check-pr-checks-gate.ts`, testado aqui só via a função pura que
 * ele orquestra (mesmo padrão de `test/trade-off-label-gate.test.ts` pro
 * gate irmão).
 *
 * O caso que mais importa (regressão #6225): um payload malformado —
 * `statusCheckRollup` ausente, não-array, `null`, etc — que representa
 * "o comando/parse falhou" **nunca** pode produzir `verdict: "pass"`. É
 * exatamente esse modo de falha (comando quebrado lido como "0 checks
 * reprovados") que causou o achado original com `gh pr checks --json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrChecksGate, isPrChecksGateGreen, type PrCheckNode } from "../scripts/lib/pr-checks-gate.ts";

function check(name: string, status: string, conclusion: string | null): PrCheckNode {
  return { name, status, conclusion };
}

describe("evaluatePrChecksGate — regressão #6225: erro nunca vira pass", () => {
  it("statusCheckRollup undefined (payload sem o campo) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate(undefined);
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup null => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate(null);
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup não é array (string, JSON parcial/garbled) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate("unknown flag: --json");
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup é um objeto (não array) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate({ bucket: "pass" });
    assert.equal(result.verdict, "error");
  });
});

describe("evaluatePrChecksGate — array vazio é 'pending', não 'pass' por ausência", () => {
  it("nenhum check registrado ainda => 'pending' (não é aprovação por vazio)", () => {
    const result = evaluatePrChecksGate([]);
    assert.equal(result.verdict, "pending");
    assert.equal(isPrChecksGateGreen(result), false);
  });
});

describe("evaluatePrChecksGate — caminho feliz", () => {
  it("todos os checks COMPLETED + SUCCESS => 'pass'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("lint", "COMPLETED", "SUCCESS"),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(isPrChecksGateGreen(result), true);
    assert.deepEqual(result.failingChecks, []);
    assert.deepEqual(result.pendingChecks, []);
  });

  it("mistura de SUCCESS/NEUTRAL/SKIPPED, todos COMPLETED => 'pass'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("codeql", "COMPLETED", "NEUTRAL"),
      check("optional-job", "COMPLETED", "SKIPPED"),
    ]);
    assert.equal(result.verdict, "pass");
  });
});

describe("evaluatePrChecksGate — check em andamento (o guard que a issue pede explicitamente)", () => {
  it("check COMPLETED com conclusion null nunca aparece isolado — mas status != COMPLETED com conclusion null => 'pending', não 'fail'", () => {
    // Check em andamento: status ainda não é COMPLETED, conclusion ainda não existe.
    // Contar isso como 'fail' classificaria "rodando" como reprovado — o bug que a issue pede pra evitar.
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("slow-job", "IN_PROGRESS", null),
    ]);
    assert.equal(result.verdict, "pending");
    assert.deepEqual(result.pendingChecks, ["slow-job"]);
    assert.deepEqual(result.failingChecks, []);
  });

  it("check QUEUED (nem começou) => 'pending'", () => {
    const result = evaluatePrChecksGate([check("ci", "QUEUED", null)]);
    assert.equal(result.verdict, "pending");
  });
});

describe("evaluatePrChecksGate — check completou falhando (o outro guard que a issue pede)", () => {
  it("check COMPLETED com conclusion FAILURE => 'fail', não 'pending'", () => {
    // Contar só status==COMPLETED como sinal de aprovação deixaria passar um check
    // que completou FALHANDO — a issue pede explicitamente pra não deixar isso passar.
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("tests", "COMPLETED", "FAILURE"),
    ]);
    assert.equal(result.verdict, "fail");
    assert.deepEqual(result.failingChecks, ["tests"]);
  });

  it("conclusion CANCELLED/TIMED_OUT/ACTION_REQUIRED/STALE => 'fail'", () => {
    for (const conclusion of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]) {
      const result = evaluatePrChecksGate([check("job", "COMPLETED", conclusion)]);
      assert.equal(result.verdict, "fail", `conclusion ${conclusion} devia reprovar`);
    }
  });

  it("um check falhando entre vários pendentes => 'fail' tem precedência sobre 'pending'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "FAILURE"),
      check("slow-job", "IN_PROGRESS", null),
    ]);
    assert.equal(result.verdict, "fail");
    assert.deepEqual(result.failingChecks, ["ci"]);
  });
});

describe("evaluatePrChecksGate — nós malformados dentro do array não quebram nem viram pass silencioso", () => {
  it("elemento null dentro do array é tratado como check sem status => 'pending', não crash", () => {
    const result = evaluatePrChecksGate([check("ci", "COMPLETED", "SUCCESS"), null]);
    assert.equal(result.verdict, "pending");
  });
});
