/**
 * test/worker-import-closure.test.ts (#10637)
 *
 * Unidade de `scripts/lib/worker-import-closure.ts`: fecho de imports de um
 * Worker a partir do `main`, parse de `on.push.paths` e casamento de
 * filtros do Actions. O guard de conjunto que usa isso contra o repo real
 * vive em `test/workers-deploy-workflow-coverage.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  actionsPathPatternToRegExp,
  computeWorkerExternalImports,
  extractPushPaths,
  extractRelativeSpecifiers,
  uncoveredByPaths,
} from "../scripts/lib/worker-import-closure.ts";

describe("extractRelativeSpecifiers", () => {
  it("pega import/export nomeado, multi-linha, side-effect e dinâmico; ignora pacote", () => {
    const src = [
      `import { a } from "./a.ts";`,
      `import {`,
      `  b,`,
      `  c,`,
      `} from '../../scripts/lib/b.ts';`,
      `import type { T } from "./types.ts";`,
      `export * from "./re.ts";`,
      `import "./side.ts";`,
      `const m = await import("./dyn.ts");`,
      `import { Hono } from "hono";`,
    ].join("\n");
    assert.deepEqual(extractRelativeSpecifiers(src).sort(), [
      "../../scripts/lib/b.ts",
      "./a.ts",
      "./dyn.ts",
      "./re.ts",
      "./side.ts",
      "./types.ts",
    ]);
  });

  it("não engole o import seguinte a um `export type` sem ponto-e-vírgula", () => {
    const src = `export type A = { x: string }\nimport { y } from "../lib/y.ts"\n`;
    assert.deepEqual(extractRelativeSpecifiers(src), ["../lib/y.ts"]);
  });
});

describe("computeWorkerExternalImports (fixture)", () => {
  let root: string;
  const write = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "worker-closure-"));
    write("workers/w/wrangler.toml", `name = "w"\nmain = "src/index.ts"\n`);
    write("workers/w/src/index.ts", `import { h } from "./helper.ts";\nimport { s } from "../../../scripts/lib/shared/s.ts";\n`);
    write("workers/w/src/helper.ts", `import { r } from "../../../scripts/lib/root.js";\n`);
    // transitivo: shared/s importa outro módulo e um arquivo de outro worker
    write("scripts/lib/shared/s.ts", `import { t } from "./t.ts";\nimport { m } from "../../../workers/other/src/meta.ts";\n`);
    write("scripts/lib/shared/t.ts", `export const t = 1;\n`);
    write("scripts/lib/root.ts", `export const r = 1;\n`);
    write("workers/other/src/meta.ts", `export const m = 1;\n`);
    // fora do grafo: não pode entrar
    write("scripts/lib/unused.ts", `export const u = 1;\n`);
    write("workers/w/src/orphan.test.ts", `import { u } from "../../../scripts/lib/unused.ts";\n`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("segue o grafo a partir do main, inclusive dentro de scripts/lib e `.js` → `.ts`", () => {
    const { external, unresolved } = computeWorkerExternalImports(root, "w");
    assert.deepEqual(external, [
      "scripts/lib/root.ts",
      "scripts/lib/shared/s.ts",
      "scripts/lib/shared/t.ts",
      "workers/other/src/meta.ts",
    ]);
    assert.deepEqual(unresolved, []);
  });

  it("reporta import relativo que não resolve, em vez de encolher o fecho em silêncio", () => {
    write("workers/w/src/helper.ts", `import { r } from "../../../scripts/lib/sumiu.ts";\n`);
    const { unresolved } = computeWorkerExternalImports(root, "w");
    assert.deepEqual(unresolved, ["workers/w/src/helper.ts: ../../../scripts/lib/sumiu.ts"]);
  });
});

describe("extractPushPaths", () => {
  it("lê on.push.paths, ignora comentários e não vaza para outros blocos", () => {
    const yml = [
      "name: x",
      "on:",
      "  push:",
      "    branches: [master]",
      "    paths:",
      "      - 'workers/w/**'",
      "      # comentário no meio",
      '      - "scripts/lib/a.ts"',
      "      - scripts/lib/shared/**",
      "  workflow_dispatch:",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - 'não-é-path'",
    ].join("\n");
    assert.deepEqual(extractPushPaths(yml), ["workers/w/**", "scripts/lib/a.ts", "scripts/lib/shared/**"]);
  });

  it("workflow sem push.paths devolve []", () => {
    assert.deepEqual(extractPushPaths("on:\n  schedule:\n    - cron: '1 * * * *'\n"), []);
  });
});

describe("uncoveredByPaths — caso OK e caso faltando", () => {
  const imports = ["scripts/lib/shared/s.ts", "scripts/lib/shared/sub/t.ts", "scripts/lib/root.ts"];

  it("OK: glob de diretório + arquivo explícito cobrem tudo", () => {
    assert.deepEqual(uncoveredByPaths(imports, ["workers/w/**", "scripts/lib/shared/**", "scripts/lib/root.ts"]), []);
  });

  it("faltando: import fora de qualquer filtro é reportado", () => {
    assert.deepEqual(uncoveredByPaths(imports, ["workers/w/**", "scripts/lib/shared/**"]), ["scripts/lib/root.ts"]);
  });

  it("`*` não atravessa `/`; negação posterior exclui", () => {
    assert.deepEqual(uncoveredByPaths(imports, ["scripts/lib/shared/*", "scripts/lib/root.ts"]), ["scripts/lib/shared/sub/t.ts"]);
    assert.deepEqual(uncoveredByPaths(imports, ["scripts/lib/**", "!scripts/lib/root.ts"]), ["scripts/lib/root.ts"]);
  });

  it("ponto no padrão é literal", () => {
    assert.equal(actionsPathPatternToRegExp("scripts/lib/a.ts").test("scripts/lib/aXts"), false);
  });
});
