/**
 * test/safe-rename-in-data.test.ts (#8058)
 *
 * Cobre `scripts/lib/safe-rename-in-data.ts`: cópia bem-sucedida remove o
 * original; falha de verificação (tamanho/hash não batem) NUNCA remove o
 * original. Usa um diretório temporário real (fora de `data/`) — o
 * mecanismo em si não depende de OneDrive, só do padrão copy+verify+delete.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeRenameInData,
  type SafeRenameDeps,
} from "../scripts/lib/safe-rename-in-data.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safe-rename-in-data-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("safeRenameInData — caminho feliz", () => {
  it("copia com sucesso remove o original e preserva o conteúdo no destino", () => {
    const from = join(dir, "04-d2-1x1.jpg");
    const to = join(dir, "04-d1-1x1.jpg");
    writeFileSync(from, "conteudo-da-imagem");

    safeRenameInData(from, to);

    assert.equal(existsSync(from), false, "original deve ser removido após verificação passar");
    assert.equal(existsSync(to), true, "destino deve existir");
    assert.equal(readFileSync(to, "utf8"), "conteudo-da-imagem");
  });

  it("com verifyHash: true, também passa quando conteúdo bate byte-a-byte", () => {
    const from = join(dir, "prompt.md");
    const to = join(dir, "prompt-renamed.md");
    writeFileSync(from, "# prompt de imagem\nVan Gogh impasto");

    safeRenameInData(from, to, { verifyHash: true });

    assert.equal(existsSync(from), false);
    assert.equal(readFileSync(to, "utf8"), "# prompt de imagem\nVan Gogh impasto");
  });
});

describe("safeRenameInData — origem ausente", () => {
  it("lança erro e nunca chama copyFileSync se a origem não existe", () => {
    const from = join(dir, "nao-existe.jpg");
    const to = join(dir, "destino.jpg");

    assert.throws(() => safeRenameInData(from, to), /origem não existe/);
    assert.equal(existsSync(to), false);
  });
});

describe("safeRenameInData — falha de verificação NUNCA remove o original", () => {
  it("tamanho do destino não bate com o original (cópia truncada simulada) — original preservado", () => {
    const from = join(dir, "04-d3-2x1.jpg");
    const to = join(dir, "04-d2-2x1.jpg");
    writeFileSync(from, "conteudo-original-de-13-bytes");

    // Simula um provedor de sync que "corrompe"/trunca a cópia: injeta um
    // copyFileSync que escreve menos bytes do que o original.
    const deps: SafeRenameDeps = {
      copyFileSync: () => {
        writeFileSync(to, "truncado");
      },
      existsSync,
      statSync,
      unlinkSync: () => {
        throw new Error("unlinkSync NUNCA deveria ser chamado quando a verificação falha");
      },
      readFileSync,
    };

    assert.throws(() => safeRenameInData(from, to, { deps }), /não bate com o original/);
    assert.equal(existsSync(from), true, "original deve ser preservado quando o tamanho não bate");
    assert.equal(readFileSync(from, "utf8"), "conteudo-original-de-13-bytes");
  });

  it("destino não existe logo após a cópia (conflito de sync simulado) — original preservado", () => {
    const from = join(dir, "04-d1-4x5.jpg");
    const to = join(dir, "04-d1-4x5-novo.jpg");
    writeFileSync(from, "conteudo-imagem-destaque");

    const deps: SafeRenameDeps = {
      // Simula o provedor de sync descartando a escrita — copyFileSync
      // "roda" mas o arquivo nunca aparece no disco.
      copyFileSync: () => {},
      existsSync: (p) => (p === to ? false : existsSync(p)),
      statSync,
      unlinkSync: () => {
        throw new Error("unlinkSync NUNCA deveria ser chamado quando a verificação falha");
      },
      readFileSync,
    };

    assert.throws(() => safeRenameInData(from, to, { deps }), /destino não existe/);
    assert.equal(existsSync(from), true, "original deve ser preservado");
  });

  it("verifyHash: true detecta conteúdo divergente mesmo com tamanho igual — original preservado", () => {
    const from = join(dir, "02-d1-prompt.md");
    const to = join(dir, "02-d2-prompt.md");
    const original = "AAAAAAAAAA"; // 10 bytes
    const corrupted = "BBBBBBBBBB"; // 10 bytes, conteúdo diferente
    writeFileSync(from, original);

    const deps: SafeRenameDeps = {
      copyFileSync: () => {
        writeFileSync(to, corrupted);
      },
      existsSync,
      statSync,
      unlinkSync: () => {
        throw new Error("unlinkSync NUNCA deveria ser chamado quando a verificação falha");
      },
      readFileSync,
    };

    assert.throws(
      () => safeRenameInData(from, to, { deps, verifyHash: true }),
      /hash de .* não bate/,
    );
    assert.equal(existsSync(from), true, "original deve ser preservado quando o hash não bate");
    assert.equal(readFileSync(from, "utf8"), original);
  });
});
