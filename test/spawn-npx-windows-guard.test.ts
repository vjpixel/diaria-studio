/**
 * test/spawn-npx-windows-guard.test.ts
 *
 * Guard de CLASSE: nenhum código deste repo pode chamar `spawnSync` com o
 * comando `npx` sem passar a opção `shell`.
 *
 * No Windows o executável é `npx.cmd` e o PATH não resolve o nome sem
 * extensão — a chamada falha com `ENOENT` e devolve `status: null`. Como o
 * CI roda em Linux, onde `npx` resolve, o defeito é **invisível no CI e só
 * aparece na máquina do editor** — a pior combinação, porque o teste parece
 * verde pra quem faz o merge.
 *
 * Achado ao vivo em 01/09/2026 — `test/sensitive-path-guard.test.ts` era o
 * único dos 7 chamadores de `npx` no `test/` sem `shell`, falhava 6/34
 * localmente e passava no CI. O #6777 já tinha corrigido a MESMA classe em
 * `scripts/typecheck-ratchet.ts` semanas antes; sem um guard a correção não
 * se propaga, e o próximo caso escrito à mão reintroduz o buraco em
 * silêncio.
 *
 * Preferência, em ordem: `spawnSync(process.execPath, ["--import", "tsx",
 * script, ...])` (dispensa shell E a resolução do `npx`; obrigatório quando
 * algum argumento é caminho absoluto do Windows, ver #6206) → `spawnNpx` de
 * `test/_helpers/spawn-npx.ts` → `spawnSync("npx", ..., { shell })` à mão.
 *
 * ## Por que máquina de estados, e não regex
 *
 * A 1ª versão varria com regex e o review da PR #7053 derrubou quatro
 * premissas dela, todas reproduzidas:
 *
 *   - `\bshell\b` casava com a palavra dentro de um ARGUMENTO
 *     (`["tsx", "shell.ts"]`), então uma chamada sem `shell:` nenhum passava
 *     por conforme — furo no coração do guard;
 *   - só `"npx"` entre aspas duplas era detectado: `'npx'` e crase passavam
 *     batido;
 *   - comentário no FIM da linha não era removido, então prosa citando o
 *     padrão proibido virava falso positivo;
 *   - a contagem de parênteses não sabia de string, então `")("` dentro de
 *     um argumento truncava o recorte antes de um `shell: true` legítimo.
 *
 * Os quatro têm a mesma raiz: varrer texto sem distinguir código de string e
 * de comentário. `maskNonCode` resolve na raiz — apaga comentário e CONTEÚDO
 * de string (preservando offsets, pra a posição reportada seguir apontando
 * pro arquivo real), e o resto do guard passa a operar sobre código.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Mesmas raízes do guard irmão `posix-only-test-premises-6206.test.ts` — a
 *  classe é de CÓDIGO, não de teste: o #6777 corrigiu esta mesma falha em
 *  `scripts/typecheck-ratchet.ts`, que é produção. */
const ROOTS = ["test", "scripts", "workers"];
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));
const HELPER = join("test", "_helpers", "spawn-npx.ts");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

function allSourceFiles(): string[] {
  return ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));
}

/**
 * Substitui por espaço todo caractere que NÃO é código: comentário de linha
 * (em qualquer coluna), comentário de bloco, e o CONTEÚDO de string simples,
 * dupla e template. As aspas/crases em si permanecem, pra a chamada seguir
 * reconhecível pelo formato.
 *
 * Preserva o comprimento — o offset reportado ao humano continua batendo com
 * o arquivo original.
 */
export function maskNonCode(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === c) break;
        else k++;
      }
      blank(i + 1, Math.min(k, src.length));
      i = Math.min(k, src.length) + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Recorta a chamada a partir do `spawnSync` até o `)` que a fecha, contando
 *  parênteses. Opera sobre o fonte MASCARADO, então parêntese dentro de
 *  string já virou espaço e não desequilibra a conta. */
function sliceCall(masked: string, start: number): string {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return masked.slice(start, i + 1);
    }
  }
  return masked.slice(start);
}

/** `spawnSync(` seguido de uma abertura de string — qual COMANDO é fica pro
 *  fonte original, já que no mascarado o conteúdo virou espaço. */
