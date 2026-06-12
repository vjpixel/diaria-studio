/**
 * preflight-poll-dispatch.test.ts (#1803, simplificado em #1186)
 *
 * Regressão do P1 #1803: o preflight de poll deve rodar maintain-valid-editions
 * + smoke-test-vote SEMPRE (qualquer entry path, incl. resume direto pro Stage
 * 5) e BLOQUEAR o envio se o smoke-test falhar. O passo fix é best-effort
 * (warn-only); o smoke-test é o gate duro.
 *
 * #1186: inject-poll-sig removido — 2 passos em vez de 3.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planSteps,
  decide,
  runPreflight,
  type StepName,
  type StepSpec,
  type StepRunner,
  type StepOutcome,
} from "../scripts/preflight-poll-dispatch.ts";

/**
 * Runner fake: registra a ordem dos passos e devolve exit codes scriptados.
 * `codes` mapeia step→exitCode.
 */
function fakeRunner(
  codes: Partial<Record<StepName, number>>,
): { run: StepRunner; calls: StepName[] } {
  const calls: StepName[] = [];
  const run: StepRunner = (spec: StepSpec) => {
    calls.push(spec.name);
    return { exitCode: codes[spec.name] ?? 0 };
  };
  return { run, calls };
}

describe("preflight-poll-dispatch — plano de passos (#1186)", () => {
  it("ordem é fix → verify; só o smoke-test é blocking (2 passos, sem inject-poll-sig)", () => {
    const specs = planSteps("260604");
    assert.deepEqual(
      specs.map((s) => s.name),
      ["maintain-valid-editions", "smoke-test-vote"],
    );
    assert.equal(specs[0].blocking, false, "maintain é best-effort");
    assert.equal(specs[1].blocking, true, "smoke-test é o gate duro");
  });

  it("NÃO tem inject-poll-sig no plano (#1186 — modo merge-tag)", () => {
    const specs = planSteps("260604");
    const names = specs.map((s) => s.name);
    assert.ok(!names.includes("inject-poll-sig" as StepName), "inject-poll-sig removido");
    assert.equal(names.length, 2, "exatamente 2 passos");
  });

  it("passa --current e --window-days pro maintain e --edition pro smoke", () => {
    const specs = planSteps("260604", { windowDays: 7 });
    assert.deepEqual(specs[0].args, ["--current", "260604", "--window-days", "7"]);
    assert.deepEqual(specs[1].args, ["--edition", "260604"]);
  });
});

describe("preflight-poll-dispatch — resume direto pro Stage 5 (#1803)", () => {
  it("SEMPRE roda maintain-valid-editions + smoke-test, mesmo num resume", () => {
    const { run, calls } = fakeRunner({});
    runPreflight("260604", {}, run);
    assert.ok(calls.includes("maintain-valid-editions"), "maintain deve rodar");
    assert.ok(calls.includes("smoke-test-vote"), "smoke-test deve rodar");
    assert.deepEqual(calls, [
      "maintain-valid-editions",
      "smoke-test-vote",
    ]);
  });

  it("URL de voto do diário não tem sig= (#1186 — merge-tag mode)", () => {
    // Regressão: a URL de voto deve ser email-only, sem &sig= no HTML.
    // Este teste valida o contrato via preflight (2 passos, sem inject).
    const specs = planSteps("260604");
    const hasInjectStep = specs.some((s) => s.name === ("inject-poll-sig" as StepName));
    assert.equal(hasInjectStep, false, "inject-poll-sig ausente = merge-tag mode ativo");
  });

  it("smoke-test exit 2 (Worker rejeitou) BLOQUEIA o envio — caso 260604", () => {
    // Cobre 410 (edição inválida) e 403 (sig inválida — não deve ocorrer em
    // merge-tag mode, mas smoke-test sai 2 pra qualquer HTTP error não-ok).
    const { run, calls } = fakeRunner({ "smoke-test-vote": 2 });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, true, "deve bloquear o envio");
    assert.equal(decision.blockingStep, "smoke-test-vote");
    assert.match(decision.haltReason ?? "", /valid_editions|rejeitou/);
    // ainda assim, o smoke-test foi executado (não foi pulado num resume)
    assert.ok(calls.includes("smoke-test-vote"));
  });

  it("smoke-test network (exit 3) bloqueia com motivo de rede", () => {
    const { run } = fakeRunner({ "smoke-test-vote": 3 });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, true);
    assert.match(decision.haltReason ?? "", /network|timeout/i);
  });

  it("smoke-test exit 1 (args inválidos) não menciona POLL_SECRET (#1186)", () => {
    // Regressão: antes do #1186, exit-1 sugeria "confira POLL_SECRET no .env".
    // Pós-#1186, POLL_SECRET foi removido dos requisitos do smoke-test.
    // A mensagem de halt não deve mais referenciar POLL_SECRET.
    const { run } = fakeRunner({ "smoke-test-vote": 1 });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, true);
    assert.ok(
      !(decision.haltReason ?? "").includes("POLL_SECRET"),
      "halt reason não deve mencionar POLL_SECRET — foi removido em #1186",
    );
    assert.ok(
      !(decision.haltAction ?? "").includes("POLL_SECRET"),
      "halt action não deve mencionar POLL_SECRET — foi removido em #1186",
    );
  });

  it("todos verdes → não bloqueia (ok=true)", () => {
    const { run } = fakeRunner({});
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.ok, true);
    assert.equal(decision.block, false);
    assert.deepEqual(decision.warnings, []);
  });

  it("fix best-effort falha mas smoke-test passa → segue com WARN, não bloqueia", () => {
    const { run, calls } = fakeRunner({
      "maintain-valid-editions": 2, // read_failed transiente
      "smoke-test-vote": 0, // mas votos são aceitos → autoritativo
    });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, false, "smoke-test passou → não bloqueia");
    assert.deepEqual(
      decision.warnings.sort(),
      ["maintain-valid-editions"],
      "passo best-effort vira warning",
    );
    // smoke-test rodou mesmo após o fix falhar (sem short-circuit)
    assert.ok(calls.includes("smoke-test-vote"));
  });
});

describe("preflight-poll-dispatch — decide() puro", () => {
  it("exit 2 do smoke aponta valid_editions", () => {
    const outcomes: StepOutcome[] = [
      { name: "smoke-test-vote", exitCode: 2, blocking: true },
    ];
    const d = decide("260604", outcomes);
    assert.equal(d.block, true);
    assert.match(d.haltReason ?? "", /260604/);
  });

  it("falha só em passo best-effort nunca bloqueia", () => {
    const outcomes: StepOutcome[] = [
      { name: "maintain-valid-editions", exitCode: 2, blocking: false },
      { name: "smoke-test-vote", exitCode: 0, blocking: true },
    ];
    const d = decide("260604", outcomes);
    assert.equal(d.block, false);
    assert.deepEqual(d.warnings, ["maintain-valid-editions"]);
  });
});
