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
  sdPromptPathFor,
  forcedRegenPurgePaths,
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
    const action = resolveWideImageIntegrity(false, false); // 2x1 ausente → regenerate
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.deepEqual(stale, [
      "data/editions/260824/04-d1-4x5-nativo.jpg",
      "data/editions/260824/04-d1-master.jpg",
    ]);
  });

  it("--force sempre regenerate → também purga derivados, mesmo com o 2x1 já presente", () => {
    const action = resolveWideImageIntegrity(true, true);
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.equal(stale.length, 2);
  });

  it("action.kind === 'skip' (2x1 presente, sem --force) → NÃO purga — 2x1 não mudou, nativo/master continuam válidos", () => {
    const action = resolveWideImageIntegrity(true, false);
    assert.deepEqual(action, { kind: "skip" });
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1");
    assert.deepEqual(stale, []);
  });
});

describe("geração em paralelo do 2x1 e do 4x5 (#14036)", () => {
  it("--keep-4x5-nativo: o 2x1 regerado purga só o master, nunca o nativo que o 4x5 paralelo está gravando", () => {
    const action = resolveWideImageIntegrity(false, false);
    const stale = computeStaleDerivedImages(action, "data/editions/260824/", "d1", { keep4x5Nativo: true });
    assert.deepEqual(stale, ["data/editions/260824/04-d1-master.jpg"]);
  });

  it("sem a flag, a purga segue igual (nativo + master)", () => {
    const action = resolveWideImageIntegrity(false, false);
    assert.equal(computeStaleDerivedImages(action, "data/editions/260824/", "d1", {}).length, 2);
  });

  it("sdPromptPathFor: 2x1 e 4x5 do mesmo destaque gravam o prompt em arquivos diferentes", () => {
    const p2 = sdPromptPathFor("data/editions/260824", "d1", "2x1");
    const p45 = sdPromptPathFor("data/editions/260824/", "d1", "4x5");
    assert.equal(p2, "data/editions/260824/04-d1-sd-prompt.json"); // nome histórico (invariante do Stage 3)
    assert.equal(p45, "data/editions/260824/04-d1-4x5-sd-prompt.json");
    assert.notEqual(p2, p45);
    assert.equal(sdPromptPathFor("x/", "d2", "master"), "x/04-d2-master-sd-prompt.json");
    assert.equal(sdPromptPathFor("x/", "d2", "1x1"), "x/04-d2-sd-prompt.json");
  });

  it("4x5 --force apaga o nativo antigo antes do backend: falha na geração não deixa a arte velha para um re-run sem --force", () => {
    const nativo = "data/editions/260824/04-d1-4x5-nativo.jpg";
    // Cenário do finding: 2x1 regerado com --keep-4x5-nativo, 4x5 forçado.
    // Sem a purga, a falha deixava o nativo antigo e o re-run pulava por "já existe".
    assert.deepEqual(forcedRegenPurgePaths("4x5", true, true, nativo), [nativo]);
    assert.deepEqual(forcedRegenPurgePaths("4x5", true, false, nativo), []); // nada a apagar
    assert.deepEqual(forcedRegenPurgePaths("4x5", false, true, nativo), []); // sem --force: skip-if-exists de sempre
    assert.deepEqual(forcedRegenPurgePaths("master", true, true, "x/04-d1-master.jpg"), []);
    assert.deepEqual(forcedRegenPurgePaths("1x1", true, true, "x/04-d1-1x1.jpg"), []);
  });
});
