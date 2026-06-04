/**
 * preflight-poll-dispatch.test.ts (#1803)
 *
 * Regressão do P1 #1803: o preflight de poll deve rodar maintain-valid-editions
 * + smoke-test-vote SEMPRE (qualquer entry path, incl. resume direto pro Stage
 * 4) e BLOQUEAR o envio se o smoke-test falhar. Os passos de fix são best-effort
 * (warn-only); o smoke-test é o gate duro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planSteps,
  decide,
  runPreflight,
  parseInjectFailed,
  type StepName,
  type StepSpec,
  type StepRunner,
  type StepOutcome,
} from "../scripts/preflight-poll-dispatch.ts";

/**
 * Runner fake: registra a ordem dos passos e devolve exit codes + stdout
 * scriptados. `codes` mapeia step→exitCode; `stdouts` mapeia step→stdout JSON.
 */
function fakeRunner(
  codes: Partial<Record<StepName, number>>,
  stdouts: Partial<Record<StepName, string>> = {},
): { run: StepRunner; calls: StepName[] } {
  const calls: StepName[] = [];
  const run: StepRunner = (spec: StepSpec) => {
    calls.push(spec.name);
    return { exitCode: codes[spec.name] ?? 0, stdout: stdouts[spec.name] ?? "" };
  };
  return { run, calls };
}

describe("preflight-poll-dispatch — plano de passos", () => {
  it("ordem é fix → fix → verify; só o smoke-test é blocking", () => {
    const specs = planSteps("260604");
    assert.deepEqual(
      specs.map((s) => s.name),
      ["maintain-valid-editions", "inject-poll-sig", "smoke-test-vote"],
    );
    assert.equal(specs[0].blocking, false, "maintain é best-effort");
    assert.equal(specs[1].blocking, false, "inject é best-effort");
    assert.equal(specs[2].blocking, true, "smoke-test é o gate duro");
  });

  it("passa --current e --window-days pro maintain e --edition pro smoke", () => {
    const specs = planSteps("260604", { windowDays: 7, sinceHours: 96 });
    assert.deepEqual(specs[0].args, ["--current", "260604", "--window-days", "7"]);
    assert.deepEqual(specs[1].args, ["--since-hours", "96"]);
    assert.deepEqual(specs[2].args, ["--edition", "260604"]);
  });
});

describe("preflight-poll-dispatch — resume direto pro Stage 4 (#1803)", () => {
  it("SEMPRE roda maintain-valid-editions + smoke-test, mesmo num resume", () => {
    const { run, calls } = fakeRunner({});
    runPreflight("260604", {}, run);
    assert.ok(calls.includes("maintain-valid-editions"), "maintain deve rodar");
    assert.ok(calls.includes("smoke-test-vote"), "smoke-test deve rodar");
    assert.deepEqual(calls, [
      "maintain-valid-editions",
      "inject-poll-sig",
      "smoke-test-vote",
    ]);
  });

  it("smoke-test 410/403 (exit 2) BLOQUEIA o envio — caso 260604", () => {
    const { run, calls } = fakeRunner({ "smoke-test-vote": 2 });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, true, "deve bloquear o envio");
    assert.equal(decision.blockingStep, "smoke-test-vote");
    assert.match(decision.haltReason ?? "", /valid_editions/);
    // ainda assim, o smoke-test foi executado (não foi pulado num resume)
    assert.ok(calls.includes("smoke-test-vote"));
  });

  it("smoke-test network (exit 3) bloqueia com motivo de rede", () => {
    const { run } = fakeRunner({ "smoke-test-vote": 3 });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, true);
    assert.match(decision.haltReason ?? "", /network|timeout/i);
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
      "inject-poll-sig": 1, // beehiiv 5xx
      "smoke-test-vote": 0, // mas votos são aceitos → autoritativo
    });
    const { decision } = runPreflight("260604", {}, run);
    assert.equal(decision.block, false, "smoke-test passou → não bloqueia");
    assert.deepEqual(
      decision.warnings.sort(),
      ["inject-poll-sig", "maintain-valid-editions"],
      "passos best-effort viram warning",
    );
    // smoke-test rodou mesmo após os fixes falharem (sem short-circuit)
    assert.ok(calls.includes("smoke-test-vote"));
  });
});

describe("preflight-poll-dispatch — cobertura do 403 / poll_sig (#1803 review)", () => {
  it("inject com failed>0 (mas exit 0) surfa pollSigRisk — smoke-test só vê o editor", () => {
    // inject-poll-sig sai 0 mesmo com patches falhados → o sinal só vem no stdout.
    const { run } = fakeRunner(
      { "inject-poll-sig": 0, "smoke-test-vote": 0 },
      { "inject-poll-sig": JSON.stringify({ failed: 3, in_window: 12, patched: 9 }) },
    );
    const { pollSigRisk, decision } = runPreflight("260604", {}, run);
    assert.deepEqual(pollSigRisk, { failed: 3, inWindow: 12 });
    // não bloqueia (§0d.ter: minoria sem sig é tradeoff aceito), mas fica visível
    assert.equal(decision.block, false);
  });

  it("inject sem failed → pollSigRisk null", () => {
    const { run } = fakeRunner(
      { "inject-poll-sig": 0 },
      { "inject-poll-sig": JSON.stringify({ failed: 0, in_window: 5 }) },
    );
    const { pollSigRisk } = runPreflight("260604", {}, run);
    assert.equal(pollSigRisk, null);
  });

  it("parseInjectFailed ignora stdout não-JSON", () => {
    assert.equal(parseInjectFailed("não é json"), null);
    assert.equal(parseInjectFailed(""), null);
    assert.deepEqual(parseInjectFailed(JSON.stringify({ failed: 2, in_window: 4 })), {
      failed: 2,
      inWindow: 4,
    });
  });
});

describe("preflight-poll-dispatch — decide() puro", () => {
  it("exit 2 do smoke aponta valid_editions/sig", () => {
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
