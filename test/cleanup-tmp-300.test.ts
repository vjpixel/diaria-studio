/**
 * test/cleanup-tmp-300.test.ts (#8828)
 *
 * Cobre `scripts/cleanup-tmp-300.ts` com um diretório sintético (nunca o
 * `/tmp/claude-1000` real da máquina) — foco no guard descoberto no
 * self-review desta unidade: `/tmp/claude-{uid}` guarda entradas INTERNAS
 * DO HARNESS que não são projeto nenhum (`bundled-skills/`,
 * `bash-edit-diff/`, vistas ao vivo na máquina `300`) — sem o filtro
 * `looksLikeProjectSlug`, uma dessas entradas seria tratada como "sessão"
 * de um "projeto" e podada como morta ao envelhecer, apagando estado do
 * harness compartilhado por TODAS as sessões.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeProjectSlug, collectSessionDirs, collectOutputFiles } from "../scripts/cleanup-tmp-300.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cleanup-tmp-300-test-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("looksLikeProjectSlug (#8828, guard do self-review)", () => {
  it("aceita slugs reais de projeto (path absoluto slugificado, começam com '-')", () => {
    assert.equal(looksLikeProjectSlug("-home-vjpixel-diaria-studio"), true);
    assert.equal(looksLikeProjectSlug("-home-vjpixel-OneDrive-Documentos-diaria-studio-data-editions-replay-writer-destaque-260713-baseline"), true);
  });

  it("rejeita diretórios internos do harness (bundled-skills, bash-edit-diff)", () => {
    assert.equal(looksLikeProjectSlug("bundled-skills"), false);
    assert.equal(looksLikeProjectSlug("bash-edit-diff"), false);
  });
});

describe("collectSessionDirs — nunca desce em diretório interno do harness (#8828)", () => {
  it("ignora bash-edit-diff/<hash>/ mesmo que pareça um diretório de sessão", () => {
    // Réplica exata da estrutura vista ao vivo: bash-edit-diff/<hash-composto>/
    const harnessInternalDir = join(root, "bash-edit-diff", "15989940215326119388-9543953992008861987-8fb3e58fdc873b92");
    mkdirSync(harnessInternalDir, { recursive: true });

    // Diretório de projeto real, com 1 sessão de verdade.
    const realSessionDir = join(root, "-home-vjpixel-diaria-studio", "00588ca9-118b-4c52-a5ff-1bac70809198");
    mkdirSync(realSessionDir, { recursive: true });

    const dirs = collectSessionDirs(root);
    const sessionIds = dirs.map((d) => d.sessionId);

    assert.ok(sessionIds.includes("00588ca9-118b-4c52-a5ff-1bac70809198"));
    assert.ok(
      !sessionIds.includes("15989940215326119388-9543953992008861987-8fb3e58fdc873b92"),
      "diretório interno do harness NUNCA deve virar candidato a sessão",
    );
  });

  it("arquivos soltos direto em claudeDir (ex: cache-break-state-*.json) não viram sessão", () => {
    writeFileSync(join(root, "cache-break-state-xyz.json"), "{}");
    const dirs = collectSessionDirs(root);
    assert.equal(dirs.some((d) => d.path.includes("cache-break-state")), false);
  });
});

describe("collectOutputFiles — só arquivos .output dentro de <sessão>/tasks/ (#8828)", () => {
  it("encontra .output dentro de tasks/ e ignora outros arquivos", () => {
    const sessionPath = join(root, "-home-vjpixel-diaria-studio", "s-tasks-test");
    const tasksDir = join(sessionPath, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "b1.output"), "conteudo");
    writeFileSync(join(tasksDir, "not-output.log"), "conteudo");

    const dirs = collectSessionDirs(root).filter((d) => d.sessionId === "s-tasks-test");
    const files = collectOutputFiles(dirs);

    assert.equal(files.length, 1);
    assert.ok(files[0].path.endsWith("b1.output"));
  });
});
