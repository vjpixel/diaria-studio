/**
 * test/image-generate-stale-derived.test.ts (#6010)
 *
 * Regressão do achado ao vivo edição 260824: D1 foi trocado no meio do
 * Stage 4 (artigo A → artigo B). A cascata de título regenerou corretamente
 * o par 2x1/1x1, mas um `04-d1-4x5-nativo.jpg` do artigo ANTIGO sobreviveu
 * no disco — `gen-social-card-4x5.ts`'s `generateCard()` prioriza o nativo
 * sobre o 2x1 na cadeia de fallback, então o card social 4:5 continuou
 * mostrando a arte errada por 3 rodadas de regeneração/republicação.
 *
 * `computeStaleDerivedImages` é a decisão pura (extraída pro mesmo padrão de
 * `resolveWideImageIntegrity`, #4989) de QUAIS formatos derivados purgar
 * dado o resultado de `resolveWideImageIntegrity` — testável sem tocar disco
 * nem chamar o gerador de imagem real (proibido em teste).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeStaleDerivedImages,
  staleDerivedImagePaths,
  resolveWideImageIntegrity,
} from "../scripts/image-generate.ts";

describe("staleDerivedImagePaths — paths dos formatos derivados por destaque (#6010)", () => {
  it("monta os 2 paths (4x5-nativo + master) a partir de out-dir + destaque", () => {
    const paths = staleDerivedImagePaths("data/editions/260824/", "d1");
    assert.deepEqual(paths, [
      "data/editions/260824/04-d1-4x5-nativo.jpg",
      "data/editions/260824/04-d1-master.jpg",
    ]);
  });

  it("normaliza out-dir sem barra final (mesmo comportamento de main())", () => {
    const paths = staleDerivedImagePaths("data/editions/260824", "d2");
    assert.deepEqual(paths, [
      "data/editions/260824/04-d2-4x5-nativo.jpg",
      "data/editions/260824/04-d2-master.jpg",
    ]);
  });
});

describe("computeStaleDerivedImages — CASO REAL #6010: só invalida derivados quando o 2x1 é DE FATO regenerado", () => {
  it("action.kind === 'regenerate' (troca de destaque / --force) → retorna os 2 paths derivados a purgar", () => {
    const action = resolveWideImageIntegrity(false, false, false); // 2x1 ausente → regenerate
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.deepEqual(stale, [
      "data/editions/260824/04-d1-4x5-nativo.jpg",
      "data/editions/260824/04-d1-master.jpg",
    ]);
  });

  it("--force sempre regenerate → também purga derivados, mesmo com 2x1/1x1 já presentes", () => {
    const action = resolveWideImageIntegrity(true, true, true);
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.equal(stale.length, 2);
  });

  it("action.kind === 'skip' (ambos presentes, sem --force) → NÃO purga — 2x1 não mudou, nativo/master continuam válidos", () => {
    const action = resolveWideImageIntegrity(true, true, false);
    assert.deepEqual(action, { kind: "skip" });
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.deepEqual(stale, []);
  });

  it("action.kind === 'derive-1x1-from-2x1' (só 2x1 presente) → NÃO purga — 2x1 existente não é regenerado, só o 1x1 é derivado dele", () => {
    const action = resolveWideImageIntegrity(true, false, false);
    assert.deepEqual(action, { kind: "derive-1x1-from-2x1" });
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.deepEqual(
      stale,
      [],
      "derivar o 1x1 a partir de um 2x1 já presente nunca muda o conteúdo do 2x1 — nativo/master seguem válidos",
    );
  });
});
