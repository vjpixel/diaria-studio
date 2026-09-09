/**
 * test/kit-apoio-tag-parity-7659.test.ts (#7659)
 *
 * Trava a DOBRA temporária entre `scripts/lib/shared/kit-apoio-tag.ts` (novo,
 * genérico) e `scripts/lib/mensal/apoiadores-kit-channel.ts` (#7633, fixado em
 * Mantenedor/Patrono).
 *
 * Por que a dobra existe: o módulo mensal tem uma PR em voo tocando-o (#7651),
 * e reescrevê-lo sobre o genérico agora custaria um conflito maior do que a
 * duplicação temporária vale. A dobra está registrada como issue de
 * follow-up — este teste é o que impede que ela vire divergência silenciosa
 * enquanto os dois convivem: se alguém corrigir um bug de diff/blast radius de
 * um lado só, quebra aqui.
 *
 * Quando o mensal for reescrito sobre o genérico, este arquivo perde o
 * sentido e sai junto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  diffTagMembership,
  evaluateTagBlastRadius,
  checkAudienceNotEmpty,
  resolveAudienceTagId,
  APOIO_TAG_BLAST_RADIUS_THRESHOLD,
} from "../scripts/lib/shared/kit-apoio-tag.ts";
import {
  diffApoiadoresTagMembership,
  evaluateApoiadoresBlastRadius,
  checkApoiadoresAudienceNotEmpty,
  resolveApoiadoresTagId,
  APOIADORES_TAG_BLAST_RADIUS_THRESHOLD,
} from "../scripts/lib/mensal/apoiadores-kit-channel.ts";
import { isSystemicKitFailure } from "../scripts/lib/kit-apoio-tag-sync.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";

const CASOS_DIFF: Array<[string[], string[]]> = [
  [[], []],
  [["a@x.com"], []],
  [[], ["b@x.com"]],
  [["a@x.com", "b@x.com"], ["b@x.com", "c@x.com"]],
  [["  A@X.com "], ["a@x.com"]],
  [["", "  ", "a@x.com"], ["a@x.com", ""]],
];

describe("#7659 — diff de membresia: as duas implementações concordam", () => {
  for (const [desired, current] of CASOS_DIFF) {
    it(`${JSON.stringify(desired)} × ${JSON.stringify(current)}`, () => {
      assert.deepEqual(diffTagMembership(desired, current), diffApoiadoresTagMembership(desired, current));
    });
  }
});

describe("#7659 — blast radius: mesmo limiar e mesma decisão", () => {
  it("o limiar é literalmente o mesmo número", () => {
    assert.equal(APOIO_TAG_BLAST_RADIUS_THRESHOLD, APOIADORES_TAG_BLAST_RADIUS_THRESHOLD);
  });

  for (const [rem, cur, force] of [
    [0, 0, false],
    [0, 10, false],
    [3, 10, false],
    [4, 10, false],
    [4, 10, true],
    [10, 10, false],
    [5, 0, false],
  ] as Array<[number, number, boolean]>) {
    it(`${rem}/${cur} force=${force}`, () => {
      assert.deepEqual(
        evaluateTagBlastRadius(rem, cur, force),
        evaluateApoiadoresBlastRadius(rem, cur, force),
      );
    });
  }

  it("3/10 (30% exato) NÃO bloqueia — o limiar é > , não >=", () => {
    assert.equal(evaluateTagBlastRadius(3, 10, false).blocked, false);
    assert.equal(evaluateTagBlastRadius(4, 10, false).blocked, true);
  });

  it("audiência vazia nunca bloqueia (é o estado da 1ª sincronização)", () => {
    assert.equal(evaluateTagBlastRadius(5, 0, false).blocked, false);
  });
});

describe("#7659 — guards de audiência: mesmo veredito (a MENSAGEM difere de propósito)", () => {
  for (const count of [-1, 0, 1, 3.5]) {
    it(`memberCount=${count}`, () => {
      assert.equal(
        checkAudienceNotEmpty("t", count, "npx tsx scripts/sync-apoio-especial-tag-kit.ts --push").ok,
        checkApoiadoresAudienceNotEmpty("t", count).ok,
      );
    });
  }

  for (const id of [null, 0, -1, 1.5, 42] as Array<number | null>) {
    it(`tagId=${String(id)}`, () => {
      assert.equal(
        resolveAudienceTagId("t", id, "cmd").ok,
        resolveApoiadoresTagId("t", id).ok,
      );
    });
  }
});

describe("#7659 — isSystemicKitFailure classifica só por status HTTP", () => {
  for (const status of [401, 403, 429, 500, 503]) {
    it(`${status} → sistêmica (abortar o resto do push)`, () => {
      assert.equal(isSystemicKitFailure(new KitApiError("x", status, "")), true);
    });
  }

  for (const status of [400, 404, 409, 422]) {
    it(`${status} → específica do contato (seguir pro próximo)`, () => {
      assert.equal(isSystemicKitFailure(new KitApiError("x", status, "")), false);
    });
  }

  it("erro que não é KitApiError (ex: falha de releitura) NUNCA é sistêmico", () => {
    // Casar por texto de mensagem classificaria isto errado — e uma falha de
    // verificação por releitura é semântica, específica daquele contato.
    assert.equal(isSystemicKitFailure(new Error("releitura pós-tag NÃO confere — rate limit")), false);
  });
});
