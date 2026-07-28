/**
 * test/select-social-card-image.test.ts (#4090 item 5, regressão #633)
 *
 * Teste COMPORTAMENTAL da precedência 4:5 → 1:1 usada por publish-facebook.ts
 * e publish-instagram.ts. Substitui a checagem por regex que existia em
 * gen-social-card-4x5.test.ts (só confirmava que as duas strings de filename
 * apareciam no source, sem provar a ORDEM da precedência) — este teste cria
 * arquivos reais num diretório temporário e exercita a função de fato.
 *
 * Caso real fechado ao extrair esta função (self-review do #4090): o fluxo
 * `--reschedule` do publish-facebook.ts tinha um 3º call site que nunca
 * checava o 4:5 — sempre 1x1, mesmo com o card presente. Com os 3 call sites
 * (dispatch inicial de FB, reschedule de FB, dispatch de IG) usando a mesma
 * função, essa divergência não pode mais existir sem quebrar este teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectSocialCardImageFile } from "../scripts/lib/select-social-card-image.ts";

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-select-card-"));
}

describe("selectSocialCardImageFile (#4090 item 5)", () => {
  it("prefere o card 4:5 quando ele existe no disco", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("fake-4x5-bytes"));
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.from("fake-1x1-bytes"));
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-4x5.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cai pro 1:1 quando o 4:5 não existe (edição legada / geração ainda não rodou)", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.from("fake-1x1-bytes"));
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-1x1.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cai pro 1:1 quando NENHUM dos dois existe (o caller checa existsSync do resultado depois — não é papel desta função reportar erro)", () => {
    const dir = makeFixtureDir();
    try {
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-1x1.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("é por-destaque — d2 com 4:5 não afeta d1 sem 4:5, e vice-versa", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d2-4x5.jpg"), Buffer.from("fake-4x5-bytes"));
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.from("fake-1x1-bytes"));
      writeFileSync(join(dir, "04-d2-1x1.jpg"), Buffer.from("fake-1x1-bytes"));
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-1x1.jpg");
      assert.equal(selectSocialCardImageFile(dir, "d2"), "04-d2-4x5.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
