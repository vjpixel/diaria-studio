/**
 * test/systemd-node-binary-13136.test.ts (#13136)
 *
 * Regressão: `setup-systemd-timers.ts` rodado por `ssh` não-interativo (nvm
 * não carregado, `process.execPath` = `/usr/bin/node`) gerava `ExecStart=`
 * com `/usr/bin/node`, divergindo das units armadas no `300` (nvm). O node do
 * ExecStart agora vem do nvm que casa com o `.nvmrc`, e `--diff-installed`
 * acusa unit instalada divergente do gerado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffInstalledUnits,
  NODE_BIN_ENV,
  resolveSystemdNodeBinary,
  versionMatchesNvmrc,
  type ResolveSystemdNodeBinaryDeps,
} from "../scripts/lib/systemd-node-binary.ts";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { main } from "../scripts/setup-systemd-timers.ts";

const NVM_NODE = "/home/u/.nvm/versions/node/v24.19.0/bin/node";

function deps(over: Partial<ResolveSystemdNodeBinaryDeps> = {}): ResolveSystemdNodeBinaryDeps {
  const existing = new Set([NVM_NODE, "/usr/bin/node", "/opt/node/bin/node"]);
  return {
    env: {},
    homeDir: "/home/u",
    execPath: "/usr/bin/node",
    processVersion: "v24.19.0",
    readNvmrc: () => "24\n",
    listNvmVersions: (dir) => (dir === "/home/u/.nvm/versions/node" ? ["v24.19.0", "v22.23.2"] : []),
    fileExists: (p) => existing.has(p),
    ...over,
  };
}

test("#13136 cenário ssh: execPath=/usr/bin/node, nvm tem a versão do .nvmrc -> ExecStart usa o nvm", () => {
  const r = resolveSystemdNodeBinary(deps());
  assert.equal(r.path, NVM_NODE);
  assert.equal(r.source, "nvm");
});

test("#13136 escolhe a versão mais alta do nvm que casa com o .nvmrc e ignora outro major", () => {
  const r = resolveSystemdNodeBinary(
    deps({
      listNvmVersions: () => ["v22.99.0", "v24.2.0", "v24.19.0", "v24.10.1", "lixo"],
      fileExists: () => true,
    }),
  );
  assert.equal(r.path, "/home/u/.nvm/versions/node/v24.19.0/bin/node");
});

test("#13136 respeita NVM_DIR e pula versão listada sem binário", () => {
  const r = resolveSystemdNodeBinary(
    deps({
      env: { NVM_DIR: "/srv/nvm" },
      listNvmVersions: (dir) => (dir === "/srv/nvm/versions/node" ? ["v24.20.0", "v24.1.0"] : []),
      fileExists: (p) => p === "/srv/nvm/versions/node/v24.1.0/bin/node",
    }),
  );
  assert.equal(r.path, "/srv/nvm/versions/node/v24.1.0/bin/node");
});

test("#13136 sem nvm e node do processo casa com o .nvmrc -> process.execPath (CI)", () => {
  const r = resolveSystemdNodeBinary(deps({ listNvmVersions: () => [], execPath: "/opt/node/bin/node" }));
  assert.equal(r.path, "/opt/node/bin/node");
  assert.equal(r.source, "process-execpath");
});

test("#13136 sem nvm e node do processo fora do .nvmrc -> recusa, nunca assa o node do PATH", () => {
  assert.throws(
    () => resolveSystemdNodeBinary(deps({ listNvmVersions: () => [], processVersion: "v20.20.2" })),
    /Nenhum node que case com o \.nvmrc \("24"\).*--node-bin/s,
  );
});

test("#13136 override: absoluto existente vence o nvm; relativo ou inexistente lança", () => {
  assert.equal(resolveSystemdNodeBinary(deps({ override: "/opt/node/bin/node" })).path, "/opt/node/bin/node");
  assert.equal(
    resolveSystemdNodeBinary(deps({ env: { [NODE_BIN_ENV]: "/opt/node/bin/node" } })).source,
    "override",
  );
  assert.throws(() => resolveSystemdNodeBinary(deps({ override: "node" })), /path absoluto/);
  assert.throws(() => resolveSystemdNodeBinary(deps({ override: "/nao/existe/node" })), /não existe/);
});

test("#13136 sem .nvmrc mantém o comportamento legado (process.execPath)", () => {
  const r = resolveSystemdNodeBinary(deps({ readNvmrc: () => null }));
  assert.equal(r.path, "/usr/bin/node");
  assert.equal(r.source, "process-execpath-sem-nvmrc");
});

test("#13136 .nvmrc não numérico (lts/*) -> recusa em vez de adivinhar", () => {
  assert.throws(() => resolveSystemdNodeBinary(deps({ readNvmrc: () => "lts/*" })), /não é uma versão numérica/);
});

test("#13136 versionMatchesNvmrc casa por prefixo de componentes", () => {
  assert.ok(versionMatchesNvmrc("v24.19.0", "24"));
  assert.ok(versionMatchesNvmrc("v24.19.3", "24.19"));
  assert.ok(versionMatchesNvmrc("v24.19.0", "v24.19.0"));
  assert.ok(!versionMatchesNvmrc("v24.19.0", "v24.19.1"));
  assert.ok(!versionMatchesNvmrc("v240.1.0", "24"));
  assert.ok(!versionMatchesNvmrc("v22.5.0", "24"));
});

test("#13136 .nvmrc real do repo resolve para algum node (nvm ou o do processo) sem lançar", () => {
  // O CI roda o node do .nvmrc (setup-node node-version-file), então o fallback do processo casa.
  assert.doesNotThrow(() => resolveSystemdNodeBinary());
});

const TASK = getScheduledTaskByName("Diaria-Corrupted-Names-Weekly-Check")!;

test("#13136 buildSystemdUnitFiles usa o nodeBin passado no ExecStart", () => {
  const f = buildSystemdUnitFiles(TASK, "/repo", NVM_NODE);
  assert.match(f.serviceContent, new RegExp(`^ExecStart=${NVM_NODE} --import tsx /repo/scripts/run-task\\.ts`, "m"));
  assert.ok(!f.serviceContent.includes("/usr/bin/node"));
});

test("#13136 diffInstalledUnits: igual, divergente (ExecStart/Description) e não instalada", () => {
  const gen = buildSystemdUnitFiles(TASK, "/repo", NVM_NODE);
  const installedDiff = gen.serviceContent
    .replace(NVM_NODE, "/usr/bin/node")
    .replace(/^Description=.*$/m, "Description=antiga");
  const out = diffInstalledUnits(
    [
      { fileName: gen.timerFileName, content: gen.timerContent },
      { fileName: gen.serviceFileName, content: gen.serviceContent },
      { fileName: "x.service", content: "a" },
    ],
    (name) =>
      name === gen.timerFileName ? gen.timerContent + "\n\n" : name === gen.serviceFileName ? installedDiff : null,
  );
  assert.deepEqual(
    out.map((d) => d.status),
    ["same", "differs", "not-installed"],
  );
  const svc = out[1];
  assert.ok(svc.onlyInstalled.some((l) => l.startsWith("ExecStart=/usr/bin/node")));
  assert.ok(svc.onlyInstalled.includes("Description=antiga"));
  assert.ok(svc.onlyGenerated.some((l) => l.startsWith(`ExecStart=${NVM_NODE}`)));
  assert.equal(svc.onlyGenerated.length, 2);
});

function quiet<T>(fn: () => T): T {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("#13136 main: gera com o node resolvido; --diff-installed sai 0/1/2 sem escrever nada", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "setup-13136-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const nodeDeps = {
    resolveNodeBinary: () => ({ path: NVM_NODE, source: "nvm" as const, nvmrc: "24" }),
    resolveVersion: () => "v24.19.0",
  };
  const task = ["--task", TASK.name];

  const outDir = join(tmp, "out");
  assert.equal(quiet(() => main([...task, "--out-dir", outDir], "/repo", nodeDeps)), 0);
  const files = readdirSync(outDir);
  assert.equal(files.length, 2);
  const svcName = files.find((f) => f.endsWith(".service"))!;
  assert.match(readFileSync(join(outDir, svcName), "utf8"), new RegExp(`ExecStart=${NVM_NODE} `));

  const installed = join(tmp, "installed");
  mkdirSync(installed);
  for (const f of files) writeFileSync(join(installed, f), readFileSync(join(outDir, f), "utf8"));
  const diff = [...task, "--diff-installed", "--installed-dir", installed];
  assert.equal(quiet(() => main(diff, "/repo", nodeDeps)), 0);

  const svcPath = join(installed, svcName);
  writeFileSync(svcPath, readFileSync(svcPath, "utf8").replace(NVM_NODE, "/usr/bin/node"));
  assert.equal(quiet(() => main(diff, "/repo", nodeDeps)), 1);
  assert.deepEqual(readdirSync(installed).sort(), [...files].sort(), "diff não escreve na pasta instalada");

  assert.equal(
    quiet(() => main([...task, "--diff-installed", "--installed-dir", join(tmp, "nao-existe")], "/repo", nodeDeps)),
    2,
  );
});

test("#13136 main recusa node resolvido abaixo do piso ou que não responde --version", () => {
  const base = { resolveNodeBinary: () => ({ path: "/usr/bin/node", source: "override" as const, nvmrc: "24" }) };
  const args = ["--task", TASK.name, "--diff-installed", "--installed-dir", tmpdir()];
  assert.equal(quiet(() => main(args, "/repo", { ...base, resolveVersion: () => "v20.20.2" })), 1);
  assert.equal(quiet(() => main(args, "/repo", { ...base, resolveVersion: () => null })), 1);
  assert.equal(
    quiet(() =>
      main(args, "/repo", {
        resolveNodeBinary: () => {
          throw new Error("sem node");
        },
      }),
    ),
    1,
  );
});
