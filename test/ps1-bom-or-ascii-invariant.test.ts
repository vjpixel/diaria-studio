/**
 * test/ps1-bom-or-ascii-invariant.test.ts (#2825, estendendo #2814/#2826)
 *
 * Invariante estrutural: TODO `.ps1` sob `scripts/` deve satisfazer pelo
 * menos uma das duas condições seguras pro PowerShell 5.1 (default do
 * Windows, versão explicitamente instruída em CLAUDE.md/docs via
 * `powershell -NoProfile -ExecutionPolicy Bypass -File ...`):
 *
 *   (a) tem BOM UTF-8 (bytes `EF BB BF`) no início do arquivo, OU
 *   (b) é 100% ASCII (sem necessidade de BOM — não há byte não-ASCII pra
 *       PS 5.1 interpretar errado).
 *
 * Contexto: `test/watchdog-ps1-bom-invariant.test.ts` (#2814/#2826) cobre só
 * `setup-watchdog-schedule.ps1` — a issue #2814 era escopada a esse arquivo
 * específico. #2825 generaliza a invariante pra TODOS os .ps1 de scripts/,
 * porque o mesmo bug de fundo (PS 5.1 decodifica UTF-8-sem-BOM como
 * ANSI/code-page local e corrompe caracteres não-ASCII em posição sintática,
 * quebrando o parse) é latente em qualquer .ps1 do repo, não só no watchdog.
 *
 * `scripts/overnight/run-scheduled-edicao.ps1` (runner da task agendada da
 * edição matinal) foi encontrado sem BOM com 44 linhas não-ASCII — parseava
 * hoje só porque o mojibake caía em strings/comentários, não em posição
 * sintática, mas qualquer edição futura com em-dash em posição sintática
 * quebraria a edição da manhã silenciosamente. Fix: BOM adicionado (zero
 * mudança de conteúdo, só os 3 bytes do marcador).
 *
 * Este teste garante que a classe inteira (não só o arquivo do incidente)
 * não regride: qualquer novo `.ps1` com caracteres não-ASCII precisa ter BOM
 * desde o commit que o introduz.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Lista .ps1 recursivamente sob um diretório. */
function ps1FilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...ps1FilesUnder(full));
    else if (name.toLowerCase().endsWith(".ps1")) out.push(full);
  }
  return out;
}

function hasBom(buf: Buffer): boolean {
  return buf.subarray(0, 3).equals(UTF8_BOM);
}

/** true se o buffer inteiro é ASCII puro (bytes 0x00-0x7F). */
function isPureAscii(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte > 0x7f) return false;
  }
  return true;
}

describe("todo .ps1 de scripts/ tem BOM UTF-8 ou é ASCII puro (#2825)", () => {
  const ps1Files = ps1FilesUnder(SCRIPTS_DIR);

  it("sanity: encontrou pelo menos 1 arquivo .ps1 (senão o scan está quebrado)", () => {
    assert.ok(
      ps1Files.length > 0,
      `nenhum .ps1 encontrado sob ${SCRIPTS_DIR} — scan de descoberta quebrado ` +
        `(este teste deixaria de proteger silenciosamente).`,
    );
  });

  for (const file of ps1Files) {
    const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
    it(`${rel}: tem BOM UTF-8 ou é 100% ASCII`, () => {
      const buf = readFileSync(file);
      const ok = hasBom(buf) || isPureAscii(buf);
      assert.ok(
        ok,
        `${rel} não tem BOM UTF-8 (EF BB BF) E contém byte(s) não-ASCII. ` +
          `PowerShell 5.1 decodifica esse arquivo como ANSI/code-page local, ` +
          `corrompendo caracteres não-ASCII (em-dashes, acentos) — se algum cair ` +
          `em posição sintática, quebra o parse silenciosamente (causa-raiz do ` +
          `#2768/#2814). Fix: prefixar o arquivo com o BOM UTF-8 (EF BB BF), sem ` +
          `mudar o resto do conteúdo.`,
      );
    });
  }
});
