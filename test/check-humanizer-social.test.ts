/**
 * test/check-humanizer-social.test.ts (#2279)
 *
 * Testes de regressão para check-humanizer-social.ts:
 * - hash-match → exit 0
 * - sentinel ausente → exit 1
 * - hash diverge (social editado pós-humanização) → exit 2
 *
 * Simula o cenário real da edição 260615: social editado/reordenado após
 * humanização sem re-humanizar. Garante que o guard bloqueia nesse caso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSentinel,
  computeSocialHash,
  writeSentinel,
} from "../scripts/check-humanizer-social.ts";

const SOCIAL_CONTENT_A = `# LinkedIn
## d1
Post humanizado sem travessões.

# Facebook
## d1
Post humanizado sem marks IA.
`;

const SOCIAL_CONTENT_B = `# LinkedIn
## d1
Post DIFERENTE — editado manualmente pelo editor no gate do Stage 4.

# Facebook
## d1
Post também diferente.
`;

function mkEdition(socialContent?: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-social-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (socialContent !== undefined) {
    writeFileSync(join(dir, "03-social.md"), socialContent, "utf8");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("computeSocialHash (#2279)", () => {
  it("retorna hash sha256 hex de 64 chars", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const hash = computeSocialHash(join(dir, "03-social.md"));
      assert.equal(typeof hash, "string");
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]+$/);
    } finally {
      cleanup();
    }
  });

  it("hash difere para conteúdo diferente", () => {
    const { dir: dirA, cleanup: cleanupA } = mkEdition(SOCIAL_CONTENT_A);
    const { dir: dirB, cleanup: cleanupB } = mkEdition(SOCIAL_CONTENT_B);
    try {
      const hashA = computeSocialHash(join(dirA, "03-social.md"));
      const hashB = computeSocialHash(join(dirB, "03-social.md"));
      assert.notEqual(hashA, hashB);
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  it("hash idêntico para conteúdo idêntico (CRLF normalizado)", () => {
    const { dir: dirA, cleanup: cleanupA } = mkEdition(SOCIAL_CONTENT_A);
    // CRLF variant
    const { dir: dirB, cleanup: cleanupB } = mkEdition(SOCIAL_CONTENT_A.replace(/\n/g, "\r\n"));
    try {
      const hashA = computeSocialHash(join(dirA, "03-social.md"));
      const hashB = computeSocialHash(join(dirB, "03-social.md"));
      assert.equal(hashA, hashB, "CRLF e LF devem produzir o mesmo hash");
    } finally {
      cleanupA();
      cleanupB();
    }
  });
});

describe("writeSentinel (#2279)", () => {
  it("grava sentinel com sha256 do 03-social.md e retorna path", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const path = writeSentinel(dir);
      assert.match(path, /_internal[/\\]\.humanizer-social-done\.json$/);
      assert.ok(existsSync(path), "sentinel deve existir no disco");
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(typeof data.social_sha256 === "string");
      assert.equal(data.social_sha256.length, 64);
      assert.ok(typeof data.written_at === "string");
    } finally {
      cleanup();
    }
  });

  it("lança erro quando 03-social.md não existe", () => {
    const { dir, cleanup } = mkEdition(); // sem social
    try {
      assert.throws(() => writeSentinel(dir), /03-social\.md não existe/);
    } finally {
      cleanup();
    }
  });
});

describe("checkSentinel (#2279) — cenários de regressão", () => {
  it("OK: sentinel presente e hash bate (humanizador rodou, social intacto)", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // escreve sentinel com hash de CONTENT_A
      const result = checkSentinel(dir);
      assert.equal(result.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: humanizador nunca rodou (sem sentinel)", () => {
    // Cenário regressão 260615 furo (a): nada bloqueou quando humanizador foi
    // feito manualmente sem gravar sentinel.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      // Não chama writeSentinel → sentinel ausente
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });

  it("FAIL hash_mismatch: social editado pós-humanização sem re-humanizar", () => {
    // Cenário regressão 260615 furo (b): após reorder D3>D1>D2 e reescrita
    // do post_pixel no gate do Stage 4, social mudou mas não houve re-humanização.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir); // sentinel com hash de CONTENT_A
      // Simula edição posterior: editor reescreve o social no gate
      writeFileSync(join(dir, "03-social.md"), SOCIAL_CONTENT_B, "utf8");
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "hash_mismatch");
      // Garantir que stored e current são expostos para logging
      assert.ok("stored" in result && typeof result.stored === "string");
      assert.ok("current" in result && typeof result.current === "string");
      assert.notEqual(result.stored, result.current);
    } finally {
      cleanup();
    }
  });

  it("OK: 03-social.md ausente (stage 2 ainda não rodou) — não bloquear", () => {
    // Sentinel pode existir de run anterior mas social sumiu — não é caso normal,
    // mas não deve gerar false-positive.
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      writeSentinel(dir);
      rmSync(join(dir, "03-social.md")); // simula social ausente
      const result = checkSentinel(dir);
      assert.equal(result.ok, true, "sem 03-social.md não deve bloquear");
    } finally {
      cleanup();
    }
  });

  it("FAIL sentinel_missing: sentinel JSON corrompido", () => {
    const { dir, cleanup } = mkEdition(SOCIAL_CONTENT_A);
    try {
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      writeFileSync(sentinelPath, "{ json inválido }", "utf8");
      const result = checkSentinel(dir);
      assert.equal(result.ok, false);
      assert.ok("reason" in result && result.reason === "sentinel_missing");
    } finally {
      cleanup();
    }
  });
});
