/**
 * test/systemd-node-version-check-13226.test.ts
 *
 * #13226: `buildSystemdUnitFiles` conferia `process.version` mesmo com
 * `nodeBin` explícito (#13136). Gerar por ssh não-interativo, com
 * `/usr/bin/node` v20 abaixo do piso e o node do nvm resolvido como
 * `nodeBin`, abortava a geração de uma unit correta. O CI roda Node 24, por
 * isso o teste simula o node antigo trocando `process.version`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const TASK = getScheduledTaskByName("Diaria-Corrupted-Names-Weekly-Check")!;
const NVM_NODE = "/home/u/.nvm/versions/node/v24.19.0/bin/node";

function withProcessVersion<T>(version: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "version")!;
  Object.defineProperty(process, "version", { ...original, value: version });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "version", original);
  }
}

test("#13226 nodeBin explícito: process.version abaixo do piso não aborta a geração", () => {
  const f = withProcessVersion("v20.20.2", () => buildSystemdUnitFiles(TASK, "/repo", NVM_NODE));
  assert.match(f.serviceContent, new RegExp(`^ExecStart=${NVM_NODE} --import tsx `, "m"));
});

test("#13226 nodeBin default (process.execPath): node do processo abaixo do piso segue lançando (#7522)", () => {
  assert.throws(() => withProcessVersion("v20.20.2", () => buildSystemdUnitFiles(TASK, "/repo")));
  assert.throws(() => withProcessVersion("v20.20.2", () => buildSystemdUnitFiles(TASK, "/repo", process.execPath)));
});
