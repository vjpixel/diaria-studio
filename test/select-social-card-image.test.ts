/**
 * test/select-social-card-image.test.ts (#4090 item 5, #12226, regressão #633)
 *
 * Teste COMPORTAMENTAL do seletor usado por publish-facebook.ts e
 * publish-instagram.ts (3 call sites: dispatch inicial de FB, reschedule de
 * FB, dispatch de IG).
 *
 * #12226: o 1:1 deixou de ser gerado e o fallback 4:5 → 1:1 saiu. 4:5 ausente
 * agora falha alto no caller — nunca cai pro 1x1 sem título, nem quando um
 * 1x1 de edição antiga está no disco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  selectSocialCardImageFile,
  hasSocialCardImage,
  missingSocialCardReason,
} from "../scripts/lib/select-social-card-image.ts";

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-select-card-"));
}

describe("selectSocialCardImageFile (#4090 item 5, #12226)", () => {
  it("usa o card 4:5 quando ele existe no disco", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("fake-4x5-bytes"));
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-4x5.jpg");
      assert.equal(hasSocialCardImage(dir, "d1"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO #12226 — 4:5 ausente com 1x1 legado no disco: NÃO cai pro 1x1", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.from("fake-1x1-bytes"));
      assert.equal(selectSocialCardImageFile(dir, "d1"), "04-d1-4x5.jpg");
      assert.equal(hasSocialCardImage(dir, "d1"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("é por-destaque — d2 com 4:5 não afeta d1 sem 4:5", () => {
    const dir = makeFixtureDir();
    try {
      writeFileSync(join(dir, "04-d2-4x5.jpg"), Buffer.from("fake-4x5-bytes"));
      assert.equal(hasSocialCardImage(dir, "d1"), false);
      assert.equal(hasSocialCardImage(dir, "d2"), true);
      assert.equal(selectSocialCardImageFile(dir, "d2"), "04-d2-4x5.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missingSocialCardReason nomeia o card, o comando e a ausência de fallback", () => {
    const r = missingSocialCardReason("d3");
    assert.match(r, /04-d3-4x5\.jpg not found/);
    assert.match(r, /gen-social-card-4x5\.ts/);
    assert.match(r, /#12226/);
  });
});

describe("publishers de feed falham alto sem o 4:5, sem cair pro 1x1 (#12226)", () => {
  for (const f of ["publish-facebook.ts", "publish-instagram.ts"]) {
    const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", f), "utf8");
    it(`${f}: nenhum caminho 04-*-1x1.jpg no código e entry failed usa missingSocialCardReason`, () => {
      assert.doesNotMatch(src, /-1x1\.jpg/);
      assert.match(src, /missingSocialCardReason\(d\)/);
    });
  }
});
