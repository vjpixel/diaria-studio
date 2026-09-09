/**
 * test/repair-node-floor-units.test.ts (#7842, correção A)
 *
 * Regressão para o passo de reparo (escrita) que complementa a detecção de
 * `scripts/lib/systemd-node-floor-guard.ts` (#7522): dado um relatório
 * below-floor, o plano escolhe o node-alvo certo (maioria entre as units
 * "ok"), reaponta só o binário do `ExecStart=` preservando o resto da
 * linha, e `applyNodeFloorRepairs` escreve exatamente essas units — nunca
 * as demais, nunca chama systemctl.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyNodeFloorRepairs,
  pickTargetNodePath,
  planNodeFloorRepairs,
  repointExecStartNodePath,
  type NodeFloorRepairPlan,
} from "../scripts/lib/repair-node-floor-units.ts";
import type { SystemdUnitsNodeFloorReport, UnitNodeFloorResult } from "../scripts/lib/systemd-node-floor-guard.ts";
import { formatPlan } from "../scripts/repair-node-floor-units.ts";

function unit(overrides: Partial<UnitNodeFloorResult>): UnitNodeFloorResult {
  return {
    unitFileName: "x.service",
    nodePath: null,
    nodeVersion: null,
    verdict: "ok",
    ...overrides,
  };
}

// --- pickTargetNodePath -----------------------------------------------------

test("pickTargetNodePath — escolhe o nodePath mais frequente entre units ok", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "below-floor",
    units: [
      unit({ unitFileName: "a.service", verdict: "ok", nodePath: "/nvm/node", nodeVersion: "v24.19.0" }),
      unit({ unitFileName: "b.service", verdict: "ok", nodePath: "/nvm/node", nodeVersion: "v24.19.0" }),
      unit({ unitFileName: "c.service", verdict: "ok", nodePath: "/local/node", nodeVersion: "v24.19.0" }),
      unit({ unitFileName: "d.service", verdict: "below-floor", nodePath: "/usr/bin/node", nodeVersion: "v20.20.2" }),
    ],
  };
  assert.equal(pickTargetNodePath(report), "/nvm/node");
});

test("pickTargetNodePath — empate resolve por ordem alfabética (determinístico)", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "ok",
    units: [
      unit({ unitFileName: "a.service", verdict: "ok", nodePath: "/z/node" }),
      unit({ unitFileName: "b.service", verdict: "ok", nodePath: "/a/node" }),
    ],
  };
  assert.equal(pickTargetNodePath(report), "/a/node");
});

test("pickTargetNodePath — nenhuma unit ok -> null (nunca adivinha)", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "below-floor",
    units: [unit({ verdict: "below-floor", nodePath: "/usr/bin/node" })],
  };
  assert.equal(pickTargetNodePath(report), null);
});

// --- repointExecStartNodePath ------------------------------------------------

test("repointExecStartNodePath — troca só o binário, preserva flags/args", () => {
  const content = [
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/bin/node --import tsx /repo/scripts/run-task.ts --task X",
    "",
  ].join("\n");
  const result = repointExecStartNodePath(content, "/home/x/.nvm/versions/node/v24.19.0/bin/node");
  assert.match(
    result,
    /^ExecStart=\/home\/x\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/node --import tsx \/repo\/scripts\/run-task\.ts --task X$/m,
  );
  // resto do arquivo intocado
  assert.match(result, /Type=oneshot/);
});

test("repointExecStartNodePath — preserva EOL CRLF quando o original usa CRLF", () => {
  const content = "[Service]\r\nExecStart=/usr/bin/node x\r\n";
  const result = repointExecStartNodePath(content, "/nvm/node");
  assert.ok(result.includes("\r\n"));
  assert.match(result, /ExecStart=\/nvm\/node x\r\n/);
});

test("repointExecStartNodePath — sem ExecStart= reconhecível -> lança", () => {
  assert.throws(() => repointExecStartNodePath("[Service]\nDescription=sem ExecStart\n", "/nvm/node"));
});

// --- planNodeFloorRepairs ----------------------------------------------------

test("planNodeFloorRepairs — monta repairs só para below-floor, usando o alvo majoritário", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "below-floor",
    units: [
      unit({ unitFileName: "ok1.service", verdict: "ok", nodePath: "/nvm/node" }),
      unit({ unitFileName: "ok2.service", verdict: "ok", nodePath: "/nvm/node" }),
      unit({ unitFileName: "broken.service", verdict: "below-floor", nodePath: "/usr/bin/node" }),
    ],
  };
  const plan = planNodeFloorRepairs(report, (name) =>
    name === "broken.service" ? "ExecStart=/usr/bin/node x" : null,
  );
  assert.equal(plan.targetNodePath, "/nvm/node");
  assert.equal(plan.repairs.length, 1);
  assert.deepEqual(plan.repairs[0], { unitFileName: "broken.service", oldNodePath: "/usr/bin/node", newNodePath: "/nvm/node" });
  assert.equal(plan.skipped.length, 0);
});

test("planNodeFloorRepairs — unit below-floor cujo conteúdo não foi lido cai em skipped, não trava o plano", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "below-floor",
    units: [
      unit({ unitFileName: "ok1.service", verdict: "ok", nodePath: "/nvm/node" }),
      unit({ unitFileName: "unreadable.service", verdict: "below-floor", nodePath: "/usr/bin/node" }),
    ],
  };
  const plan = planNodeFloorRepairs(report, () => null);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].unitFileName, "unreadable.service");
});

test("planNodeFloorRepairs — sem nenhuma unit ok -> targetNodePath null, tudo skipped", () => {
  const report: SystemdUnitsNodeFloorReport = {
    verdict: "below-floor",
    units: [unit({ unitFileName: "broken.service", verdict: "below-floor", nodePath: "/usr/bin/node" })],
  };
  const plan = planNodeFloorRepairs(report, () => "ExecStart=/usr/bin/node x");
  assert.equal(plan.targetNodePath, null);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.skipped.length, 1);
});

// --- applyNodeFloorRepairs — integração com diretório temp ------------------

test("applyNodeFloorRepairs — escreve SÓ as units do plano, preserva as demais intocadas", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-node-floor-"));
  try {
    writeFileSync(
      join(dir, "broken.service"),
      ["[Service]", "ExecStart=/usr/bin/node --import tsx run-task.ts --task X", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "untouched.service"),
      ["[Service]", "ExecStart=/nvm/node --import tsx run-task.ts --task Y", ""].join("\n"),
    );
    const originalUntouched = readFileSync(join(dir, "untouched.service"), "utf8");

    const plan: NodeFloorRepairPlan = {
      targetNodePath: "/nvm/node",
      repairs: [{ unitFileName: "broken.service", oldNodePath: "/usr/bin/node", newNodePath: "/nvm/node" }],
      skipped: [],
    };

    const result = applyNodeFloorRepairs(plan, dir);
    assert.deepEqual(result.written, ["broken.service"]);
    assert.deepEqual(result.errors, []);

    const fixedContent = readFileSync(join(dir, "broken.service"), "utf8");
    assert.match(fixedContent, /^ExecStart=\/nvm\/node --import tsx run-task\.ts --task X$/m);

    // untouched.service não foi tocada
    assert.equal(readFileSync(join(dir, "untouched.service"), "utf8"), originalUntouched);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyNodeFloorRepairs — unit ausente no disco falha ISOLADAMENTE (errors), não lança, não trava as demais", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-node-floor-partial-"));
  try {
    writeFileSync(
      join(dir, "ok.service"),
      ["[Service]", "ExecStart=/usr/bin/node --import tsx run-task.ts --task Y", ""].join("\n"),
    );
    // "missing.service" está no plano mas NÃO existe em disco (ex: removida
    // entre o scan e o --apply) — simula o cenário do finding de silent-failure.
    const plan: NodeFloorRepairPlan = {
      targetNodePath: "/nvm/node",
      repairs: [
        { unitFileName: "missing.service", oldNodePath: "/usr/bin/node", newNodePath: "/nvm/node" },
        { unitFileName: "ok.service", oldNodePath: "/usr/bin/node", newNodePath: "/nvm/node" },
      ],
      skipped: [],
    };

    const result = applyNodeFloorRepairs(plan, dir);
    // A unit que existia foi escrita com sucesso mesmo com a outra falhando.
    assert.deepEqual(result.written, ["ok.service"]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].unitFileName, "missing.service");
    assert.ok(result.errors[0].message.length > 0);

    const fixedContent = readFileSync(join(dir, "ok.service"), "utf8");
    assert.match(fixedContent, /^ExecStart=\/nvm\/node/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- formatPlan (CLI) — cobre o gap de finding #4 / bug de finding #1 ------

test("formatPlan — sem repairs mas com skipped NUNCA diz \"nada a reparar\" (#7847 finding 1)", () => {
  const plan: NodeFloorRepairPlan = {
    targetNodePath: "/nvm/node",
    repairs: [],
    skipped: [
      {
        unitFileName: "unreadable.service",
        nodePath: "/usr/bin/node",
        nodeVersion: "v20.20.2",
        verdict: "below-floor",
        detail: "abaixo do piso",
      },
    ],
  };
  const output = formatPlan(plan);
  assert.doesNotMatch(output, /nada a reparar/i);
  assert.match(output, /unreadable\.service/);
});

test("formatPlan — sem repairs e sem skipped -> \"nada a reparar\"", () => {
  const plan: NodeFloorRepairPlan = { targetNodePath: "/nvm/node", repairs: [], skipped: [] };
  assert.match(formatPlan(plan), /nada a reparar/i);
});

test("formatPlan — com repairs e skipped, ambos aparecem no output", () => {
  const plan: NodeFloorRepairPlan = {
    targetNodePath: "/nvm/node",
    repairs: [{ unitFileName: "a.service", oldNodePath: "/usr/bin/node", newNodePath: "/nvm/node" }],
    skipped: [
      { unitFileName: "b.service", nodePath: "/usr/bin/node", nodeVersion: "v20.20.2", verdict: "below-floor" },
    ],
  };
  const output = formatPlan(plan);
  assert.match(output, /a\.service/);
  assert.match(output, /b\.service/);
});

test("formatPlan — targetNodePath null sempre sinaliza reparo manual, nunca sucesso", () => {
  const plan: NodeFloorRepairPlan = { targetNodePath: null, repairs: [], skipped: [] };
  assert.match(formatPlan(plan), /manual necessário/i);
});
