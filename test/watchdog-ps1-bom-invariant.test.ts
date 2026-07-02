/**
 * test/watchdog-ps1-bom-invariant.test.ts (#2814)
 *
 * Regression test: `scripts/overnight/setup-watchdog-schedule.ps1` deve ser
 * salvo com BOM UTF-8 (bytes `EF BB BF` no início do arquivo).
 *
 * Bug 2 do #2814: o script estava em UTF-8 SEM BOM e contém caracteres
 * não-ASCII (em-dashes "—", "ç", "ã", etc). O PowerShell 5.1 (default do
 * Windows, e a versão explicitamente instruída em CLAUDE.md/docs via
 * `powershell -NoProfile -ExecutionPolicy Bypass -File ...`) só reconhece
 * UTF-8 sem confusão quando o arquivo tem BOM — sem ele, PS 5.1 decodifica
 * como ANSI/code-page local e os caracteres não-ASCII viram lixo, quebrando
 * o parse (erros reportados em L54 e L144). O script nunca rodou por causa
 * disso — causa-raiz mais profunda do incidente #2768 ("task nunca
 * registrada").
 *
 * Fix: salvar o arquivo com BOM UTF-8 (zero mudança de conteúdo — só o
 * marcador de 3 bytes no início). Este teste garante que a regressão não
 * volte (ex: um editor/formatter futuro remove o BOM sem perceber).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_DIR = resolve(ROOT, "scripts", "overnight");

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// Escopo: só o script tocado pelo #2814 (setup-watchdog-schedule.ps1).
// NOTA: `scripts/overnight/run-scheduled-edicao.ps1` também tem bytes
// não-ASCII e está sem BOM (mesma vulnerabilidade latente a PS 5.1), mas
// está fora do escopo da issue #2814 — não coberto por este teste de
// propósito para não falhar por um arquivo que este PR não toca.

describe("watchdog .ps1 BOM invariant (#2814)", () => {
  it("setup-watchdog-schedule.ps1 tem BOM UTF-8 nos primeiros 3 bytes", () => {
    const path = resolve(WATCHDOG_DIR, "setup-watchdog-schedule.ps1");
    const buf = readFileSync(path);
    const head = buf.subarray(0, 3);
    assert.ok(
      head.equals(UTF8_BOM),
      `Esperava BOM UTF-8 (EF BB BF) no início de ${path}, encontrei ` +
        `${head.toString("hex")}. Sem BOM, PowerShell 5.1 decodifica o ` +
        `arquivo como ANSI e quebra o parse em caracteres não-ASCII ` +
        `(em-dashes, acentos) — causa-raiz do #2768. Re-salvar com BOM UTF-8.`,
    );
  });

  it("o conteúdo (sem o BOM) segue sendo texto UTF-8 válido com o em-dash original preservado", () => {
    const path = resolve(WATCHDOG_DIR, "setup-watchdog-schedule.ps1");
    const buf = readFileSync(path);
    const withoutBom = buf.subarray(3);
    const text = withoutBom.toString("utf8");
    // Confirma que o fix não alterou conteúdo além do BOM: o em-dash
    // mencionado na issue (#2814, Bug 2) ainda está presente como caractere
    // Unicode real (não substituído por ASCII nem corrompido).
    assert.match(text, /—/, "em-dash Unicode deveria seguir presente no conteúdo pós-BOM");
    assert.match(text, /^<#/, "conteúdo pós-BOM deveria começar com o bloco de comment-help do PS1");
  });
});
