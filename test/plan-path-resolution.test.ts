/**
 * test/plan-path-resolution.test.ts (#6328)
 *
 * Cobre o miolo genérico compartilhado em `scripts/lib/plan-path-resolution.ts`
 * — extraído de `scripts/lib/develop-plan-collision.ts` (#6265) para servir
 * tanto `/diaria-develop` quanto `/diaria-overnight` (#6328). A suíte
 * original de `test/develop-plan-collision.test.ts` continua intacta e
 * passando — este arquivo cobre (a) o comportamento genérico sob outro
 * `baseDir` (`data/overnight`, o cenário novo desta issue), (b) o cenário
 * CROSS-MÁQUINA explícito exigido pelos critérios de aceite do #6328, e
 * (c) que o wrapper `resolveDevelopPlanPath` continua devolvendo
 * exatamente o mesmo resultado que `resolvePlanPath` (identidade de
 * contrato pós-refactor).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePlanPath,
  type PlanPathProbeResult,
} from "../scripts/lib/plan-path-resolution.ts";
import { resolveDevelopPlanPath } from "../scripts/lib/develop-plan-collision.ts";

/** "Disco" fake em memória — path → { session_id }. Mesmo padrão de
 * `test/develop-plan-collision.test.ts`, sem tocar o filesystem. */
function fakeDisk(initial: Record<string, string | null> = {}) {
  const files = new Map<string, string | null>(Object.entries(initial));
  return {
    probe(path: string): PlanPathProbeResult {
      if (!files.has(path)) return { exists: false };
      return { exists: true, sessionId: files.get(path) ?? null };
    },
    write(path: string, sessionId: string) {
      files.set(path, sessionId);
    },
  };
}

// --- comportamento genérico sob data/overnight --------------------------

test("overnight: primeira sessão do dia → path sem sufixo, mode fresh", () => {
  const disk = fakeDisk();
  const resolved = resolvePlanPath("data/overnight", "260826", "session-A", disk.probe);
  assert.deepEqual(resolved, {
    path: "data/overnight/260826/plan.json",
    suffix: "",
    mode: "fresh",
  });
});

test("overnight: retomada genuína (mesmo session_id) → mode resume, sem regressão", () => {
  const disk = fakeDisk({ "data/overnight/260826/plan.json": "session-A" });
  const resolved = resolvePlanPath("data/overnight", "260826", "session-A", disk.probe);
  assert.deepEqual(resolved, {
    path: "data/overnight/260826/plan.json",
    suffix: "",
    mode: "resume",
  });
});

// --- reprodução direta do #6328: mesma máquina, plan.json de OUTRA sessão

test("overnight: plan.json de OUTRA sessão no mesmo AAMMDD → derived-after-collision, NUNCA resume", () => {
  const disk = fakeDisk();

  // Sessão A (1ª rodada overnight do dia) já escreveu o plano.
  const resolvedA = resolvePlanPath("data/overnight", "260826", "session-A", disk.probe);
  disk.write(resolvedA.path, "session-A");

  // Sessão B chega — outra rodada overnight, mesmo dia. ANTES do #6328, o
  // passo 0 só olhava existsSync(plan.json) e concluía "é resume" sem
  // nunca checar session_id — pulando o briefing e corrompendo o plano de
  // A. Com o fix, o passo 0 chama este resolver na ENTRADA, antes de
  // decidir se é retomada.
  const resolvedB = resolvePlanPath("data/overnight", "260826", "session-B", disk.probe);

  assert.notEqual(resolvedB.mode, "resume");
  assert.equal(resolvedB.mode, "derived-after-collision");
  assert.notEqual(resolvedB.path, resolvedA.path);
  assert.equal(resolvedB.path, "data/overnight/260826b/plan.json");
  assert.deepEqual(resolvedB.collisions, [
    { path: "data/overnight/260826/plan.json", sessionId: "session-A" },
  ]);

  // O plano da Sessão A permanece intacto.
  assert.deepEqual(disk.probe(resolvedA.path), { exists: true, sessionId: "session-A" });
});

// --- cenário CROSS-MÁQUINA explícito (critério de aceite do #6328) ------

