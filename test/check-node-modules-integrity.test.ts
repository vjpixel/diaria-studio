/**
 * #14070 — `npx knip` quebrava no Neo com `ERR_MODULE_NOT_FOUND
 * node_modules/formatly/lib/types.js`: arquivo de 0 byte sumido de um pacote
 * já instalado, que o `npm install` não repõe. O check tem que denunciar esse
 * caso e não confundir com pacote só de tipos (`@types/node`).
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkNodeModulesIntegrity } from "../scripts/check-node-modules-integrity.ts";
import {
  classifyImportProbe,
  formatIntegrityReport,
  hasFailure,
  manifestDeclaresEntry,
  packageNameFromPath,
  repairCommand,
  repairCommandPowerShell,
} from "../scripts/lib/node-modules-integrity.ts";

const NM = join(tmpdir(), "fake-root-14070", "node_modules");

describe("packageNameFromPath (#14070)", () => {
  it("pacote simples, escopado e aninhado", () => {
    assert.equal(packageNameFromPath(join(NM, "formatly", "lib", "index.js"), NM), "formatly");
    assert.equal(packageNameFromPath(join(NM, "@poppinss", "dumper", "build", "src", "types.js"), NM), "@poppinss/dumper");
    assert.equal(packageNameFromPath(join(NM, "knip", "node_modules", "formatly", "lib", "index.js"), NM), "formatly");
  });
  it("fora do node_modules devolve null", () => {
    assert.equal(packageNameFromPath(join(tmpdir(), "fake-root-14070", "[eval1]"), NM), null);
  });
});

const PROBE_IMPORTER = join(tmpdir(), "fake-root-14070", "[eval1]");

describe("classifyImportProbe (#14070)", () => {
  it("arquivo interno ausente importado por arquivo do pacote = broken", () => {
    const missing = join(NM, "formatly", "lib", "types.js");
    const importer = join(NM, "formatly", "lib", "index.js");
    const v = classifyImportProbe(
      { pkg: "knip", ok: false, code: "ERR_MODULE_NOT_FOUND", message: `Cannot find module '${missing}' imported from ${importer}` },
      NM,
    );
    assert.ok(v.kind === "broken" && v.brokenPackages[0] === "formatly" && v.missing === missing);
  });
  it("pacote só de tipos (sem entrada declarada) não é broken, nem com o index.js implícito", () => {
    for (const missing of [join(NM, "@types", "node"), join(NM, "@types", "only", "index.js")]) {
      const v = classifyImportProbe(
        {
          pkg: "@types/node",
          ok: false,
          code: "ERR_MODULE_NOT_FOUND",
          message: `Cannot find package '${missing}' imported from ${PROBE_IMPORTER}`,
          declaresEntry: false,
        },
        NM,
      );
      assert.equal(v.kind, "not-importable");
    }
  });
  it("entrada declarada faltando = broken; a pasta do próprio pacote não", () => {
    const entry = join(NM, "m-miss", "lib", "index.js");
    const v = classifyImportProbe(
      { pkg: "m-miss", ok: false, code: "ERR_MODULE_NOT_FOUND", message: `Cannot find package '${entry}' imported from ${PROBE_IMPORTER}`, declaresEntry: true },
      NM,
    );
    assert.ok(v.kind === "broken" && v.brokenPackages[0] === "m-miss" && v.missing === entry);
    const root = classifyImportProbe(
      { pkg: "m-miss", ok: false, code: "ERR_MODULE_NOT_FOUND", message: `Cannot find package '${join(NM, "m-miss")}' imported from ${PROBE_IMPORTER}`, declaresEntry: true },
      NM,
    );
    assert.equal(root.kind, "not-importable");
  });
  it("ERR_DLOPEN_FAILED = broken, dono do .node incluído no reparo", () => {
    const native = join(NM, "nat", "build", "nat.node");
    const v = classifyImportProbe({ pkg: "nat", ok: false, code: "ERR_DLOPEN_FAILED", message: `${native} is not a valid Win32 application.` }, NM);
    assert.ok(v.kind === "broken" && v.brokenPackages.includes("nat"));
  });
  it("erro próprio do sharp sem o .node = broken, com o pacote da plataforma", () => {
    const v = classifyImportProbe(
      { pkg: "sharp", ok: false, message: 'Could not load the "sharp" module using the win32-x64 runtime\nPossible solutions:' },
      NM,
    );
    assert.ok(v.kind === "broken");
    assert.deepEqual(v.kind === "broken" && [...v.brokenPackages].sort(), ["@img/sharp-win32-x64", "sharp"]);
  });
  it("processo filho sem resultado = crashed, com o nome do pacote", () => {
    const v = classifyImportProbe({ pkg: "boom", ok: false, crashed: { status: 3, signal: null, stderr: "" } }, NM);
    assert.equal(v.kind, "crashed");
    assert.match(formatIntegrityReport([v]), /\[FALHA\] boom: o import encerrou o processo \(status 3/);
  });
});

describe("manifestDeclaresEntry (#14070)", () => {
  it("main vazio (@types/node) não declara; main ou exports declaram", () => {
    assert.equal(manifestDeclaresEntry({ main: "" }), false);
    assert.equal(manifestDeclaresEntry({}), false);
    assert.equal(manifestDeclaresEntry(null), false);
    assert.equal(manifestDeclaresEntry({ main: "lib/index.js" }), true);
    assert.equal(manifestDeclaresEntry({ exports: { ".": "./dist/index.js" } }), true);
  });
});

describe("repairCommand (#14070)", () => {
  it("apaga só os pacotes quebrados, dedup e ordenado, e reinstala", () => {
    assert.equal(
      repairCommand(["formatly", "@poppinss/dumper", "formatly"]),
      "rm -rf node_modules/@poppinss/dumper node_modules/formatly && npm install",
    );
  });
  it("forma PowerShell (shell padrão do Neo): Remove-Item com lista por vírgula e `;`", () => {
    assert.equal(
      repairCommandPowerShell(["formatly", "@poppinss/dumper", "formatly"]),
      "Remove-Item -Recurse -Force node_modules\\@poppinss\\dumper, node_modules\\formatly; npm install",
    );
    assert.equal(repairCommandPowerShell(["formatly"]), "Remove-Item -Recurse -Force node_modules\\formatly; npm install");
  });
});

/** Monta um checkout falso com `node_modules` em disco. */
function fixtureRoot(deps: string[], files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nm-integrity-14070-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, dependencies: Object.fromEntries(deps.map((d) => [d, "1"])) }));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, "node_modules", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const pj = (o: object) => JSON.stringify(o);

