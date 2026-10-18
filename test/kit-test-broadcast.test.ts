/**
 * test/kit-test-broadcast.test.ts (#10395)
 *
 * `isKitTestBroadcast()` é a fonte única de "este broadcast do Kit é test-send"
 * (caminho 5 da #10307). Cobre os três sinais (ids registrados, prefixo
 * `[teste]`, filtro só na tag de teste), os falsos positivos que ele não pode
 * ter (edição real, `[testemunho]`, filtro vazio = base inteira) e o consumidor
 * que antes não filtrava nada (`reconcile-send-audiences.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterTargetsOnlyTestTags,
  hasKitTestSubjectPrefix,
  isKitTestBroadcast,
  KIT_TEST_SUBJECT_PREFIX,
} from "../scripts/lib/shared/kit-test-broadcast.ts";
import { pickLatestRealKitBroadcast } from "../scripts/reconcile-send-audiences.ts";

describe("hasKitTestSubjectPrefix", () => {
  it("casa o prefixo do --send-test e as variantes de probe", () => {
    assert.equal(hasKitTestSubjectPrefix(`${KIT_TEST_SUBJECT_PREFIX} Manchete`), true);
    assert.equal(hasKitTestSubjectPrefix("[TESTE] Manchete"), true);
    assert.equal(hasKitTestSubjectPrefix("  [teste] Manchete"), true);
    assert.equal(hasKitTestSubjectPrefix("[teste-464] probe"), true);
  });

  it("não casa edição real, palavra parecida nem ausência", () => {
    assert.equal(hasKitTestSubjectPrefix("Manchete real"), false);
    assert.equal(hasKitTestSubjectPrefix("Manchete [teste] no meio"), false);
    assert.equal(hasKitTestSubjectPrefix("[testemunho] da semana"), false);
    assert.equal(hasKitTestSubjectPrefix(undefined), false);
    assert.equal(hasKitTestSubjectPrefix(null), false);
  });
});

describe("filterTargetsOnlyTestTags", () => {
  it("filtro escopado só à tag de teste (shape de buildTestSendFilter) → true", () => {
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42] }] }], [42]), true);
  });

  it("filtro vazio (= base inteira, #6126), outra tag, tag mista ou lixo → false", () => {
    assert.equal(filterTargetsOnlyTestTags([], [42]), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [7] }] }], [42]), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42, 7] }] }], [42]), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "segment", ids: [42] }] }], [42]), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [] }], [42]), false);
    assert.equal(filterTargetsOnlyTestTags(null, [42]), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42] }] }], []), false);
  });
});

describe("isKitTestBroadcast", () => {
  it("sinal 1: id registrado em test_broadcast_ids (mesmo com assunto sem prefixo)", () => {
    assert.equal(isKitTestBroadcast({ id: 556, subject: "Manchete" }, { testBroadcastIds: [556] }), true);
    assert.equal(isKitTestBroadcast({ id: "556", subject: "Manchete" }, { testBroadcastIds: [556] }), true);
    assert.equal(isKitTestBroadcast({ id: 555, subject: "Manchete" }, { testBroadcastIds: [556] }), false);
  });

  it("sinal 2: prefixo no subject ou no title (cache unificado usa title = subject)", () => {
    assert.equal(isKitTestBroadcast({ subject: "[teste] Manchete" }), true);
    assert.equal(isKitTestBroadcast({ title: "[teste] Manchete" }), true);
  });

  it("sinal 3: subscriber_filter só na tag de teste", () => {
    const b = { subject: "Manchete", subscriber_filter: [{ all: [{ type: "tag", ids: [42] }] }] };
    assert.equal(isKitTestBroadcast(b, { testTagIds: [42] }), true);
    assert.equal(isKitTestBroadcast(b), false, "sem o id da tag em mãos, o sinal 3 não dispara");
  });

  it("edição real (filtro vazio, assunto normal, id não registrado) nunca é teste", () => {
    assert.equal(
      isKitTestBroadcast({ id: 555, subject: "Modelos se replicam sozinhos", subscriber_filter: [] }, {
        testBroadcastIds: [556],
        testTagIds: [42],
      }),
      false,
    );
  });
});

describe("reconcile-send-audiences: pickLatestRealKitBroadcast (#10395)", () => {
  const b = (id: number, subject: string, published_at: string) => ({ id, subject, published_at, created_at: published_at });

  it("REGRESSÃO: test-send mais recente que a edição não vira a 'entrega recente' do Kit", () => {
    const real = b(1, "Manchete real", "2026-10-18T09:00:00Z");
    const teste = b(2, "[teste] Manchete real", "2026-10-18T22:00:00Z");
    assert.equal(pickLatestRealKitBroadcast([real, teste])?.id, 1);
    assert.equal(pickLatestRealKitBroadcast([teste, real])?.id, 1);
  });

  it("só testes entre os completed → null (o guard reporta measured:false, nunca mede 1)", () => {
    assert.equal(pickLatestRealKitBroadcast([b(2, "[teste] x", "2026-10-18T22:00:00Z")]), null);
  });
});
