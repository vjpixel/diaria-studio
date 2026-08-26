/**
 * main-module-guard.test.ts (#6191)
 *
 * Regressão do no-op silencioso de `route-issue.ts` no Windows.
 *
 * O guard "sou o módulo principal?" tem uma forma ingênua que parece correta
 * e é **sempre falsa no Windows**:
 *
 *   import.meta.url === `file://${process.argv[1]}`
 *
 * `process.argv[1]` chega como `C:\...\route-issue.ts` (barra invertida, com
 * letra de unidade) enquanto `import.meta.url` chega como
 * `file:///C:/.../route-issue.ts` (três barras, barra normal). Nunca casam.
 *
 * Consequência medida ao vivo em 26/08/2026, na máquina do editor:
 * `npx tsx scripts/route-issue.ts --issue 6187 --track overnight` saiu com
 * **exit 0, sem imprimir nada e sem mudar nenhuma label** — o pior desfecho
 * possível pro verbo que existe justamente pra garantir que a escrita de
 * label aconteceu (o passo 4 dele revalida com `classifyExecTrack` e falha
 * ruidosamente; nada disso rodava). Em Linux a forma ingênua funciona por
 * acidente (`file://` + `/home/...` = `file:///home/...`), então o bug era
 * invisível no `helios` e só aparecia onde o editor roda.
 *
 * O helper canônico `isMainModule` (`scripts/lib/cli-args.ts`) normaliza via
 * `fileURLToPath` e já é usado por centenas de scripts deste repo. Este teste
 * trava as duas pontas: o helper funciona, e nenhum script volta a escrever o
 * guard à mão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../scripts/lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

/** Qualquer comparação de `import.meta.url` contra um template `file://...`
 * montado à mão. Cobre as variantes já vistas no repo — `file://${argv1}` e
 * `file:///${argv1.replace(...)}` — sem depender do nome da variável. */
const RAW_GUARD_RE = /import\.meta\.url\s*===\s*`file:\/\//;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("isMainModule (#6191)", () => {
  it("reconhece o próprio arquivo quando argv[1] é o caminho nativo do SO", () => {
    const nativePath = fileURLToPath(import.meta.url);
    const original = process.argv[1];
    try {
      process.argv[1] = nativePath;
      assert.equal(isMainModule(import.meta.url), true);
    } finally {
      process.argv[1] = original;
    }
  });

  it("devolve false quando argv[1] é outro arquivo", () => {
    const original = process.argv[1];
    try {
      process.argv[1] = join(SCRIPTS, "outro-script-qualquer.ts");
      assert.equal(isMainModule(import.meta.url), false);
    } finally {
      process.argv[1] = original;
    }
  });

  it("a forma ingênua que este teste existe pra banir de fato falha no Windows", () => {
    // Reproduz o bug em vez de só afirmar que ele existia: com um argv[1] no
    // formato do Windows, o template cru diverge e `isMainModule` não.
    const windowsArgv1 = "C:\\Users\\ed\\Projects\\diaria-studio\\scripts\\route-issue.ts";
    const metaUrl = pathToFileURL(windowsArgv1).href; // file:///C:/Users/...
    assert.notEqual(metaUrl, `file://${windowsArgv1}`);

    const original = process.argv[1];
    try {
      process.argv[1] = windowsArgv1;
      assert.equal(isMainModule(metaUrl), true);
    } finally {
      process.argv[1] = original;
    }
  });
});

describe("nenhum script monta o guard de main module à mão (#6191)", () => {
  it("scripts/**/*.ts usam isMainModule, não template `file://`", () => {
    const offenders = walkTsFiles(SCRIPTS)
      .filter((f) => RAW_GUARD_RE.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1).replaceAll("\\", "/"));

    assert.deepEqual(
      offenders,
      [],
      `Guard de main module montado à mão (falha silenciosamente no Windows) em:\n` +
        offenders.map((f) => `  - ${f}`).join("\n") +
        `\nUse: import { isMainModule } from "./lib/cli-args.ts"; if (isMainModule(import.meta.url)) { ... }`,
    );
  });
});