const CALL_RE = /spawnSync\(\s*(["'`])/g;

/** A opção precisa ser a CHAVE `shell:`, não a palavra solta — senão um
 *  argumento contendo "shell" (`"shell.ts"`) faz a chamada passar por
 *  conforme. Foi o furo P1 do review da PR #7053. */
const SHELL_OPTION_RE = /\bshell\s*:/;

/** Pure — offsets das chamadas ofensoras em UM fonte. Separado do laço de
 *  arquivos pra ser exercitável com fixture: um guard testado só contra o
 *  repo limpo passa por construção, e ninguém sabe se ele ainda detecta. */
export function findOffendingOffsets(src: string): number[] {
  const masked = maskNonCode(src);
  const out: number[] = [];
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(masked); m !== null; m = CALL_RE.exec(masked)) {
    const quote = m[1];
    const contentAt = m.index + m[0].length;
    // Conteúdo real vem do fonte ORIGINAL; e o fechamento tem que vir logo
    // depois, senão `"npx-wrapper"` passaria por `npx`.
    if (src.slice(contentAt, contentAt + 3) !== "npx") continue;
    if (src[contentAt + 3] !== quote) continue;
    if (!SHELL_OPTION_RE.test(sliceCall(masked, m.index))) out.push(m.index);
  }
  return out;
}

describe("spawnSync com npx sempre trata Windows (ENOENT invisível no CI)", () => {
  it("nenhum arquivo de test/, scripts/ ou workers/ chama npx sem `shell`", () => {
    const ofensores: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(REPO_ROOT, file);
      // O helper define a chamada canônica — ele JÁ passa shell (e invoca por
      // variável, então nem casaria; a exclusão é explícita de propósito).
      if (rel === HELPER) continue;
      // Este arquivo carrega o padrão proibido em FIXTURE nos testes abaixo,
      // que é código executável, não comentário.
      if (rel === SELF) continue;
      for (const offset of findOffendingOffsets(readFileSync(file, "utf8"))) {
        ofensores.push(`${rel} (offset ${offset})`);
      }
    }
    assert.deepEqual(
      ofensores,
      [],
      `spawnSync com "npx" e sem a opção \`shell\` falha com ENOENT no Windows e passa no CI Linux — ` +
        `use spawnSync(process.execPath, ["--import", "tsx", script, ...]) ou spawnNpx(). Ofensores:\n` +
        ofensores.join("\n"),
    );
  });

  it("a varredura de fato encontra arquivos (guard não vira no-op)", () => {
    // Mesmo safeguard do guard irmão (#6206): se `ROOTS` quebrar num refactor
    // de diretório, o teste acima passaria pra sempre em silêncio — o modo de
    // falha mais perigoso pra um guard.
    const arquivos = allSourceFiles();
    assert.ok(arquivos.length > 300, `esperava centenas de .ts em ${ROOTS.join(", ")}, achei ${arquivos.length}`);
  });

  it("as 2 exclusões existem de fato — não estão silenciando um arquivo ausente", () => {
    assert.ok(existsSync(join(REPO_ROOT, HELPER)), `exclusão aponta pra arquivo inexistente: ${HELPER}`);
    assert.ok(existsSync(join(REPO_ROOT, SELF)), `exclusão aponta pra arquivo inexistente: ${SELF}`);
  });

  it("DETECTA a chamada ofensora nas 3 formas de aspas (furo P1 do review)", () => {
    assert.equal(findOffendingOffsets('spawnSync("npx", ["tsx", "x.ts"], { cwd: r })').length, 1);
    assert.equal(findOffendingOffsets("spawnSync('npx', ['tsx', 'x.ts'], { cwd: r })").length, 1);
    assert.equal(findOffendingOffsets("spawnSync(`npx`, [`tsx`], { cwd: r })").length, 1);
  });

  it("argumento contendo a palavra `shell` NÃO conta como opção (furo P1 do review)", () => {
    // `\bshell\b` casava aqui, e a chamada — que não tem `shell:` nenhum —
    // passava por conforme.
    assert.equal(findOffendingOffsets('spawnSync("npx", ["tsx", "shell.ts"], { cwd: r })').length, 1);
    assert.equal(findOffendingOffsets('spawnSync("npx", ["install-shell.ts"], { cwd: r })').length, 1);
  });

  it("aceita as formas corretas de passar a opção", () => {
    assert.deepEqual(findOffendingOffsets('spawnSync("npx", ["tsx", "a.ts"], { shell: true })'), []);
    assert.deepEqual(findOffendingOffsets('spawnSync("npx", ["knip"], { shell: process.platform === "win32" })'), []);
    assert.deepEqual(findOffendingOffsets('spawnSync("npx", args, { ...opts, shell: isWindows })'), []);
  });

  it("`shellArgs` não é a opção `shell`", () => {
    assert.equal(findOffendingOffsets('spawnSync("npx", ["a"], { shellArgs: x })').length, 1);
  });

  it("comentário citando o padrão nunca é ofensor — inclusive no fim da linha", () => {
    assert.deepEqual(findOffendingOffsets('// nunca: spawnSync("npx", ["a"], { cwd })'), []);
    assert.deepEqual(findOffendingOffsets('foo(); // nunca spawnSync("npx", ["a"], { cwd })'), []);
    assert.deepEqual(findOffendingOffsets('/* spawnSync("npx", ["a"], { cwd }) */'), []);
  });

  it("string com `/*` ou `//` dentro não engole código real (furo P2 do review)", () => {
    // A versão regex apagava daqui até o próximo `*/` e a chamada REAL sumia
    // — falso negativo, o modo de falha que um guard não pode ter.
    const glob = 'const g = "a/*b"; spawnSync("npx", ["tsx", "x.ts"], { cwd: r }); const o = "c*/d";';
    assert.equal(findOffendingOffsets(glob).length, 1);
    const url = 'const u = "https://x.dev"; spawnSync("npx", ["a"], { cwd: r });';
    assert.equal(findOffendingOffsets(url).length, 1);
  });

  it("parêntese dentro de string não trunca o recorte antes do `shell` (furo P2 do review)", () => {
    const weird = 'spawnSync("npx", ["tsx", "weird)(name.ts"], { cwd: r, shell: true })';
    assert.deepEqual(findOffendingOffsets(weird), []);
    const nested = 'spawnSync("npx", ["tsx", join(a, "b.ts")], { cwd: r, shell: true })';
    assert.deepEqual(findOffendingOffsets(nested), []);
  });

  it("comando que só COMEÇA com npx não é confundido", () => {
    assert.deepEqual(findOffendingOffsets('spawnSync("npx-wrapper", ["a"], { cwd: r })'), []);
    assert.deepEqual(findOffendingOffsets('spawnSync("node", ["--import", "tsx", s], { cwd: r })'), []);
  });

  it("maskNonCode preserva offsets e quebras de linha", () => {
    const src = 'a; // x\nb("s");';
    const masked = maskNonCode(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.split("\n").length, src.split("\n").length);
  });
});
