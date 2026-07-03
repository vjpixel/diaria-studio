/**
 * test/clarice-sync-incremental.test.ts (#2928)
 *
 * Trava o modo incremental do clarice-sync-brevo: a URL de listing precisa
 * carregar `modifiedSince` encodado (senão a Brevo ignora e vira sync full de
 * ~44k contatos), e a derivação de MAX(brevo_modified_at) − buffer precisa
 * devolver ISO UTC correto (ou null → cai pra full).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contactsListPath,
  deriveIncrementalSince,
  anchorForIncremental,
} from "../scripts/clarice-sync-brevo.ts";

describe("contactsListPath (#2928)", () => {
  it("full (modifiedSince=null) → só limit+offset, SEM modifiedSince", () => {
    assert.equal(contactsListPath(0, null), "/contacts?limit=500&offset=0");
    assert.equal(contactsListPath(1000, null), "/contacts?limit=500&offset=1000");
    assert.doesNotMatch(contactsListPath(0, null), /modifiedSince/);
  });

  it("incremental → inclui modifiedSince ENCODADO (: vira %3A)", () => {
    const url = contactsListPath(0, "2026-06-29T13:30:00.000Z");
    assert.match(url, /&modifiedSince=2026-06-29T13%3A30%3A00\.000Z$/);
    assert.doesNotMatch(url, /modifiedSince=[^&]*:[^&]/); // nenhum ":" cru no valor
  });

  it("encoda o offset de timezone (+/-) do ISO", () => {
    const url = contactsListPath(500, "2026-06-29T10:30:00-03:00");
    assert.match(url, /offset=500&modifiedSince=2026-06-29T10%3A30%3A00-03%3A00$/);
  });
});

describe("deriveIncrementalSince (#2928)", () => {
  it("subtrai o buffer default (5min) e devolve ISO UTC", () => {
    assert.equal(
      deriveIncrementalSince("2026-06-29T13:35:00.000Z"),
      "2026-06-29T13:30:00.000Z",
    );
  });

  it("normaliza offset de timezone da entrada pra UTC", () => {
    // 10:35-03:00 = 13:35Z; −5min = 13:30Z
    assert.equal(
      deriveIncrementalSince("2026-06-29T10:35:00.000-03:00"),
      "2026-06-29T13:30:00.000Z",
    );
  });

  it("buffer custom", () => {
    assert.equal(
      deriveIncrementalSince("2026-06-29T13:35:00.000Z", 60_000),
      "2026-06-29T13:34:00.000Z",
    );
  });

  it("ausente/vazio/inválido → null (cai pra full)", () => {
    assert.equal(deriveIncrementalSince(null), null);
    assert.equal(deriveIncrementalSince(undefined), null);
    assert.equal(deriveIncrementalSince(""), null);
    assert.equal(deriveIncrementalSince("não-é-data"), null);
  });
});

describe("anchorForIncremental — âncora estável no resume (#2929 review)", () => {
  it("RESUME: reusa o cutoff do checkpoint, IGNORA o MAX que já avançou (o bug)", () => {
    // checkpoint retomando com cutoff X; o MAX do DB já andou pra Y > X (porque o
    // flush do run interrompido gravou brevo_modified_at). Deve reusar X — se
    // re-derivasse de Y, pularia os contatos pendentes em [X, Y).
    assert.equal(
      anchorForIncremental("2026-06-29T13:30:00.000Z", "2026-07-03T00:00:00.000Z"),
      "2026-06-29T13:30:00.000Z",
    );
  });

  it("run novo (sem checkpoint) → deriva de MAX − buffer", () => {
    assert.equal(
      anchorForIncremental(null, "2026-06-29T13:35:00.000Z"),
      "2026-06-29T13:30:00.000Z",
    );
    assert.equal(
      anchorForIncremental(undefined, "2026-06-29T13:35:00.000Z"),
      "2026-06-29T13:30:00.000Z",
    );
  });

  it("sem checkpoint e sem MAX → null (cai pra full)", () => {
    assert.equal(anchorForIncremental(null, null), null);
    assert.equal(anchorForIncremental(undefined, undefined), null);
  });
});
