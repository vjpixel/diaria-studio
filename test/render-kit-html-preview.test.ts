/**
 * test/render-kit-html-preview.test.ts (#6506)
 *
 * `render-kit-html-preview.ts` mede o tamanho do HTML Kit ANTES do cutover
 * (backend ainda `"beehiiv"` em platform.config.json) — sem isso,
 * `checkKitHtmlSize` (stage-4.ts) nunca teria artefato pra medir. Cobre:
 * (a) roda sem `platform.config.json`/backend "kit" (ao contrário de
 *     publish-newsletter-kit.ts, este script NÃO é gated pelo backend —
 *     é só medição, sempre relevante durante a migração);
 * (b) escreve `_internal/newsletter-final-kit.html`;
 * (c) nenhuma chamada de rede (mesmo padrão de `--dry-run` em
 *     publish-newsletter-kit.test.ts — fetch mockado que lança se chamado).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resolveOutputPath } from "../scripts/render-kit-html-preview.ts";

const REVIEWED_MD = [
  "TÍTULO",
  "",
  "Modelos se replicam sozinhos",
  "",
  "SUBTÍTULO",
  "",
  "Segundo destaque | Terceiro destaque",
  "",
  "---",
  "",
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[Modelos se replicam sozinhos](https://example.com/1)**",
  "",
  "Corpo do destaque um com contexto suficiente pra render.",
  "",
  "Por que isso importa: razão um.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | RADAR**",
  "",
  "**[Segundo destaque](https://example.com/2)**",
  "",
  "Corpo dois.",
  "",
  "Por que isso importa: razão dois.",
  "",
].join("\n");

function writeEdition(root: string, date: string): string {
  const dir = join(root, "data/editions", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  return dir;
}

let originalArgv: string[];
let originalFetch: typeof fetch;

afterEach(() => {
  process.argv = originalArgv;
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("render-kit-html-preview main() (#6506)", () => {
  it("sem platform.config.json / backend beehiiv: roda normalmente (não é gated pelo backend, ao contrário de publish-newsletter-kit.ts)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-preview-"));
    try {
      const editionDir = writeEdition(root, "260997");
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("render-kit-html-preview nunca deveria chamar a rede");
      }) as typeof fetch;
      originalArgv = process.argv;
      process.argv = ["node", "render-kit-html-preview.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.notEqual(process.exitCode, 1);

      const outPath = resolveOutputPath(editionDir);
      assert.ok(existsSync(outPath), "_internal/newsletter-final-kit.html gravado");
      const html = readFileSync(outPath, "utf8");
      assert.match(html, /Modelos se replicam sozinhos/);
      assert.ok(!html.includes("<!doctype"), "fragmento, não documento completo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem <edition-dir>: exitCode 1, sem gravar nada", async () => {
    originalArgv = process.argv;
    process.argv = ["node", "render-kit-html-preview.ts"];
    process.exitCode = undefined;
    await main(mkdtempSync(join(tmpdir(), "kit-preview-noargs-")));
    assert.equal(process.exitCode, 1);
  });

  it("2ª invocação sobrescreve o mesmo arquivo (idempotente, mesmo padrão do render Beehiiv)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-preview-idem-"));
    try {
      const editionDir = writeEdition(root, "260996");
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("nunca deveria chamar a rede");
      }) as typeof fetch;
      originalArgv = process.argv;
      process.argv = ["node", "render-kit-html-preview.ts", editionDir];

      process.exitCode = undefined;
      await main(root);
      const first = readFileSync(resolveOutputPath(editionDir), "utf8");

      process.exitCode = undefined;
      await main(root);
      const second = readFileSync(resolveOutputPath(editionDir), "utf8");

      assert.equal(first, second, "mesmo conteúdo re-gravado, não acumula/duplica");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
