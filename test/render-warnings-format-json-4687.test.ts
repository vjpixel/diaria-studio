/**
 * test/render-warnings-format-json-4687.test.ts (#4687, achado do fleet
 * review sobre o #4673 — PR #4671/#4673 fechou o loop de
 * `render-warnings.json` só pro branch de render HTML do CLI
 * `render-newsletter-html.ts`; `--format json` nunca chama `renderHTML()`,
 * então nunca chamava `writeRenderWarningsFile()` — um `render-warnings.json`
 * já em disco de um render HTML anterior (ex: 3 caixas de divulgação, 2
 * dropped) sobrevivia INTOCADO a uma invocação `--format json` seguinte,
 * mesmo depois do editor corrigir a causa. Fix: o branch `--format json`
 * agora reseta o coletor e escreve o arquivo (sempre array vazio, já que
 * nenhum `renderHTML()` rodou nesta invocação) — mesma disciplina "escreve
 * sempre" que os outros branches já tinham.
 *
 * Regressão #633: sem este teste, um caller que rodasse `--format json` de
 * inspeção/debug no meio de uma edição corrigida veria o warning fantasma
 * reaparecer no gate do Stage 4 seguinte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n} com contexto suficiente pra render.

Por que isso importa:

Why do D${n}.
`;
}

function buildReviewed(boxes: { box1?: string | null; box2?: string | null; box3?: string | null }): string {
  const { box1 = null, box2 = null, box3 = null } = boxes;
  const sep = (block: string | null) => (block ? `${block}\n\n---\n\n` : "");
  return `Para esta edição, selecionamos 12 itens.

---

${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${sep(box1)}${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${sep(box2)}${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${box3 ?? ""}
`;
}

const BOX1 = "📚 Confira nossa curadoria. [Link](https://example.com/box1).";
const BOX2 = "📚 Confira nossos livros. [Link](https://example.com/box2).";
const BOX3 = "🔧 Apoie a curadoria. [Link](https://example.com/box3).";

function makeEditionDir(reviewed: string): string {
  const base = mkdtempSync(join(tmpdir(), "diaria-render-warnings-json-"));
  const dir = join(base, "260999");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function run(dirAndArgs: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...dirAndArgs], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

function readWarnings(dir: string): { warnings: Array<{ event: string }> } {
  const path = join(dir, "_internal", "render-warnings.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("render-newsletter-html CLI — --format json não deixa render-warnings.json stale (#4687)", () => {
  it("--format json escreve render-warnings.json com warnings: [] (não sobrevive aviso de render HTML anterior)", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1, box2: BOX2, box3: BOX3 }));
    try {
      const outPath = join(dir, "_internal", "out.html");

      // 1ª chamada: render HTML normal, slot3 dropped → warning gravado.
      const r1 = run([dir, "--full", "--out", outPath]);
      assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
      assert.equal(readWarnings(dir).warnings.length, 1, "pré-condição: warning presente antes do --format json");

      // Editor corrige a causa (remove a caixa excedente).
      writeFileSync(join(dir, "02-reviewed.md"), buildReviewed({ box1: BOX1, box2: BOX2 }), "utf8");

      // 2ª chamada: --format json (uso legítimo de inspeção/debug) — antes do
      // fix, `renderHTML()` nunca rodava neste branch e o arquivo antigo
      // (com o warning da causa já corrigida) sobrevivia intocado.
      const r2 = run([dir, "--format", "json"]);
      assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
      assert.ok(existsSync(join(dir, "_internal", "render-warnings.json")), "render-warnings.json deveria existir");
      assert.deepEqual(
        readWarnings(dir).warnings,
        [],
        "--format json deve resetar/escrever o arquivo (sem renderHTML nesta chamada, warnings deve ser [])",
      );
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("--format json isolado (sem render HTML anterior no mesmo diretório) também grava warnings: []", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1 }));
    try {
      const r = run([dir, "--format", "json"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.deepEqual(readWarnings(dir).warnings, []);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });
});
