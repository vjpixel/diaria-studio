/**
 * test/poll-kv-put.test.ts (#1237)
 *
 * Regression test pra CLI poll-kv-put.ts: garante que JSON com aspas duplas
 * aninhadas é passado intacto pro wrangler (sem shell escape corruption).
 *
 * Estratégia: rodar a CLI com --help (não toca KV) + parsing/validação de args.
 * Test do PUT real precisaria mock de wrangler ou ambiente KV — fora de escopo
 * pra teste rápido. O test cobre validação de input + erro reporting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/poll-kv-put.ts");

describe("poll-kv-put.ts (#1237)", () => {
  function run(args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, ...args],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env } },
    );
  }

  it("--help exibe usage e exit 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Uso:/);
    assert.match(r.stdout, /--key/);
    assert.match(r.stdout, /--value/);
    assert.match(r.stdout, /--json/);
    assert.match(r.stdout, /--path/);
  });

  it("sem --key retorna exit 2 + mensagem", () => {
    const r = run(["--value", "test"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--key é obrigatório/);
  });

  it("sem fonte de value retorna exit 2", () => {
    const r = run(["--key", "test"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exatamente UM de/);
  });

  it("múltiplas fontes de value retornam exit 2", () => {
    const r = run(["--key", "test", "--value", "a", "--json", "{}"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exatamente UM de/);
  });

  it("--json com JSON inválido retorna exit 2 antes de tentar gravar", () => {
    const r = run(["--key", "test", "--json", "{invalid"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não é JSON válido/);
  });

  it("--path com arquivo inexistente retorna exit 2", () => {
    const r = run(["--key", "test", "--path", "/nonexistent/file.json"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Erro lendo --path/);
  });

  it("--path com arquivo válido lê conteúdo (sem chamar KV se mockarmos)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kv-test-"));
    const file = join(dir, "val.json");
    try {
      writeFileSync(file, '{"total":2,"voted_a":1}', "utf8");
      // Sem CLOUDFLARE_WORKERS_TOKEN o wrangler vai falhar — mas validamos só
      // que chega no passo do wrangler (exit != 2 = parsing passou).
      const r = run([
        "--key",
        "test:fake",
        "--path",
        file,
      ]);
      // Pode ser 1 (wrangler falhou) ou 0 (se ambiente tem auth) — mas NÃO 2.
      assert.notEqual(r.status, 2, "parsing/validação deve passar antes do wrangler");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
