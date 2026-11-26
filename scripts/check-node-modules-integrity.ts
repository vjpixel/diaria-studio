#!/usr/bin/env -S npx tsx
/**
 * check-node-modules-integrity.ts (#14070) — diz se o `node_modules` deste
 * checkout tem pacote instalado pela metade (arquivo de um pacote importando
 * outro arquivo do mesmo pacote que não existe no disco).
 *
 * Caso real: no Neo, `npx knip` saía com `ERR_MODULE_NOT_FOUND
 * node_modules/formatly/lib/types.js`. Os 9 arquivos de 0 byte do
 * `node_modules` principal tinham sumido de uma vez em 08/11/2026, e o
 * `npm install` não repõe arquivo de pacote já instalado. Diagnóstico e
 * reparo: `scripts/lib/node-modules-integrity.ts` e `docs/setup.md`.
 *
 * Só lê: importa cada dependência direta (`dependencies` + `devDependencies`
 * do `package.json`) num processo filho, com cwd na raiz, e classifica a
 * falha. Não instala nem apaga nada; imprime o comando de reparo.
 *
 * Uso: npx tsx scripts/check-node-modules-integrity.ts [--root DIR] [--json]
 * Exit: 0 = íntegro; 1 = pacote pela metade; 2 = sem node_modules/package.json
 *       ou probe que não rodou.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  classifyImportProbe,
  formatIntegrityReport,
  type ImportProbe,
  type ImportVerdict,
} from "./lib/node-modules-integrity.ts";

/** Probe que roda no filho: importa cada pacote e devolve JSON por linha. */
const PROBE_SOURCE = `
const pkgs = JSON.parse(process.env.NM_INTEGRITY_PKGS || "[]");
const out = [];
for (const pkg of pkgs) {
  try {
    await import(pkg);
    out.push({ pkg, ok: true });
  } catch (e) {
    out.push({ pkg, ok: false, code: e && e.code, message: String(e && e.message || e), requireStack: e && e.requireStack });
  }
}
process.stdout.write("\\n__NM_INTEGRITY__" + JSON.stringify(out) + "\\n");
process.exit(0);
`;

function directDependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

function probeImports(root: string, pkgs: string[], timeoutMs = 120_000): ImportProbe[] {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_SOURCE], {
    cwd: root,
    env: { ...process.env, NM_INTEGRITY_PKGS: JSON.stringify(pkgs) },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const marker = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("__NM_INTEGRITY__"));
  if (!marker) {
    throw new Error(
      `probe de importação não devolveu resultado (status ${r.status}, sinal ${r.signal ?? "-"}): ${(r.stderr ?? "").slice(0, 500)}`,
    );
  }
  return JSON.parse(marker.slice("__NM_INTEGRITY__".length)) as ImportProbe[];
}

export function checkNodeModulesIntegrity(root: string): ImportVerdict[] {
  const nodeModulesDir = join(root, "node_modules");
  const probes = probeImports(root, directDependencies(root));
  return probes.map((p) => classifyImportProbe(p, nodeModulesDir));
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.values["root"] ?? process.cwd());
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "node_modules"))) {
    console.error(`[check-node-modules-integrity] ${root} sem package.json ou node_modules (rodar npm ci).`);
    return 2;
  }
  let verdicts: ImportVerdict[];
  try {
    verdicts = checkNodeModulesIntegrity(root);
  } catch (e) {
    console.error(`[check-node-modules-integrity] ${(e as Error).message}`);
    return 2;
  }
  if (args.flags.has("json")) console.log(JSON.stringify(verdicts, null, 2));
  else console.log(formatIntegrityReport(verdicts));
  return verdicts.some((v) => v.kind === "broken") ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
