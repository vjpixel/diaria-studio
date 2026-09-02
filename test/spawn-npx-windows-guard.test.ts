/**
 * test/spawn-npx-windows-guard.test.ts
 *
 * Guard de CLASSE, não de um arquivo: nenhum teste pode chamar
 * `spawnSync("npx", ...)` sem `shell`.
 *
 * No Windows o executável é `npx.cmd` e o PATH não resolve o nome sem
 * extensão — a chamada falha com `ENOENT` e devolve `status: null`. Como o
 * CI roda em Linux, onde `npx` resolve, o defeito é **invisível no CI e só
 * aparece na máquina do editor** — a pior combinação: o teste parece verde
 * pra quem faz o merge.
 *
 * Achado ao vivo em 01/09/2026 — `test/sensitive-path-guard.test.ts` era o
 * único dos 7 chamadores de `npx` no `test/` sem `shell`, falhava 6/34
 * localmente e passava no CI. O #6777 já tinha corrigido a MESMA classe em
 * `scripts/typecheck-ratchet.ts` (produção) semanas antes; sem um guard a
 * correção não se propaga, e o próximo `spawnSync("npx")` escrito à mão
 * reintroduz o buraco em silêncio.
 *
 * Preferência, em ordem: `spawnSync(process.execPath, ["--import", "tsx",
 * script, ...])` (dispensa shell E a resolução do `npx`; obrigatório quando
 * algum argumento é caminho absoluto do Windows, ver #6206) → `spawnNpx` de
 * `test/_helpers/spawn-npx.ts` → `spawnSync("npx", ..., { shell })` à mão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return testFiles(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

/** Remove comentários antes de varrer. Sem isto o guard casa com a PRÓPRIA
 *  prosa que descreve o padrão proibido — inclusive a deste arquivo e a do
 *  docstring que a correção deixou em `sensitive-path-guard.test.ts` — e
 *  acusa como ofensor um texto que não executa nada. Aproximação
 *  deliberada: não entende string literal contendo `//`, porque errar aqui
 *  custa um falso positivo barulhento, nunca um falso negativo (o padrão
 *  real não vive dentro de string). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Recorta a chamada a partir de `spawnSync("npx"` até o `)` que a fecha,
 *  contando parênteses — um `indexOf(")")` pararia no 1º fechamento
 *  aninhado (`join(a, b)` dentro dos args) e leria `shell` como ausente. */
function sliceCall(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Pure — offsets das chamadas ofensoras em UM fonte. Separado do laço de
 *  arquivos pra ser exercitável com fixture: um guard testado só contra o
 *  repo limpo passa por construção, e ninguém sabe se ele ainda detecta. */
export function findOffendingOffsets(src: string): number[] {
  const clean = stripComments(src);
  const re = /spawnSync\(\s*"npx"/g;
  const out: number[] = [];
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    if (!/\bshell\b/.test(sliceCall(clean, m.index))) out.push(m.index);
  }
  return out;
}

describe("spawnSync('npx') em teste sempre trata Windows (ENOENT invisível no CI)", () => {
  it("nenhum arquivo de teste chama npx sem `shell`", () => {
    const ofensores: string[] = [];
    for (const file of testFiles(TEST_DIR)) {
      // O helper define a chamada canônica — ele JÁ passa shell.
      if (file.endsWith(join("_helpers", "spawn-npx.ts"))) continue;
      // Este arquivo carrega o padrão proibido em FIXTURE (os testes
      // abaixo), que é código executável, não comentário.
      if (file === fileURLToPath(import.meta.url)) continue;
      for (const offset of findOffendingOffsets(readFileSync(file, "utf8"))) {
        ofensores.push(`${file.slice(TEST_DIR.length + 1)} (offset ${offset})`);
      }
    }
    assert.deepEqual(
      ofensores,
      [],
      `spawnSync("npx") sem \`shell\` falha com ENOENT no Windows e passa no CI Linux — ` +
        `use spawnSync(process.execPath, ["--import", "tsx", script, ...]) ou spawnNpx(). Ofensores:\n` +
        ofensores.join("\n"),
    );
  });

  it("DETECTA de fato uma chamada ofensora — guard exercitado com fixture", () => {
    const ofensor = 'const r = spawnSync("npx", ["tsx", "scripts/x.ts"], { cwd: root, encoding: "utf8" });';
    assert.equal(findOffendingOffsets(ofensor).length, 1);
  });

  it("aceita as 2 formas corretas e ignora o padrão citado em comentário", () => {
    const comShellLiteral = 'spawnSync("npx", ["tsx", "a.ts"], { shell: true })';
    const comShellCondicional = 'spawnSync("npx", ["knip"], { shell: process.platform === "win32" })';
    const soEmComentario = '// nunca faca spawnSync("npx", ["tsx", "a.ts"], { cwd })\nconst x = 1;';
    assert.deepEqual(findOffendingOffsets(comShellLiteral), []);
    assert.deepEqual(findOffendingOffsets(comShellCondicional), []);
    assert.deepEqual(findOffendingOffsets(soEmComentario), []);
  });

  it("parêntese aninhado nos args não corta o recorte antes do `shell`", () => {
    const comShell = 'spawnSync("npx", ["tsx", join(a, "b.ts")], { cwd: r, shell: true })';
    assert.deepEqual(findOffendingOffsets(comShell), []);
    const semShell = 'spawnSync("npx", ["tsx", join(a, "b.ts")], { cwd: r })';
    assert.equal(findOffendingOffsets(semShell).length, 1);
  });
});
