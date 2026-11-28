/**
 * #14054: `scripts/publish-shorts.ts` virou entrada fina e o código foi para
 * `scripts/publish-shorts/` (um módulo por destino). Trava o que a divisão
 * pode quebrar sem nenhum teste de comportamento ficar vermelho:
 *   - o `ROOT` dos módulos (um nível mais fundo) continua sendo a raiz do repo;
 *   - a entrada segue abaixo de 1.500 linhas e não volta a acumular código;
 *   - nenhum módulo importa a entrada (ciclo) e nenhum vira CLI;
 *   - os módulos continuam na regra `publicadores-shorts` do guard de caminho
 *     sensível (a `scripts/publish-*.ts` não cruza `/`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalShortsEditionDir } from "../scripts/publish-shorts/_shared.ts";
import { isSensitivePath } from "../scripts/lib/sensitive-path-guard.ts";
import { publishShortsModuleFiles } from "./_helpers/publish-shorts-source.ts";

const ROOT = join(import.meta.dirname, "..");
const ENTRY = join(ROOT, "scripts", "publish-shorts.ts");

describe("#14054 divisão do publish-shorts", () => {
  it("o ROOT dos módulos é a raiz do repo (a pasta canônica da edição sai em data/editions/)", () => {
    assert.equal(canonicalShortsEditionDir("261126"), join(ROOT, "data", "editions", "2611", "261126"));
  });

  it("a entrada fica abaixo de 1.500 linhas e só reexporta, carrega o .env e roda a CLI", () => {
    const src = readFileSync(ENTRY, "utf8");
    assert.ok(src.split("\n").length < 1500, `publish-shorts.ts tem ${src.split("\n").length} linhas`);
    assert.doesNotMatch(src, /^(export )?(async )?function /m, "função de volta na entrada: mova para scripts/publish-shorts/");
    assert.match(src, /^loadProjectEnv\(\);$/m);
    assert.match(src, /^if \(isMainModule\(import\.meta\.url\)\) \{$/m);
  });

  it("os módulos existem, não importam a entrada e não rodam como CLI", () => {
    const files = publishShortsModuleFiles();
    assert.ok(files.length >= 10, `só ${files.length} módulo(s) em scripts/publish-shorts/`);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const rel = relative(ROOT, f);
      assert.doesNotMatch(src, /from "\.\.\/publish-shorts\.ts"/, `${rel} importa a entrada (ciclo)`);
      assert.doesNotMatch(src, /isMainModule\(/, `${rel} não pode virar CLI: a entrada é scripts/publish-shorts.ts`);
      assert.doesNotMatch(src, /^loadProjectEnv\(\)/m, `${rel}: o .env é carregado só na entrada`);
    }
  });

  it("todo módulo de scripts/publish-shorts/ é caminho sensível", () => {
    for (const f of publishShortsModuleFiles()) {
      const rel = relative(ROOT, f).replaceAll("\\", "/");
      assert.equal(isSensitivePath(rel), true, `${rel} deveria ser sensível`);
    }
    assert.equal(isSensitivePath("scripts/publish-shorts.ts"), true);
  });
});
