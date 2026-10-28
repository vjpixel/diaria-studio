/**
 * test/getarg-nullish-fallback-11472.test.ts (#11472)
 *
 * `getArg` (`scripts/lib/cli-args.ts`) devolve `""` quando a flag está
 * ausente, nunca `undefined`. Então `getArg(argv, "x") ?? default` nunca cai
 * no default. Foi o que derrubou toda execução do timer
 * `Diaria-Short-Related-Missed-Alarm`: chamado sem `--edition`, o script lia
 * `""`, pulava o fallback para a edição de hoje e morria em
 * `--edition inválido: ""`.
 *
 * Dois blocos:
 *  1. Regressão direta: `resolveAlarmEdition` sem `--edition` resolve a data
 *     BRT de hoje (falhava antes do fix).
 *  2. Guard estrutural (mesmo molde de `getarg-numeric-guard-4573.test.ts`):
 *     nenhum arquivo em `scripts/` que importa `getArg` de `cli-args.ts` pode
 *     usar `??` sobre o resultado dele, nem inline nem via variável atribuída
 *     direto de `getArg(...)`. A correção é `getStringArg`/`getIntArg`
 *     (`undefined` quando ausente) ou `||`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAlarmEdition } from "../scripts/short-related-missed-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

describe("resolveAlarmEdition (#11472)", () => {
  // 2026-10-28T02:00Z = 27/10 23:00 BRT: confere que o "hoje" é o de BRT.
  const NOW = new Date("2026-10-28T02:00:00.000Z");

  it("sem --edition usa a edição de hoje em BRT (o caso do timer)", () => {
    assert.equal(resolveAlarmEdition([], NOW), "261027");
    assert.equal(resolveAlarmEdition(["--dry-run"], NOW), "261027");
  });

  it("com --edition usa a edição passada", () => {
    assert.equal(resolveAlarmEdition(["--edition", "261020"], NOW), "261020");
    assert.equal(resolveAlarmEdition(["--edition=261021", "--dry-run"], NOW), "261021");
  });

  it("--edition sem valor ou vazio lança, em vez de virar 'hoje' em silêncio", () => {
    assert.throws(() => resolveAlarmEdition(["--edition"], NOW), /sem valor/);
    assert.throws(() => resolveAlarmEdition(["--edition", "--dry-run"], NOW), /sem valor/);
    assert.throws(() => resolveAlarmEdition(["--edition="], NOW), /vazio/);
  });

  it("--edition fora do formato AAMMDD lança", () => {
    assert.throws(() => resolveAlarmEdition(["--edition", "2026-10-27"], NOW), /--edition inválido/);
  });
});

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => join(dir, f));
}

/** Arquivo usa o `getArg` de `cli-args.ts` (e não um `getArg` local). */
function importsCliGetArg(src: string): boolean {
  return /import\s*\{[^}]*\bgetArg\b[^}]*\}\s*from\s*["'][^"']*cli-args(\.ts)?["']/.test(src);
}

/** Remove comentários de linha e bloco (aproximação, suficiente pro grep). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function findNullishGetArgUsages(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  for (const m of code.matchAll(/getArg\([^()]*\)\s*\?\?/g)) hits.push(m[0].replace(/\s+/g, " "));
  const vars = new Set([...code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*getArg\([^()]*\)\s*;/g)].map((m) => m[1]));
  for (const v of vars) {
    // Declarações de `v` em ordem; cada `v ??` é julgado pela declaração mais
    // próxima ANTES dele (o mesmo nome reaparece em blocos diferentes, e só a
    // atribuição crua de `getArg` é o defeito — `getArg(...) || undefined` é
    // a forma correta).
    const decls = [...code.matchAll(new RegExp(`(?:const|let)\\s+${v}\\s*=\\s*([^;]*);`, "g"))].map((m) => ({
      at: m.index ?? 0,
      bare: /^getArg\([^()]*\)\s*$/.test(m[1].trim()),
    }));
    for (const m of code.matchAll(new RegExp(`(?<![.\\w])${v}\\s*\\?\\?`, "g"))) {
      const decl = decls.filter((d) => d.at < (m.index ?? 0)).pop();
      if (decl?.bare) hits.push(m[0]);
    }
  }
  return hits;
}

describe("guard: getArg(...) ?? nunca cai no fallback (#11472)", () => {
  it("detector pega a forma inline e a desacoplada, e ignora as corretas", () => {
    assert.deepEqual(findNullishGetArgUsages(`const a = getArg(argv, "x") ?? "d";`), [`getArg(argv, "x") ??`]);
    assert.equal(findNullishGetArgUsages(`const a = getArg(argv, "x");\nconst b = a ?? "d";`).length, 1);
    assert.equal(findNullishGetArgUsages(`const a = getArg(argv, "x") || "d";`).length, 0);
    assert.equal(findNullishGetArgUsages(`const a = getArg(argv, "x") || undefined;\nconst b = a ?? 1;`).length, 0);
    assert.equal(findNullishGetArgUsages(`const a = getArg(argv, "x");\nconst b = opts.a ?? 1;`).length, 0);
    // Mesmo nome em blocos diferentes: vale a declaração mais próxima.
    assert.equal(
      findNullishGetArgUsages(`{ const a = getArg(argv, "x"); }\n{ const a = getArg(argv, "x") || undefined; f(a ?? 1); }`).length,
      0,
    );
    assert.equal(findNullishGetArgUsages(`// getArg(argv, "x") ?? d`).length, 0);
  });

  it("nenhum script em scripts/ usa ?? sobre o resultado de getArg", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SCRIPTS_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!importsCliGetArg(src)) continue;
      for (const hit of findNullishGetArgUsages(src)) offenders.push(`${relative(ROOT, file)}: ${hit}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `getArg devolve "" quando a flag falta, então "??" nunca usa o fallback. ` +
        `Use getStringArg/getIntArg (undefined quando ausente) ou "||":\n${offenders.join("\n")}`,
    );
  });
});
