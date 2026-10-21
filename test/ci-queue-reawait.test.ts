/**
 * test/ci-queue-reawait.test.ts (#10699 item 1)
 *
 * O teto de 3 reaguardos de CI em fila (#10671) só existia no texto das
 * skills; o contador agora vive em `plan.json` e sobrevive a compaction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_QUEUE_REAWAITS,
  QUEUE_EXIT_CODE,
  applyQueueReawait,
  decideQueueReawait,
} from "../scripts/lib/ci-queue-reawait.ts";

describe("decideQueueReawait (#10699)", () => {
  it("3 reaguardos e, no 4º exit 7, desiste", () => {
    let counters = {};
    const actions: string[] = [];
    for (let i = 0; i < MAX_QUEUE_REAWAITS + 1; i++) {
      const r = decideQueueReawait(counters, 10, QUEUE_EXIT_CODE);
      actions.push(r.decision.action);
      counters = r.counters;
    }
    assert.deepEqual(actions, ["reawait", "reawait", "reawait", "give-up"]);
  });

  it("exit ≠ 7 zera o contador da PR e não mexe nas outras", () => {
    const r = decideQueueReawait({ "10": 2, "11": 1 }, 10, 0);
    assert.equal(r.decision.action, "proceed");
    assert.deepEqual(r.counters, { "11": 1 });
  });

  it("não muta o mapa de entrada", () => {
    const input = { "10": 1 };
    decideQueueReawait(input, 10, QUEUE_EXIT_CODE);
    assert.deepEqual(input, { "10": 1 });
  });

  it("valor corrompido no plano conta como 0", () => {
    const r = decideQueueReawait({ "10": -4 as number }, 10, QUEUE_EXIT_CODE);
    assert.equal(r.decision.queue_reawaits, 1);
  });
});

describe("applyQueueReawait — persistência em plan.json (#10699)", () => {
  it("cenário da issue: a conta sobrevive entre chamadas (compaction/retomada) e preserva o resto do plano", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-queue-reawait-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, JSON.stringify({ round: "261021", units: [{ id: "u1" }] }));
    // Cada chamada é um processo "novo": o estado só existe no arquivo.
    const results = [1, 2, 3, 4].map(() => applyQueueReawait(plan, 42, 7).action);
    assert.deepEqual(results, ["reawait", "reawait", "reawait", "give-up"]);
    const saved = JSON.parse(readFileSync(plan, "utf8"));
    assert.equal(saved.round, "261021");
    assert.deepEqual(saved.units, [{ id: "u1" }]);
    assert.deepEqual(saved.ci_queue_reawaits, { "42": 3 });
    assert.equal(applyQueueReawait(plan, 42, 1).action, "proceed");
    assert.deepEqual(JSON.parse(readFileSync(plan, "utf8")).ci_queue_reawaits, {});
  });

  it("plano ausente lança (nunca vira reaguardo mudo)", () => {
    assert.throws(() => applyQueueReawait("/nao/existe/plan.json", 1, 7), /plano não encontrado/);
  });

  it("CLI: give-up sai 3, erro sai 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-queue-reawait-cli-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, JSON.stringify({ ci_queue_reawaits: { "5": 3 } }));
    const cli = join(import.meta.dirname, "..", "scripts", "lib", "ci-queue-reawait.ts");
    const giveUp = spawnSync(process.execPath, ["--import", "tsx", cli, "--plan", plan, "--pr", "5", "--exit", "7"], {
      encoding: "utf8",
    });
    assert.equal(giveUp.status, 3, giveUp.stderr);
    assert.equal(JSON.parse(giveUp.stdout).action, "give-up");
    const bad = spawnSync(process.execPath, ["--import", "tsx", cli, "--plan", plan, "--pr", "5"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  });
});
