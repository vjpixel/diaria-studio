import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// #12779: o `gh` do servidor 300 é a 2.46.0, que não tem `gh api --slurp`
// (`unknown flag: --slurp`). A fila de escaladas do contínuo quebrava inteira
// ali; o #12765 trocou por paginação em TS (`fetchAllPages`). Este guard varre
// o código executável inteiro, não só aquele script, para a flag não voltar
// em outro lugar.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["scripts", "hermes", "workers", ".claude/hooks"];
const EXT = /\.(ts|mts|mjs|cjs|js|sh)$/;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".wrangler")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
}

/** Linhas de código: tira comentário de linha (`//`, `*`, `/*`, `#`). */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#"));
  });
}

describe("nenhum `gh ... --slurp` no código (#12779)", () => {
  it("varredura acha arquivos (o guard não passa vazio)", () => {
    const files: string[] = [];
    walk(join(ROOT, "scripts"), files);
    assert.ok(files.length > 100, `só ${files.length} arquivos em scripts/`);
  });

  it("nenhum arquivo de código usa --slurp fora de comentário", () => {
    const files: string[] = [];
    for (const d of DIRS) walk(join(ROOT, d), files);
    const offenders = files.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => l.includes("--slurp")));
    assert.deepEqual(
      offenders.map((f) => relative(ROOT, f)),
      [],
      "gh 2.46 do 300 não tem --slurp: paginar em TS (ver fetchAllPages em scripts/list-continuo-escalation-queue.ts)",
    );
  });

  it("o filtro de comentário não esconde uso real", () => {
    assert.equal(codeLines('execFileSync("gh", ["api", p, "--paginate", "--slurp"]);').length, 1);
    assert.equal(codeLines(" * sem `--slurp` (#12765)").length, 0);
  });
});
