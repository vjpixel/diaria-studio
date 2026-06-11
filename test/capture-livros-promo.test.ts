/**
 * capture-livros-promo.test.ts (#2071)
 *
 * Testa a lógica determinística de `scripts/capture-livros-promo.ts`:
 *   1. md5 igual → status "skipped" (idempotência).
 *   2. md5 diferente → status "captured" + arquivo gravado.
 *   3. força (--force) → captura mesmo com md5 igual.
 *   4. dry-run → captura/compara mas NÃO grava em editionDir.
 *   5. arquivo inexistente → sempre captura (md5Old = null).
 *
 * NÃO executa puppeteer real (guarda de CI). A `captureFn` é injetada como
 * mock que escreve bytes determinísticos em `outPath`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  captureLivrosPromo,
  md5Hex,
  LIVROS_PROMO_FILENAME,
} from "../scripts/capture-livros-promo.ts";

/** Cria um mock de captureFn que grava `bytes` em outPath. */
function mockCapture(bytes: Buffer) {
  return async (_url: string, outPath: string) => {
    writeFileSync(outPath, bytes);
  };
}

/** Conteúdo arbitrário de "screenshot". */
const BYTES_A = Buffer.from("screenshot-a");
const BYTES_B = Buffer.from("screenshot-b");
const MD5_A = createHash("md5").update(BYTES_A).digest("hex");
const MD5_B = createHash("md5").update(BYTES_B).digest("hex");

describe("captureLivrosPromo — lógica de idempotência (#2071)", () => {
  it("arquivo inexistente → captura e grava (md5Old = null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      const result = await captureLivrosPromo(dir, {
        captureFn: mockCapture(BYTES_A),
      });
      assert.equal(result.status, "captured");
      assert.equal(result.md5Old, null);
      assert.equal(result.md5New, MD5_A);
      assert.ok(
        existsSync(join(dir, LIVROS_PROMO_FILENAME)),
        "arquivo deve ser gravado",
      );
      const gravado = readFileSync(join(dir, LIVROS_PROMO_FILENAME));
      assert.deepEqual(gravado, BYTES_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("md5 igual → status skipped (idempotente, não sobrescreve)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      // Pré-existente com mesmo conteúdo
      writeFileSync(join(dir, LIVROS_PROMO_FILENAME), BYTES_A);
      const result = await captureLivrosPromo(dir, {
        captureFn: mockCapture(BYTES_A),
      });
      assert.equal(result.status, "skipped");
      assert.equal(result.md5Old, MD5_A);
      assert.equal(result.md5New, MD5_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("md5 diferente → captura e grava (md5Old mudou)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      // Pré-existente com conteúdo ANTIGO
      writeFileSync(join(dir, LIVROS_PROMO_FILENAME), BYTES_A);
      const result = await captureLivrosPromo(dir, {
        captureFn: mockCapture(BYTES_B), // nova versão da página
      });
      assert.equal(result.status, "captured");
      assert.equal(result.md5Old, MD5_A);
      assert.equal(result.md5New, MD5_B);
      // Arquivo atualizado com o novo conteúdo
      const gravado = readFileSync(join(dir, LIVROS_PROMO_FILENAME));
      assert.deepEqual(gravado, BYTES_B);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force → captura mesmo com md5 igual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      writeFileSync(join(dir, LIVROS_PROMO_FILENAME), BYTES_A);
      const result = await captureLivrosPromo(dir, {
        force: true,
        captureFn: mockCapture(BYTES_A), // mesmo md5
      });
      assert.equal(result.status, "captured", "force deve capturar mesmo com md5 igual");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run → compara md5 mas NÃO grava em editionDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      // Sem arquivo pré-existente; dry-run deve capturar em temp mas NÃO gravar
      const result = await captureLivrosPromo(dir, {
        dryRun: true,
        captureFn: mockCapture(BYTES_A),
      });
      assert.equal(result.status, "captured", "dry-run: md5 mudou (sem arquivo prévio)");
      assert.ok(
        !existsSync(join(dir, LIVROS_PROMO_FILENAME)),
        "dry-run NÃO deve gravar em editionDir",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run com md5 igual → skipped (sem gravar)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-promo-"));
    try {
      writeFileSync(join(dir, LIVROS_PROMO_FILENAME), BYTES_A);
      const result = await captureLivrosPromo(dir, {
        dryRun: true,
        captureFn: mockCapture(BYTES_A),
      });
      assert.equal(result.status, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("md5Hex — função pura (#2071)", () => {
  it("mesmo buffer → mesmo hash", () => {
    assert.equal(md5Hex(BYTES_A), md5Hex(Buffer.from("screenshot-a")));
  });

  it("buffers distintos → hashes distintos", () => {
    assert.notEqual(md5Hex(BYTES_A), md5Hex(BYTES_B));
  });

  it("retorna string hex de 32 chars", () => {
    assert.match(md5Hex(BYTES_A), /^[0-9a-f]{32}$/);
  });
});