test("cross-máquina: mesmo AAMMDD, sessão de OUTRA MÁQUINA (machine_id diferente) → fresh/derived, nunca resume", () => {
  // O resolver discrimina por session_id, não por machine_id (ver docblock
  // de plan-path-resolution.ts) — session_id já é único por sessão,
  // independente de máquina, então o cenário cross-máquina do editor
  // ("máquina B roda /diaria-overnight no mesmo dia que a máquina A, via
  // OneDrive compartilhado") é exatamente este teste: duas sessões com
  // session_id distintos (uma por processo/harness, nunca reaproveitado
  // entre máquinas), disco compartilhado simulando o mesmo OneDrive.
  const disk = fakeDisk();

  // "Máquina A" grava o plano da rodada dela (machine_id: "predator",
  // session_id: "session-maquina-A" — o campo machine_id em si não entra
  // no probe/resolver, é gravado à parte no plan.json pelo passo 7 da
  // skill; o que o resolver vê é só o session_id).
  const resolvedA = resolvePlanPath("data/overnight", "260826", "session-maquina-A", disk.probe);
  assert.equal(resolvedA.mode, "fresh");
  disk.write(resolvedA.path, "session-maquina-A");

  // "Máquina B" (outro hostname, mesmo OneDrive, mesmo AAMMDD) roda
  // /diaria-overnight — via passo 0, ANTES de decidir Resume.
  const resolvedB = resolvePlanPath("data/overnight", "260826", "session-maquina-B", disk.probe);
  assert.notEqual(resolvedB.mode, "resume");
  assert.equal(resolvedB.mode, "derived-after-collision");
  assert.notEqual(resolvedB.path, resolvedA.path);
  disk.write(resolvedB.path, "session-maquina-B");

  // Uma 3ª sessão surgindo numa 3ª máquina, ainda o mesmo dia, também
  // nunca herda o path de nenhuma das duas anteriores.
  const resolvedC = resolvePlanPath("data/overnight", "260826", "session-maquina-C", disk.probe);
  assert.notEqual(resolvedC.mode, "resume");
  assert.equal(resolvedC.mode, "derived-after-collision");
  assert.notEqual(resolvedC.path, resolvedA.path);
  assert.notEqual(resolvedC.path, resolvedB.path);

  // Nenhum dos planos de A/B foi sobrescrito pelas chegadas seguintes.
  assert.deepEqual(disk.probe(resolvedA.path), { exists: true, sessionId: "session-maquina-A" });
  assert.deepEqual(disk.probe(resolvedB.path), { exists: true, sessionId: "session-maquina-B" });
});

test("cross-máquina: mesma sessão retomando (mesmo session_id) — não confundir com máquina diferente", () => {
  // A máquina que efetivamente é dona da rodada, revisitando o path (ex:
  // 2º write do passo 7 depois do passo 0), continua recebendo "resume"
  // mesmo em disco compartilhado entre máquinas — o discriminador é
  // session_id, não hostname/machine_id.
  const disk = fakeDisk({ "data/overnight/260826/plan.json": "session-maquina-A" });
  const resolved = resolvePlanPath("data/overnight", "260826", "session-maquina-A", disk.probe);
  assert.equal(resolved.mode, "resume");
});

// --- plan.json legado sem session_id -------------------------------------

test("overnight: plan.json legado sem session_id é tratado com cautela — nunca 'resume', nunca 'livre pra tomar'", () => {
  const disk = fakeDisk({ "data/overnight/260826/plan.json": null });
  const resolved = resolvePlanPath("data/overnight", "260826", "session-B", disk.probe);
  assert.notEqual(resolved.mode, "resume");
  assert.equal(resolved.mode, "derived-after-collision");
  assert.deepEqual(resolved.collisions, [
    { path: "data/overnight/260826/plan.json", sessionId: null },
  ]);
});

// --- identidade de contrato do wrapper (#6328) ----------------------------

test("wrapper resolveDevelopPlanPath mantém contrato de saída idêntico ao de resolvePlanPath (pré-refactor)", () => {
  const scenarios: Array<[string, string, string, Record<string, string | null>]> = [
    ["fresh, disco vazio", "data/develop", "260826", {}],
    [
      "resume, session_id já gravado",
      "data/develop",
      "260826",
      { "data/develop/260826/plan.json": "session-X" },
    ],
    [
      "colisão, session_id alheio",
      "data/develop",
      "260826",
      { "data/develop/260826/plan.json": "session-outra" },
    ],
    [
      "colisão, plano legado sem session_id",
      "data/develop",
      "260826",
      { "data/develop/260826/plan.json": null },
    ],
  ];

  for (const [label, baseDir, aammdd, initial] of scenarios) {
    const diskA = fakeDisk(initial);
    const diskB = fakeDisk(initial);
    const viaGeneric = resolvePlanPath(baseDir, aammdd, "session-X", diskA.probe);
    const viaWrapper = resolveDevelopPlanPath(baseDir, aammdd, "session-X", diskB.probe);
    assert.deepEqual(viaWrapper, viaGeneric, `cenário "${label}" divergiu entre wrapper e genérico`);
  }
});
