/**
 * #13997: o corretor Clarice da edição (Stage 2/4) mora em scripts/lib/diaria/,
 * separado do programa de e-mail Clarice (que segue em scripts/lib/clarice-*).
 *
 * Trava: (1) os 6 módulos do corretor existem em diaria/ e não voltaram para a
 * raiz de lib; (2) as funções extraídas para módulos-folha no mesmo PR (para
 * cortar a ponte mensal -> diária do test/lib-boundary.test.ts) seguem sendo
 * as MESMAS que os pontos de import antigos reexportam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as cropEntry from "../scripts/lib/crop-review-entry.ts";
import * as stage4 from "../scripts/lib/invariant-checks/stage-4.ts";
import { cloudflareKvKey as kvKeyLib } from "../scripts/lib/cloudflare-kv-key.ts";
import { cloudflareKvKey as kvKeyCli } from "../scripts/upload-images-public.ts";
import { countOccurrences as countLib } from "../scripts/lib/diaria/clarice-chunk.ts";
import { countOccurrences as countCli } from "../scripts/clarice-apply.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORRETOR = [
  "clarice-chunk",
  "clarice-correct-engine",
  "clarice-pending",
  "clarice-pending-marker",
  "clarice-review-credit",
  "clarice-suggestion-guard",
];

describe("corretor Clarice em scripts/lib/diaria/ (#13997)", () => {
  for (const name of CORRETOR) {
    it(`${name}.ts mora em diaria/ e não na raiz de lib`, () => {
      assert.ok(existsSync(join(ROOT, "scripts", "lib", "diaria", `${name}.ts`)), `diaria/${name}.ts ausente`);
      assert.ok(!existsSync(join(ROOT, "scripts", "lib", `${name}.ts`)), `scripts/lib/${name}.ts voltou para a raiz`);
    });
  }

  it("stage-4 reexporta os helpers do veredito de crop sem cópia", () => {
    for (const k of [
      "CROP_REVIEW_IMAGE_VARIANTS",
      "isCropReviewImageVariant",
      "cropReviewImageSuffix",
      "isCropReviewEntryStale",
      "isSilencedCropWarn",
    ] as const) {
      assert.equal(stage4[k], cropEntry[k], `stage-4.${k} diverge de crop-review-entry.${k}`);
    }
  });

  it("upload-images-public e clarice-apply reexportam a função de lib", () => {
    assert.equal(kvKeyCli, kvKeyLib);
    assert.equal(countCli, countLib);
    assert.equal(kvKeyLib("data/editions/260512/", "d1-2x1.jpg", "0123456789abcdef"), "img-260512-d1-2x1-01234567.jpg");
    assert.equal(countLib("aaa", "aa"), 1);
  });
});
