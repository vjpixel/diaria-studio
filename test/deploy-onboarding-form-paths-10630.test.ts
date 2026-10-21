/**
 * test/deploy-onboarding-form-paths-10630.test.ts (#10630)
 *
 * O Worker `workers/onboarding-form` importa módulos de fora do próprio
 * diretório (hoje `scripts/lib/onboarding-form-contract.ts`). O filtro
 * `on.push.paths` de `.github/workflows/deploy-onboarding-form.yml` cobria só
 * `workers/onboarding-form/**`: mudar o contrato atualizava o executor e
 * deixava o Worker publicado na versão antiga.
 *
 * Guard: todo import relativo de `workers/onboarding-form/src/*.ts` que sai do
 * diretório do Worker precisa estar listado no `paths` do workflow. Deriva os
 * imports do código, não de uma lista à mão — um import novo de fora quebra o
 * teste até entrar no `paths`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers/onboarding-form");
const SRC_DIR = resolve(WORKER_DIR, "src");
const WORKFLOW = resolve(ROOT, ".github/workflows/deploy-onboarding-form.yml");

/** Imports relativos dos .ts do src que resolvem fora do diretório do Worker (paths relativos à raiz). */
function externalImports(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(SRC_DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(resolve(SRC_DIR, f), "utf8");
    for (const m of src.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const abs = resolve(SRC_DIR, m[1]);
      // relative() e não startsWith(dir + "/"): no Windows o path vem com "\\" e
      // todo import local (ex: ./render.ts, #10605) contaria como externo.
      const rel = relative(WORKER_DIR, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        out.add(relative(ROOT, abs).split("\\").join("/"));
      }
    }
  }
  return [...out].sort();
}

/** Entradas de `on.push.paths` (parse mínimo: itens `- '...'` logo abaixo de `paths:`). */
function pushPaths(): string[] {
  const lines = readFileSync(WORKFLOW, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s+paths:\s*$/.test(l));
  assert.ok(start >= 0, "workflow sem `paths:`");
  const items: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#/.test(l) || l.trim() === "") continue;
    const m = l.match(/^\s+-\s+['"]?([^'"]+?)['"]?\s*$/);
    if (!m) break;
    items.push(m[1]);
  }
  return items;
}

describe("deploy-onboarding-form: paths cobre o que o Worker importa (#10630)", () => {
  it("o Worker importa o contrato de fora do diretório (sanidade do detector)", () => {
    assert.ok(externalImports().includes("scripts/lib/onboarding-form-contract.ts"));
  });

  it("todo import externo do Worker está no `paths` do workflow", () => {
    const paths = pushPaths();
    assert.ok(paths.includes("workers/onboarding-form/**"));
    const missing = externalImports().filter((p) => !paths.includes(p));
    assert.deepEqual(missing, [], `faltam no paths de deploy-onboarding-form.yml: ${missing.join(", ")}`);
  });
});
