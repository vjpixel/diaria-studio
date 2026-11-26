#!/usr/bin/env -S npx tsx
/**
 * check-node-modules-integrity.ts (#14070) — diz se o `node_modules` deste
 * checkout tem pacote instalado pela metade: arquivo interno faltando, entrada
 * declarada (`main`/`exports`) faltando ou binário nativo que não carrega.
 *
 * Caso real: no Neo, `npx knip` saía com `ERR_MODULE_NOT_FOUND
 * node_modules/formatly/lib/types.js`. Os 9 arquivos de 0 byte do
 * `node_modules` principal tinham sumido de uma vez em 08/11/2026, e o
 * `npm install` não repõe arquivo de pacote já instalado. Diagnóstico e
 * reparo: `scripts/lib/node-modules-integrity.ts` e `docs/setup.md`.
 *
 * Importa cada dependência direta (`dependencies` + `devDependencies` do
 * `package.json`) num processo filho PRÓPRIO, com cwd na raiz: um import que
 * derrube o processo (crash, `process.exit`, timeout) aparece com o nome do
 * pacote, sem levar os outros junto. Não instala nem apaga nada (importar
 * carrega binário nativo, mas não escreve no disco); imprime o reparo.
 *
 * Uso: npx tsx scripts/check-node-modules-integrity.ts [--root DIR] [--json]
 * Exit: 0 = íntegro; 1 = pacote pela metade ou import que derrubou o processo;
 *       2 = sem node_modules/package.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  classifyImportProbe,
  formatIntegrityReport,
  hasFailure,
  manifestDeclaresEntry,
  type ImportProbe,
  type ImportVerdict,
} from "./lib/node-modules-integrity.ts";

const MARKER = "__NM_INTEGRITY__";

/** Probe que roda no filho: importa UM pacote e grava o resultado numa linha. */
const PROBE_SOURCE = `
const pkg = process.env.NM_INTEGRITY_PKG;
let out;
try {
  await import(pkg);
  out = { pkg, ok: true };
} catch (e) {
  out = { pkg, ok: false, code: e && e.code, message: String((e && e.message) || e), requireStack: e && e.requireStack };
}
process.stdout.write("\\n${MARKER}" + JSON.stringify(out) + "\\n");
process.exit(0);
`;

function directDependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

function readManifest(root: string, pkg: string): { main?: unknown; exports?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", pkg, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function probeImport(root: string, pkg: string, timeoutMs: number): ImportProbe {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_SOURCE], {
    cwd: root,
    env: { ...process.env, NM_INTEGRITY_PKG: pkg },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const declaresEntry = manifestDeclaresEntry(readManifest(root, pkg));
  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (!line) {
    return {
      pkg,
      ok: false,
      declaresEntry,
      crashed: { status: r.status, signal: r.signal ?? (r.error ? String(r.error.message) : null), stderr: r.stderr ?? "" },
    };
  }
  return { ...(JSON.parse(line.slice(MARKER.length)) as ImportProbe), declaresEntry };
}

export function checkNodeModulesIntegrity(root: string, timeoutMs = 60_000): ImportVerdict[] {
  const nodeModulesDir = join(root, "node_modules");
  return directDependencies(root).map((pkg) => classifyImportProbe(probeImport(root, pkg, timeoutMs), nodeModulesDir));
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.values["root"] ?? process.cwd());
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "node_modules"))) {
    console.error(`[check-node-modules-integrity] ${root} sem package.json ou node_modules (rodar npm ci).`);
    return 2;
  }
  const verdicts = checkNodeModulesIntegrity(root);
  if (args.flags.has("json")) console.log(JSON.stringify(verdicts, null, 2));
  else console.log(formatIntegrityReport(verdicts));
  return hasFailure(verdicts) ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
