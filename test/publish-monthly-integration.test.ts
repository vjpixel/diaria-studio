import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { main } from "../scripts/publish-monthly.ts";

/**
 * Integration test do main() do publish-monthly (#1029).
 *
 * Estratégia pragmática:
 *   - Testa fluxo end-to-end VIA --dry-run (não toca Brevo/Cloudflare API)
 *   - Mock de process.argv pra injetar flags
 *   - Fixture controlado em tempdir
 *   - Cobertura: parse draft → render HTML → escrever preview file
 *
 * Out of scope (precisa mock de fetch — issue follow-up):
 *   - Brevo POST /emailCampaigns (criar)
 *   - Brevo PUT /emailCampaigns/{id} (update + schedule)
 *   - Brevo /sendTest e /sendNow
 *   - Cloudflare KV upload de imagens
 *   - Test counter timing
 *   - Status pre-check em --update-existing
 */

const FIXTURE_SRC = resolve(import.meta.dirname, "fixtures/publish-monthly/2604");

let tmpMonthlyDir: string;
const originalArgv = process.argv;
const originalExit = process.exit;
let exitCode: number | null = null;

function setupTmpDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "publish-monthly-test-"));
  // Copia fixture inteira (incluindo _internal/)
  copyFileSync(join(FIXTURE_SRC, "draft.md"), join(tmp, "draft.md"));
  mkdirSync(join(tmp, "_internal"), { recursive: true });
  return tmp;
}

function mockProcessExit(): void {
  exitCode = null;
  // @ts-expect-error mocking
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}

function restoreProcessExit(): void {
  process.exit = originalExit;
}

before(() => {
  tmpMonthlyDir = setupTmpDir();
});

after(() => {
  if (tmpMonthlyDir) rmSync(tmpMonthlyDir, { recursive: true, force: true });
  process.argv = originalArgv;
});

describe("publish-monthly main(): dry-run end-to-end (#1029)", () => {
  it("dry-run com --send-test: gera preview HTML, não chama API", async () => {
    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--send-test",
      "--dry-run",
    ];
    await main(tmpMonthlyDir);

    // Preview HTML escrito em _internal/
    const previewPath = join(tmpMonthlyDir, "_internal", "preview-list9.html");
    assert.ok(existsSync(previewPath), `Preview HTML deve existir em ${previewPath}`);

    const html = readFileSync(previewPath, "utf8");
    // Sanity: contém DOCTYPE + título derivado do ASSUNTO
    assert.match(html, /<!DOCTYPE html/);
    assert.match(html, /<title>Edição de Teste<\/title>/);
    // Body parts: INTRO renderizada como "Resumo do mês"
    assert.match(html, /Resumo do mês/i);
    // Destaque renderizado
    assert.match(html, /Título do destaque de teste/);
    // PARA ENCERRAR renderizado
    assert.match(html, /Fim da edição de teste/);
  });

  it("dry-run com --schedule-at: preview gerado, sem dispatch", async () => {
    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "10",
      "--schedule-at", "2099-01-01T00:00:00Z",
      "--dry-run",
    ];
    await main(tmpMonthlyDir);

    const previewPath = join(tmpMonthlyDir, "_internal", "preview-list10.html");
    assert.ok(existsSync(previewPath), "Preview HTML pra list 10 deve existir");
  });

  it("dry-run com --update-existing: preview gerado", async () => {
    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--update-existing", "42",
      "--dry-run",
    ];
    await main(tmpMonthlyDir);

    const previewPath = join(tmpMonthlyDir, "_internal", "preview-list9.html");
    assert.ok(existsSync(previewPath));
    // No dry-run, não tenta GET /emailCampaigns/42 nem PUT
  });

  it("falha quando draft.md não existe", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "publish-monthly-empty-"));
    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--dry-run",
    ];
    mockProcessExit();
    try {
      await main(emptyDir);
      assert.fail("Esperava throw via mocked exit");
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__mocked_exit__") throw e;
      assert.equal(exitCode, 1, "Deve sair com code 1 quando draft.md falta");
    } finally {
      restoreProcessExit();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
