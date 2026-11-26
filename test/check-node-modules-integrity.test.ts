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

describe("classifyImportProbe (#14070)", () => {
  it("arquivo interno ausente importado por arquivo do pacote = broken", () => {
    const missing = join(NM, "formatly", "lib", "types.js");
    const importer = join(NM, "formatly", "lib", "index.js");
    const v = classifyImportProbe(
      {
        pkg: "knip",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
        message: `Cannot find module '${missing}' imported from ${importer}`,
      },
      NM,
    );
    assert.equal(v.kind, "broken");
    assert.ok(v.kind === "broken" && v.brokenPackage === "formatly" && v.missing === missing);
  });
  it("pacote só de tipos (importado pelo probe) não é broken", () => {
    const v = classifyImportProbe(
      {
        pkg: "@types/node",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
        message: `Cannot find package '${join(NM, "@types", "node")}' imported from ${join(tmpdir(), "fake-root-14070", "[eval1]")}`,
      },
      NM,
    );
    assert.equal(v.kind, "not-importable");
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

describe("checkNodeModulesIntegrity — node_modules real em disco (#14070)", () => {
  const root = mkdtempSync(join(tmpdir(), "nm-integrity-14070-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const nm = join(root, "node_modules");
  const write = (rel: string, body: string) => {
    const p = join(nm, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", private: true, dependencies: { "esm-half": "1", "cjs-half": "1" }, devDependencies: { "@types/only": "1" } }),
  );
  // ESM como o formatly: index.js importa ./types.js, que sumiu.
  write("esm-half/package.json", JSON.stringify({ name: "esm-half", type: "module", main: "lib/index.js" }));
  write("esm-half/lib/index.js", 'export * from "./types.js";\nexport const x = 1;\n');
  // CJS: require de arquivo interno ausente.
  write("cjs-half/package.json", JSON.stringify({ name: "cjs-half", main: "index.js" }));
  write("cjs-half/index.js", 'module.exports = require("./types.js");\n');
  // Só tipos, sem entrada JS.
  write("@types/only/package.json", JSON.stringify({ name: "@types/only", types: "index.d.ts" }));
  write("@types/only/index.d.ts", "export {};\n");

  it("denuncia os dois pacotes pela metade e não o de tipos", () => {
    const verdicts = checkNodeModulesIntegrity(root);
    const byPkg = Object.fromEntries(verdicts.map((v) => [v.pkg, v]));
    assert.equal(byPkg["esm-half"].kind, "broken");
    assert.equal(byPkg["cjs-half"].kind, "broken");
    assert.equal(byPkg["@types/only"].kind, "not-importable");
    const report = formatIntegrityReport(verdicts);
    assert.match(report, /rm -rf node_modules\/cjs-half node_modules\/esm-half && npm install/);
    assert.ok(
      report.includes("Remove-Item -Recurse -Force node_modules\\cjs-half, node_modules\\esm-half; npm install"),
      "o relatório traz também a forma PowerShell",
    );
  });

  it("com o arquivo reposto (como o 0 byte de um clone novo), fica íntegro", () => {
    write("esm-half/lib/types.js", "");
    write("cjs-half/types.js", "");
    const verdicts = checkNodeModulesIntegrity(root);
    assert.deepEqual(
      verdicts.filter((v) => v.kind === "broken"),
      [],
    );
    assert.match(formatIntegrityReport(verdicts), /íntegro/);
  });
});
