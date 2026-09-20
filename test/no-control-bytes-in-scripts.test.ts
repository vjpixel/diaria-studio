/**
 * test/no-control-bytes-in-scripts.test.ts (#8517)
 *
 * Guard mecânico: nenhum `.ts` sob `scripts/` embute um byte de controle
 * (ex: NUL `\x00`) literal no fonte. `\t` (0x09) e `\n` (0x0a) são
 * permitidos (indentação/quebra de linha normais); `\r` (0x0d) também é
 * tolerado (arquivo com line endings CRLF, não é o que este guard cobre).
 * Todo o resto do intervalo de controle C0 (0x00-0x08, 0x0b, 0x0c,
 * 0x0e-0x1f) reprova.
 *
 * Motivação: `scripts/lib/dedup-grayzone-jev.ts:140` (#8505/PR #8508) embutia
 * um byte NUL literal dentro de um template literal (separador de
 * `pairKey()`) — funcionalmente correto, mas fazia o git classificar o
 * arquivo inteiro como binário: `git diff`/`git show`/`git blame` paravam de
 * exibir o conteúdo, e merge textual ficava indisponível. 12KB de código
 * entraram no repo sem diff revisável por causa disso. O fix trocou o NUL
 * por um separador imprimível (U+241F); este teste impede a regressão em
 * qualquer arquivo `scripts/**\/*.ts` futuro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

// Byte de controle C0 fora de \t (0x09), \n (0x0a) e \r (0x0d).
const CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("no-control-bytes-in-scripts (#8517)", () => {
  it("nenhum .ts sob scripts/ contém byte de controle fora de \\t/\\n/\\r", () => {
    const offenders: { file: string; index: number; code: string }[] = [];

    for (const file of tsFilesUnder(SCRIPTS)) {
      const buf = readFileSync(file);
      const text = buf.toString("latin1"); // 1 byte = 1 char, preserva offsets
      const match = CONTROL_BYTE_RE.exec(text);
      if (match) {
        offenders.push({
          file: file.slice(ROOT.length + 1),
          index: match.index,
          code: `0x${match[0].charCodeAt(0).toString(16).padStart(2, "0")}`,
        });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `byte(s) de controle literal encontrado(s) — troque por um separador ` +
        `imprimível (ex: ␟ U+241F): ${JSON.stringify(offenders)}`,
    );
  });
});
