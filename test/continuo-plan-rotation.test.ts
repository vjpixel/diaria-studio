/**
 * test/continuo-plan-rotation.test.ts (#5293 item 5)
 *
 * Cobre `scripts/lib/continuo-plan-rotation.ts` — rotação diária de
 * `plan.json` sob `data/continuo/{AAMMDD}/` pra uma sessão `/diaria-continuo`
 * que nunca termina (por desenho, cruza múltiplos dias civis BRT). Isolado
 * em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  todayAammdd,
  shouldRotatePlan,
  listContinuoDays,
  buildRotatedPlanSeed,
  buildHistoryLine,
  rotateContinuoPlanIfNeeded,
  continuoRoot,
  continuoHistoryPath,
} from "../scripts/lib/continuo-plan-rotation.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "continuo-rotation-"));
}

describe("todayAammdd (#5293 item 5)", () => {
  it("converte um instante UTC pro dia civil BRT (AAMMDD)", () => {
    // 2026-08-14T15:00:00Z = 2026-08-14T12:00:00 BRT (UTC-3) — mesmo dia
    const now = new Date("2026-08-14T15:00:00Z");
    assert.equal(todayAammdd(now), "260814");
  });

  it("um instante logo após meia-noite UTC ainda é o dia ANTERIOR em BRT", () => {
    // 2026-08-15T02:00:00Z = 2026-08-14T23:00:00 BRT — ainda dia 14 em BRT
    const now = new Date("2026-08-15T02:00:00Z");
    assert.equal(todayAammdd(now), "260814");
  });
});

describe("shouldRotatePlan (#5293 item 5)", () => {
  it("mesmo dia → não rotaciona", () => {
    assert.equal(shouldRotatePlan("260814", "260814"), false);
  });

  it("dia seguinte → rotaciona", () => {
    assert.equal(shouldRotatePlan("260814", "260815"), true);
  });

  it("today 'no passado' relativo ao diretório mais recente → NUNCA rotaciona (clock skew, nunca perde dados)", () => {
    assert.equal(shouldRotatePlan("260815", "260814"), false);
  });

  it("virada de mês (lexicográfico continua cronológico em YYMMDD)", () => {
    assert.equal(shouldRotatePlan("260831", "260901"), true);
  });
});

describe("listContinuoDays (#5293 item 5)", () => {
  it("data/continuo/ ausente → array vazio", () => {
    const dir = tmp();
    try {
      assert.deepEqual(listContinuoDays(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna só dirs YYMMDD com plan.json, ordenados cronologicamente", () => {
    const dir = tmp();
    try {
      for (const aammdd of ["260814", "260812", "260813"]) {
        mkdirSync(join(dir, "data", "continuo", aammdd), { recursive: true });
        writeFileSync(join(dir, "data", "continuo", aammdd, "plan.json"), "{}");
      }
      // dir sem plan.json — deve ser ignorado
      mkdirSync(join(dir, "data", "continuo", "260815"), { recursive: true });
      // dir com nome inválido — ignorado
      mkdirSync(join(dir, "data", "continuo", "not-a-date"), { recursive: true });

      assert.deepEqual(listContinuoDays(dir), ["260812", "260813", "260814"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildRotatedPlanSeed (#5293 item 5)", () => {
  it("seed fresco tem continued_from apontando pro dia anterior", () => {
    const seed = buildRotatedPlanSeed({
      previousAammdd: "260813",
      previousPlan: { started_at: "2026-08-13T10:00:00Z" },
      nowIso: "2026-08-14T00:05:00Z",
    });
    assert.equal(seed.continued_from, "260813");
    assert.equal(seed.started_at, "2026-08-14T00:05:00Z");
    assert.deepEqual(seed.stall_events, []);
    assert.deepEqual(seed.issues, []);
  });

  it("carrega adiante bugs_only/priority_filter do dia anterior (config de SESSÃO, não de dia)", () => {
    const seed = buildRotatedPlanSeed({
      previousAammdd: "260813",
      previousPlan: { bugs_only: true, priority_filter: ["P0", "P1"] },
      nowIso: "2026-08-14T00:05:00Z",
    });
    assert.equal(seed.bugs_only, true);
    assert.deepEqual(seed.priority_filter, ["P0", "P1"]);
  });

  it("previousPlan=null (dia anterior ilegível) → seed ainda válido, sem os campos de sessão", () => {
    const seed = buildRotatedPlanSeed({ previousAammdd: "260813", previousPlan: null, nowIso: "2026-08-14T00:05:00Z" });
    assert.equal(seed.continued_from, "260813");
    assert.ok(!("bugs_only" in seed));
  });
});

describe("buildHistoryLine (#5293 item 5)", () => {
  it("produz uma linha JSON válida com os 3 campos", () => {
    const line = buildHistoryLine({ fromAammdd: "260813", toAammdd: "260814", rotatedAt: "2026-08-14T00:05:00Z" });
    const parsed = JSON.parse(line);
    assert.deepEqual(parsed, { aammdd: "260813", continued_to: "260814", rotated_at: "2026-08-14T00:05:00Z" });
  });
});

describe("rotateContinuoPlanIfNeeded (#5293 item 5) — I/O", () => {
  it("data/continuo/ vazio → bootstrap: cria o dia de hoje, fromAammdd=null, sem continued_from", () => {
    const dir = tmp();
    try {
      const now = new Date("2026-08-14T15:00:00Z"); // 260814 BRT
      const result = rotateContinuoPlanIfNeeded(dir, now);
      assert.equal(result.rotated, false);
      assert.equal(result.fromAammdd, null);
      assert.equal(result.toAammdd, "260814");
      const plan = JSON.parse(readFileSync(join(continuoRoot(dir), "260814", "plan.json"), "utf8"));
      assert.equal(plan.continued_from, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bootstrap é idempotente — 2ª chamada no mesmo dia não sobrescreve plan.json já em progresso", () => {
    const dir = tmp();
    try {
      const now = new Date("2026-08-14T15:00:00Z");
      rotateContinuoPlanIfNeeded(dir, now);
      // Simula progresso real gravado no plan.json do dia
      const planPath = join(continuoRoot(dir), "260814", "plan.json");
      writeFileSync(planPath, JSON.stringify({ started_at: "x", issues: [{ number: 123 }] }));

      const result = rotateContinuoPlanIfNeeded(dir, now);
      assert.equal(result.rotated, false);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      assert.deepEqual(plan.issues, [{ number: 123 }], "não deve ter sido sobrescrito pelo seed vazio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mesmo dia → sem rotação (rotated: false, aponta pro dia já existente)", () => {
    const dir = tmp();
    try {
      const now = new Date("2026-08-14T15:00:00Z");
      rotateContinuoPlanIfNeeded(dir, now);
      const result = rotateContinuoPlanIfNeeded(dir, new Date("2026-08-14T20:00:00Z"));
      assert.equal(result.rotated, false);
      assert.equal(result.fromAammdd, "260814");
      assert.equal(result.toAammdd, "260814");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dia seguinte → rotaciona de verdade: novo diretório, continued_from, history.jsonl apendado", () => {
    const dir = tmp();
    try {
      rotateContinuoPlanIfNeeded(dir, new Date("2026-08-14T15:00:00Z"));
      // marca progresso no dia 14 antes de rotacionar
      const day14Plan = join(continuoRoot(dir), "260814", "plan.json");
      writeFileSync(day14Plan, JSON.stringify({ started_at: "x", bugs_only: true, issues: [{ number: 1 }] }));

      const result = rotateContinuoPlanIfNeeded(dir, new Date("2026-08-15T15:00:00Z"));
      assert.equal(result.rotated, true);
      assert.equal(result.fromAammdd, "260814");
      assert.equal(result.toAammdd, "260815");

      const newPlan = JSON.parse(readFileSync(join(continuoRoot(dir), "260815", "plan.json"), "utf8"));
      assert.equal(newPlan.continued_from, "260814");
      assert.equal(newPlan.bugs_only, true, "config de sessão carregada adiante");
      assert.deepEqual(newPlan.issues, [], "issues do dia NÃO são carregadas adiante — plan.json novo, dia novo");

      // dia anterior intocado
      const oldPlan = JSON.parse(readFileSync(day14Plan, "utf8"));
      assert.deepEqual(oldPlan.issues, [{ number: 1 }]);

      const historyLines = readFileSync(continuoHistoryPath(dir), "utf8").trim().split("\n");
      assert.equal(historyLines.length, 1);
      const historyEntry = JSON.parse(historyLines[0]);
      assert.equal(historyEntry.aammdd, "260814");
      assert.equal(historyEntry.continued_to, "260815");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha ao escrever history.jsonl (dir virou arquivo) não impede a rotação de plan.json", () => {
    const dir = tmp();
    try {
      rotateContinuoPlanIfNeeded(dir, new Date("2026-08-14T15:00:00Z"));
      // Sabota o append: history.jsonl é substituído por um DIRETÓRIO — appendFileSync deve lançar (EISDIR)
      rmSync(continuoHistoryPath(dir), { force: true });
      mkdirSync(continuoHistoryPath(dir));

      const result = rotateContinuoPlanIfNeeded(dir, new Date("2026-08-15T15:00:00Z"));
      assert.equal(result.rotated, true, "rotação de plan.json deve suceder mesmo com history.jsonl quebrado");
      assert.ok(existsSync(join(continuoRoot(dir), "260815", "plan.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5293 fleet review achado 2: falha ao escrever history.jsonl é LOGADA em stderr, nunca silenciosa", () => {
    const dir = tmp();
    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      rotateContinuoPlanIfNeeded(dir, new Date("2026-08-14T15:00:00Z"));
      rmSync(continuoHistoryPath(dir), { force: true });
      mkdirSync(continuoHistoryPath(dir));
      rotateContinuoPlanIfNeeded(dir, new Date("2026-08-15T15:00:00Z"));
    } finally {
      process.stderr.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.match(stderrOutput, /history\.jsonl/);
  });

  it("#5293 fleet review achado 1: plan.json do dia anterior CORROMPIDO não impede rotação — usa readPlanFromDir (retry), loga em stderr", () => {
    const dir = tmp();
    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      rotateContinuoPlanIfNeeded(dir, new Date("2026-08-14T15:00:00Z"));
      // Corrompe o plan.json do dia 14 — nunca vai parsear, mesmo com retry.
      writeFileSync(join(continuoRoot(dir), "260814", "plan.json"), "{ isto não é json válido");

      const result = rotateContinuoPlanIfNeeded(dir, new Date("2026-08-15T15:00:00Z"));
      assert.equal(result.rotated, true, "rotação deve suceder mesmo com plan.json anterior corrompido (fail-soft)");
      const newPlan = JSON.parse(readFileSync(join(continuoRoot(dir), "260815", "plan.json"), "utf8"));
      assert.equal(newPlan.continued_from, "260814");
      assert.ok(!("bugs_only" in newPlan), "sem config de sessão pra carregar adiante — plan anterior ilegível");
    } finally {
      process.stderr.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.match(stderrOutput, /falha ao ler\/parsear/);
  });
});
