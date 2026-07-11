/**
 * test/curadoria-data-shared-3118.test.ts (#3118 item 13)
 *
 * Regressão pra extração do layer de dados/validação compartilhado entre
 * `build-cursos-page.ts` e `build-livros-page.ts` (`isSafeUrl`,
 * `ValidationResult`, `availableThemes`/`distinctThemes`, `loadSeedItems`) —
 * complementa `test/curadoria-page-shared-3113.test.ts` (CSS/template).
 *
 * Cobre tanto o módulo compartilhado isolado (`scripts/lib/shared/curadoria-data.ts`)
 * quanto a prova de que os 2 builders de fato ADOTARAM a mesma implementação
 * (reference-equality dos re-exports) — sem isso um builder poderia manter
 * uma cópia local por engano e o teste do módulo isolado não pegaria o drift.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSafeUrl,
  availableThemes,
  distinctThemes,
  loadSeedItems,
  type ThemedItem,
  type ValidationResult,
} from "../scripts/lib/shared/curadoria-data.ts";
import * as cursosModule from "../scripts/build-cursos-page.ts";
import * as livrosModule from "../scripts/build-livros-page.ts";

describe("isSafeUrl (#3118 item 13)", () => {
  it("aceita http/https", () => {
    assert.equal(isSafeUrl("https://example.com"), true);
    assert.equal(isSafeUrl("http://example.com"), true);
  });

  it("rejeita esquemas perigosos/ausentes", () => {
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl("data:text/html,x"), false);
    assert.equal(isSafeUrl(undefined), false);
    assert.equal(isSafeUrl(""), false);
  });
});

describe("availableThemes / distinctThemes (#3118 item 13)", () => {
  const items: ThemedItem[] = [
    { language: "pt-br", level: "iniciante", themes: ["Ética", "LLMs"] },
    { language: "en", level: "avancado", themes: ["Ética", "Robótica"] },
    { language: "pt-br", level: "avancado", themes: [] },
  ];

  it("distinctThemes junta e ordena todos os temas sem duplicar", () => {
    assert.deepEqual(distinctThemes(items), ["Ética", "LLMs", "Robótica"]);
  });

  it("availableThemes filtra por idioma", () => {
    assert.deepEqual(availableThemes(items, "en"), ["Ética", "Robótica"]);
  });

  it("availableThemes filtra por nível", () => {
    assert.deepEqual(availableThemes(items, "", "iniciante"), ["Ética", "LLMs"]);
  });

  it("availableThemes combina idioma+nível", () => {
    assert.deepEqual(availableThemes(items, "pt-br", "avancado"), []);
  });
});

describe("loadSeedItems (#3118 item 13)", () => {
  const validateOk = (): ValidationResult => ({ ok: true, errors: [], warnings: [] });
  const validateFail = (): ValidationResult => ({ ok: false, errors: ["campo X ausente"], warnings: [] });

  it("lança quando o arquivo não existe", () => {
    assert.throws(
      () => loadSeedItems("/caminho/que/nao/existe.json", "items", validateOk),
      /seed não encontrado/,
    );
  });

  it("lança com as mensagens de erro do validador quando inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "curadoria-data-test-"));
    try {
      const seedPath = join(dir, "seed.json");
      writeFileSync(seedPath, JSON.stringify({ items: [{ id: "x" }] }));
      assert.throws(
        () => loadSeedItems(seedPath, "items", validateFail),
        /seed inválido[\s\S]*campo X ausente/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna o array da chave pedida quando válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "curadoria-data-test-"));
    try {
      const seedPath = join(dir, "seed.json");
      writeFileSync(seedPath, JSON.stringify({ items: [{ id: "a" }, { id: "b" }] }));
      const items = loadSeedItems<{ id: string }>(seedPath, "items", validateOk);
      assert.deepEqual(items.map((i) => i.id), ["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave ausente no JSON vira array vazio (não lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "curadoria-data-test-"));
    try {
      const seedPath = join(dir, "seed.json");
      writeFileSync(seedPath, JSON.stringify({ outraChave: [] }));
      const items = loadSeedItems(seedPath, "items", validateOk);
      assert.deepEqual(items, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("build-cursos-page.ts / build-livros-page.ts adotam a mesma implementação (#3118 item 13)", () => {
  it("esc/isSafeUrl/availableThemes/distinctThemes são a MESMA função nos 2 builders (não cópias locais divergentes)", () => {
    assert.equal(cursosModule.esc, livrosModule.esc, "esc() deve ser a mesma referência (escHtml canônico)");
    assert.equal(cursosModule.isSafeUrl, isSafeUrl, "isSafeUrl re-exportado deve ser o do módulo compartilhado");
    assert.equal(livrosModule.isSafeUrl, isSafeUrl, "isSafeUrl re-exportado deve ser o do módulo compartilhado");
    assert.equal(cursosModule.availableThemes, availableThemes);
    assert.equal(livrosModule.availableThemes, availableThemes);
    assert.equal(cursosModule.distinctThemes, distinctThemes);
    assert.equal(livrosModule.distinctThemes, distinctThemes);
  });
});
