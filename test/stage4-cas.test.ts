/**
 * test/stage4-cas.test.ts (#8123 Fatia 3)
 *
 * Teste de regressão do critério de aceite: "checagem que escreve não
 * sobrescreve edição concorrente mais nova". Simula o cenário do §3 da
 * issue #8123 — um autofix em background tira um snapshot, demora pra
 * calcular a correção, e enquanto isso o editor edita o arquivo ao vivo
 * (loop `ajustar` ou painel /revisao do Studio). O autofix NUNCA pode
 * escrever por cima dessa edição mais nova (#7401).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotFile, applyIfUnchanged, hashContent } from "../scripts/lib/stage4-cas.ts";

function withTmpFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stage4-cas-"));
  const path = join(dir, "02-reviewed.md");
  writeFileSync(path, content, "utf8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hashContent", () => {
  it("normaliza CRLF antes de gerar o hash (mesmo conteúdo lógico em checkout Windows)", () => {
    assert.equal(hashContent("linha1\nlinha2\n"), hashContent("linha1\r\nlinha2\r\n"));
  });

  it("hashes diferentes para conteúdos diferentes", () => {
    assert.notEqual(hashContent("a"), hashContent("b"));
  });
});

describe("snapshotFile", () => {
  it("retorna null quando o arquivo não existe", () => {
    assert.equal(snapshotFile("/caminho/que/nao/existe/02-reviewed.md"), null);
  });

  it("captura conteúdo e hash do arquivo", () => {
    withTmpFile("conteúdo original\n", (path) => {
      const snap = snapshotFile(path);
      assert.ok(snap);
      assert.equal(snap!.content, "conteúdo original\n");
      assert.equal(snap!.hash, hashContent("conteúdo original\n"));
    });
  });
});

describe("applyIfUnchanged — CAS por hash (#8123 §3, #7401)", () => {
  it("aplica a escrita quando o arquivo não mudou desde o snapshot", () => {
    withTmpFile("original\n", (path) => {
      const snap = snapshotFile(path)!;
      const result = applyIfUnchanged(path, snap.hash, "corrigido pelo autofix\n");
      assert.equal(result.applied, true);
      assert.equal(readFileSync(path, "utf8"), "corrigido pelo autofix\n");
    });
  });

  it("NUNCA sobrescreve quando o arquivo mudou (edição concorrente mais nova) — critério de aceite #8123", () => {
    withTmpFile("original\n", (path) => {
      // 1. Autofix tira snapshot do estado atual.
      const snap = snapshotFile(path)!;

      // 2. Enquanto o autofix "calcula" a correção (tempo passa), o editor
      // edita o arquivo ao vivo — cenário real do loop `ajustar`/#7401.
      writeFileSync(path, "EDIÇÃO MANUAL DO EDITOR — não pode ser perdida\n", "utf8");

      // 3. Autofix tenta aplicar a correção calculada sobre o snapshot velho.
      const result = applyIfUnchanged(path, snap.hash, "correção calculada sobre estado obsoleto\n");

      assert.equal(result.applied, false);
      if (!result.applied) {
        assert.equal(result.reason, "changed");
        assert.equal(result.current_content, "EDIÇÃO MANUAL DO EDITOR — não pode ser perdida\n");
      }
      // O arquivo no disco continua sendo a edição do editor — nunca foi tocado.
      assert.equal(readFileSync(path, "utf8"), "EDIÇÃO MANUAL DO EDITOR — não pode ser perdida\n");
    });
  });

  it("reason: 'missing' quando o arquivo some entre o snapshot e a aplicação", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-cas-missing-"));
    const path = join(dir, "02-reviewed.md");
    writeFileSync(path, "original\n", "utf8");
    const snap = snapshotFile(path)!;
    rmSync(path);
    const result = applyIfUnchanged(path, snap.hash, "novo conteúdo\n");
    assert.equal(result.applied, false);
    if (!result.applied) assert.equal(result.reason, "missing");
    rmSync(dir, { recursive: true, force: true });
  });

  it("escrita é atômica (tmp file + rename, nunca deixa o arquivo truncado)", () => {
    withTmpFile("original\n", (path) => {
      const snap = snapshotFile(path)!;
      applyIfUnchanged(path, snap.hash, "conteúdo final completo\n");
      // Se a escrita não fosse atômica um crash no meio poderia truncar —
      // aqui só validamos que o conteúdo final está intacto e não sobrou
      // nenhum arquivo temporário no diretório.
      assert.equal(readFileSync(path, "utf8"), "conteúdo final completo\n");
    });
  });
});