describe("checkNodeModulesIntegrity — node_modules real em disco (#14070)", () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  const files: Record<string, string> = {
    // ESM como o formatly: index.js importa ./types.js, que sumiu.
    "esm-half/package.json": pj({ name: "esm-half", type: "module", main: "lib/index.js" }),
    "esm-half/lib/index.js": 'export * from "./types.js";\nexport const x = 1;\n',
    // CJS: require de arquivo interno ausente.
    "cjs-half/package.json": pj({ name: "cjs-half", main: "index.js" }),
    "cjs-half/index.js": 'module.exports = require("./types.js");\n',
    // Entrada declarada sumida: por `main` e por `exports`.
    "main-miss/package.json": pj({ name: "main-miss", type: "module", main: "lib/index.js" }),
    "exports-miss/package.json": pj({ name: "exports-miss", type: "module", exports: { ".": "./dist/index.js" } }),
    // Binário nativo corrompido (bytes que não são um .node).
    "native-bad/package.json": pj({ name: "native-bad", main: "index.js" }),
    "native-bad/index.js": 'module.exports = require("./build/native-bad.node");\n',
    "native-bad/build/native-bad.node": "isto nao e um binario",
    // Import que derruba o processo.
    "crash-pkg/package.json": pj({ name: "crash-pkg", main: "index.js" }),
    "crash-pkg/index.js": "process.exit(3);\n",
    // Só tipos, com `main: ""` como o @types/node.
    "@types/only/package.json": pj({ name: "@types/only", main: "", types: "index.d.ts" }),
    "@types/only/index.d.ts": "export {};\n",
  };
  const deps = ["esm-half", "cjs-half", "main-miss", "exports-miss", "native-bad", "crash-pkg", "@types/only"];

  it("denuncia cada defeito pelo nome do pacote e não reprova o de tipos", () => {
    const root = fixtureRoot(deps, files);
    roots.push(root);
    const verdicts = checkNodeModulesIntegrity(root);
    const byPkg = Object.fromEntries(verdicts.map((v) => [v.pkg, v]));
    for (const p of ["esm-half", "cjs-half", "main-miss", "exports-miss", "native-bad"]) {
      assert.equal(byPkg[p].kind, "broken", `${p}: ${JSON.stringify(byPkg[p])}`);
    }
    assert.equal(byPkg["crash-pkg"].kind, "crashed");
    assert.equal(byPkg["@types/only"].kind, "not-importable");
    assert.ok(hasFailure(verdicts));
    const report = formatIntegrityReport(verdicts);
    assert.match(
      report,
      /rm -rf node_modules\/cjs-half node_modules\/esm-half node_modules\/exports-miss node_modules\/main-miss node_modules\/native-bad && npm install/,
    );
    assert.ok(report.includes("Remove-Item -Recurse -Force node_modules\\cjs-half, node_modules\\esm-half"), "forma PowerShell");
    assert.match(report, /\[FALHA\] crash-pkg: o import encerrou o processo/);
  });

  it("com os arquivos repostos (como o 0 byte de um clone novo), fica íntegro", () => {
    const fixed = ["esm-half", "cjs-half", "main-miss", "exports-miss", "@types/only"];
    const root = fixtureRoot(fixed, {
      ...files,
      "esm-half/lib/types.js": "",
      "cjs-half/types.js": "",
      "main-miss/lib/index.js": "export const y = 1;\n",
      "exports-miss/dist/index.js": "export const z = 1;\n",
    });
    roots.push(root);
    const verdicts = checkNodeModulesIntegrity(root);
    assert.equal(hasFailure(verdicts), false, JSON.stringify(verdicts));
    assert.match(formatIntegrityReport(verdicts), /íntegro/);
  });
});

