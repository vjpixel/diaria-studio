/**
 * render-newsletter-html-no-tty-warn.test.ts (#2012)
 *
 * Regressão: quando stdout não é TTY e --out está ausente, o script deve
 * emitir warning explícito no stderr — mas NÃO falhar (pipe é uso legítimo).
 * Na edição 260610 o script foi invocado sem --out e o stdout foi para
 * /dev/null; newsletter-draft.html nunca foi regenerado e o upload subiu
 * newsletter-final.html stale pro Worker sem aviso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");

/** Fixture mínimo de edition-dir com 3 destaques válidos. */
function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-render-warn-"));
  const reviewed = [
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    "**[Título um](https://example.com/1)**",
    "",
    "Corpo do destaque um com contexto suficiente pra render.",
    "",
    "Por que isso importa: razão um.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | RADAR**",
    "",
    "**[Título dois](https://example.com/2)**",
    "",
    "Corpo dois.",
    "",
    "Por que isso importa: razão dois.",
    "",
    "---",
    "",
    "**DESTAQUE 3 | PESQUISA**",
    "",
    "**[Título três](https://example.com/3)**",
    "",
    "Corpo três.",
    "",
    "Por que isso importa: razão três.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("render-newsletter-html CLI — aviso stdout não-TTY (#2012)", () => {
  it("emite AVISO no stderr quando stdout não é TTY e --out está ausente", () => {
    // spawnSync sem stdio:'inherit' → stdout é pipe (não TTY), simulando exatamente
    // o cenário que causou 260610.
    const dir = makeEditionDir();
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, dir],
        { encoding: "utf8", cwd: PROJECT_ROOT },
      );
      assert.equal(r.status, 0, `script deve sair 0 (não quebrar quem usa pipe); stderr: ${r.stderr}`);
      assert.match(
        r.stderr,
        /AVISO.*stdout.*n.o.*TTY/i,
        "deve emitir aviso explícito de stdout não-TTY",
      );
      assert.match(
        r.stderr,
        /--out/,
        "mensagem de aviso deve mencionar --out como solução",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NÃO emite o aviso quando --out está presente (mesmo com stdout não-TTY)", () => {
    const dir = makeEditionDir();
    const outPath = join(dir, "_internal", "newsletter-draft.html");
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, dir, "--out", outPath],
        { encoding: "utf8", cwd: PROJECT_ROOT },
      );
      assert.equal(r.status, 0, `script deve sair 0; stderr: ${r.stderr}`);
      assert.doesNotMatch(
        r.stderr,
        /AVISO.*stdout.*n.o.*TTY/i,
        "não deve avisar quando --out especificado",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--out cria _internal/ se ainda não existir (mkdirSync guard #2042)", () => {
    // Regressão: antes do fix, writeFileSync(outPath) lançava ENOENT quando
    // _internal/ não existia. Simula invocação standalone sem Stage 0.
    // makeEditionDir() cria _internal/; removemos antes de chamar o script
    // pra simular o caso edge onde o diretório não existe.
    const dir = makeEditionDir();
    const internalDir = join(dir, "_internal");
    const outPath = join(internalDir, "newsletter-draft.html");
    // Remover _internal/ criado por makeEditionDir() — simula standalone sem Stage 0.
    rmSync(internalDir, { recursive: true, force: true });
    assert.ok(!existsSync(internalDir), "pré-condição: _internal/ deve não existir");
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, dir, "--out", outPath],
        { encoding: "utf8", cwd: PROJECT_ROOT },
      );
      assert.equal(r.status, 0, `script deve sair 0 (criou _internal/); stderr: ${r.stderr}`);
      assert.ok(existsSync(outPath), "_internal/newsletter-draft.html deve existir após --out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HTML ainda sai no stdout mesmo com o aviso (pipe legítimo não quebra)", () => {
    const dir = makeEditionDir();
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, dir],
        { encoding: "utf8", cwd: PROJECT_ROOT },
      );
      assert.equal(r.status, 0);
      assert.ok(r.stdout.length > 0, "stdout deve conter o HTML");
      assert.match(r.stdout, /<[a-z]/, "stdout deve conter HTML (tag)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
