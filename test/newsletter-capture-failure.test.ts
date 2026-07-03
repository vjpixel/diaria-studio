/**
 * test/newsletter-capture-failure.test.ts (#2878)
 *
 * Cobertura do sentinel compartilhado entre `fetch-newsletter-threads.ts`
 * (Stage 0 0b-bis) e `inject-inbox-urls.ts` (Stage 1 1h) que distingue
 * "0 real" de "0b-bis falhou por auth/rede".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureFailedSentinelPath,
  writeCaptureFailedSentinel,
  readCaptureFailedSentinel,
  clearCaptureFailedSentinel,
} from "../scripts/lib/newsletter-capture-failure.ts";

function withTmpInternalDir(test: (internalDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "diaria-capture-failure-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  try {
    test(internalDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("captureFailedSentinelPath", () => {
  it("resolve pro nome canônico dentro do _internal", () => {
    withTmpInternalDir((internalDir) => {
      const p = captureFailedSentinelPath(internalDir);
      assert.equal(p, join(internalDir, ".capture-newsletter-failed.json"));
    });
  });
});

describe("writeCaptureFailedSentinel / readCaptureFailedSentinel round-trip", () => {
  it("grava e lê o sentinel com o erro real (caso 260703: invalid_client)", () => {
    withTmpInternalDir((internalDir) => {
      const outPath = join(internalDir, "captured-newsletters.json");
      writeCaptureFailedSentinel(outPath, new Error("invalid_client: The OAuth client was not found."));
      assert.ok(existsSync(captureFailedSentinelPath(internalDir)));

      const sentinel = readCaptureFailedSentinel(internalDir);
      assert.ok(sentinel);
      assert.equal(sentinel?.failed, true);
      assert.match(sentinel!.error, /invalid_client/);
      assert.ok(sentinel?.at);
    });
  });

  it("aceita erro não-Error (string/objeto lançado)", () => {
    withTmpInternalDir((internalDir) => {
      const outPath = join(internalDir, "captured-newsletters.json");
      writeCaptureFailedSentinel(outPath, "network timeout");
      const sentinel = readCaptureFailedSentinel(internalDir);
      assert.equal(sentinel?.error, "network timeout");
    });
  });

  it("trunca mensagens de erro muito longas (300 chars)", () => {
    withTmpInternalDir((internalDir) => {
      const outPath = join(internalDir, "captured-newsletters.json");
      writeCaptureFailedSentinel(outPath, new Error("x".repeat(1000)));
      const sentinel = readCaptureFailedSentinel(internalDir);
      assert.ok(sentinel!.error.length <= 300);
    });
  });

  it("readCaptureFailedSentinel retorna null quando arquivo ausente", () => {
    withTmpInternalDir((internalDir) => {
      assert.equal(readCaptureFailedSentinel(internalDir), null);
    });
  });

  it("readCaptureFailedSentinel retorna null quando JSON corrompido", () => {
    withTmpInternalDir((internalDir) => {
      writeFileSync(captureFailedSentinelPath(internalDir), "not-json-{{{");
      assert.equal(readCaptureFailedSentinel(internalDir), null);
    });
  });

  it("readCaptureFailedSentinel retorna null quando shape inesperado (failed ausente/false)", () => {
    withTmpInternalDir((internalDir) => {
      writeFileSync(captureFailedSentinelPath(internalDir), JSON.stringify({ failed: false, error: "x" }));
      assert.equal(readCaptureFailedSentinel(internalDir), null);
    });
  });

  it("readCaptureFailedSentinel retorna null quando error não é string", () => {
    withTmpInternalDir((internalDir) => {
      writeFileSync(captureFailedSentinelPath(internalDir), JSON.stringify({ failed: true, error: 123 }));
      assert.equal(readCaptureFailedSentinel(internalDir), null);
    });
  });

  it("writeCaptureFailedSentinel cria o diretório _internal se ausente (best-effort)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-capture-failure-nodir-"));
    try {
      const internalDir = join(dir, "_internal");
      const outPath = join(internalDir, "captured-newsletters.json");
      // internalDir NÃO existe ainda — writeCaptureFailedSentinel deve criar.
      assert.equal(existsSync(internalDir), false);
      writeCaptureFailedSentinel(outPath, new Error("boom"));
      assert.ok(existsSync(captureFailedSentinelPath(internalDir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearCaptureFailedSentinel (#2878 self-review HIGH — cenário de recuperação)", () => {
  it("remove o sentinel stale no caminho de sucesso pós-reautenticação", () => {
    withTmpInternalDir((internalDir) => {
      const outPath = join(internalDir, "captured-newsletters.json");
      // 1ª run falha por auth → grava sentinel.
      writeCaptureFailedSentinel(outPath, new Error("invalid_client"));
      assert.ok(existsSync(captureFailedSentinelPath(internalDir)));
      // editor reautentica; re-run tem sucesso → deve limpar o sentinel.
      clearCaptureFailedSentinel(outPath);
      assert.equal(existsSync(captureFailedSentinelPath(internalDir)), false);
      // e o leitor downstream não sinaliza mais capture_failed.
      assert.equal(readCaptureFailedSentinel(internalDir), null);
    });
  });

  it("é no-op idempotente quando não há sentinel (sucesso sem falha prévia)", () => {
    withTmpInternalDir((internalDir) => {
      const outPath = join(internalDir, "captured-newsletters.json");
      assert.equal(existsSync(captureFailedSentinelPath(internalDir)), false);
      // Não deve lançar quando o arquivo não existe (force: true).
      clearCaptureFailedSentinel(outPath);
      clearCaptureFailedSentinel(outPath);
      assert.equal(existsSync(captureFailedSentinelPath(internalDir)), false);
    });
  });
});
