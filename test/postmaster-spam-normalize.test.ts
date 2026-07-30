/**
 * test/postmaster-spam-normalize.test.ts (#4154, achado do self-review do #4342)
 *
 * `normalizePostmasterSpamEntry` (workers/brevo-dashboard/src/brevo-api.ts) é o
 * ÚNICO choke point de leitura do KV `postmaster:spam` — usado tanto pelo
 * render do dashboard quanto por `GET /api/postmaster-spam`. Reconstruía o
 * objeto campo a campo e NUNCA copiava `producedBy`: todo entry gravado pelos
 * dois produtores (postmaster-spam-sync.ts="auto", postmaster-spam-entry.ts=
 * "manual") saía normalizado com `producedBy: undefined`, então o rótulo
 * dinâmico da aba Rampa nunca refletia a origem real da leitura em produção —
 * só nos testes que constroem o objeto direto, sem passar por este boundary.
 * Este arquivo trava a regressão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePostmasterSpamEntry } from "../workers/brevo-dashboard/src/index.ts";

describe("normalizePostmasterSpamEntry — producedBy passa pelo boundary do KV (#4154, #4342)", () => {
  it("producedBy 'auto' é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "auto",
    });
    assert.equal(entry?.producedBy, "auto");
  });

  it("producedBy 'manual' é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "manual",
    });
    assert.equal(entry?.producedBy, "manual");
  });

  it("producedBy ausente (entry pré-#4154) vira undefined, nunca inferido", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    assert.equal(entry?.producedBy, undefined);
  });

  it("valor de producedBy fora do enum não é confiado cegamente", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "algo-invalido",
    });
    assert.equal(entry?.producedBy, undefined);
  });

  it("spamRatePct/recordedAt continuam obrigatórios (regra pré-existente intacta)", () => {
    assert.equal(normalizePostmasterSpamEntry(null), null);
    assert.equal(normalizePostmasterSpamEntry({ producedBy: "auto" }), null);
    assert.equal(
      normalizePostmasterSpamEntry({ spamRatePct: NaN, recordedAt: "2026-07-30T09:00:00.000Z", producedBy: "auto" }),
      null,
    );
  });
});
