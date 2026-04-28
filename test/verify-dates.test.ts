import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyDate, type DateVerifyResult } from "../scripts/verify-dates.ts";

/**
 * Tests pra `date_unverified` ser populado deterministicamente pelo script
 * (não pelo research-reviewer agent — ver #226).
 *
 * Não fazemos network — usamos URLs sabidamente inválidas pra forçar
 * fetch_failed e validar o caminho de erro.
 */

describe("verify-dates: date_unverified field (#226)", () => {
  it("date_unverified=true quando fetch falha (DNS inválido)", async () => {
    const result: DateVerifyResult = await verifyDate({
      url: "https://invalid-domain-pra-test-de-fetch-fail.example/post",
      date: "2026-04-25",
    });

    assert.equal(result.fetch_failed, true);
    assert.equal(result.date_unverified, true);
    assert.equal(result.verified_date, null);
    assert.equal(result.changed, false);
  });

  it("DateVerifyResult sempre inclui o campo date_unverified", async () => {
    const result = await verifyDate({
      url: "https://invalid-domain-pra-test.example/post",
      date: "2026-04-25",
    });
    // Mesmo no path de fetch_failed, o campo precisa existir e ser boolean.
    assert.equal(typeof result.date_unverified, "boolean");
  });
});
