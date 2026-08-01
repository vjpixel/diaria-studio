/**
 * test/brevo-diaria-store-4266.test.ts (#4266)
 *
 * Store JSON de triagem Pending(Beehiiv)→Brevo. Cobre: ingestão idempotente
 * (dedup por email, nunca re-ingere), transição de score nos thresholds e
 * a rota alternativa de auto-confirmação (fecha o gap de duplicidade
 * registrado na própria issue).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readStore,
  writeStore,
  upsertIngested,
  applyEvaluation,
  applySelfConfirmed,
  findContact,
  normalizeEmail,
  type BrevoDiariaStore,
} from "../scripts/lib/brevo-diaria-store.ts";

describe("normalizeEmail — #4266", () => {
  it("lowercase + trim", () => {
    assert.equal(normalizeEmail("  Foo@Bar.COM  "), "foo@bar.com");
  });
});

describe("upsertIngested — dedup idempotente (#4266)", () => {
  it("adiciona contato novo com status in_brevo e contadores zerados", () => {
    const store = upsertIngested(
      { contacts: [] },
      { email: "a@b.com", beehiiv_subscription_id: "sub_1" },
      "2026-07-31T00:00:00.000Z",
    );
    assert.equal(store.contacts.length, 1);
    const c = store.contacts[0];
    assert.equal(c.email, "a@b.com");
    assert.equal(c.status, "in_brevo");
    assert.equal(c.opens_count, 0);
    assert.equal(c.sends_count, 0);
    assert.equal(c.last_score, null);
    assert.equal(c.added_at, "2026-07-31T00:00:00.000Z");
  });

  it("NUNCA re-ingere um email já presente (idempotência entre rodadas)", () => {
    const store1 = upsertIngested({ contacts: [] }, { email: "a@b.com", beehiiv_subscription_id: "sub_1" });
    const store2 = upsertIngested(store1, { email: "A@B.com", beehiiv_subscription_id: "sub_1_dup" });
    assert.equal(store2.contacts.length, 1);
    assert.equal(store2.contacts[0].beehiiv_subscription_id, "sub_1", "não sobrescreve o registro original");
  });

  it("normaliza email na ingestão (case/espaço não cria duplicata)", () => {
    const store = upsertIngested({ contacts: [] }, { email: "  Foo@Bar.com ", beehiiv_subscription_id: "s" });
    assert.equal(store.contacts[0].email, "foo@bar.com");
  });
});

describe("applyEvaluation — thresholds (#4266)", () => {
  const base: BrevoDiariaStore = {
    contacts: [
      {
        email: "a@b.com",
        beehiiv_subscription_id: "sub_1",
        status: "in_brevo",
        opens_count: 0,
        sends_count: 0,
        last_score: null,
        added_at: "2026-07-01T00:00:00.000Z",
        last_evaluated_at: null,
      },
    ],
  };

  it("score >= 60 (promote_to_beehiiv) → status promoted_beehiiv, promoted_at setado", () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 3, sends_count: 3, score: 60, action: "promote_to_beehiiv" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "promoted_beehiiv");
    assert.equal(c.promoted_at, "2026-07-31T00:00:00.000Z");
    assert.equal(c.resolution_reason, "score_threshold");
    assert.equal(c.last_score, 60);
    assert.equal(c.opens_count, 3);
  });

  it("score <= -30 (suppress) → status suppressed, suppressed_at setado", () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 0, sends_count: 3, score: -30, action: "suppress" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "suppressed");
    assert.equal(c.suppressed_at, "2026-07-31T00:00:00.000Z");
    assert.equal(c.resolution_reason, "score_threshold");
  });

  it('score no meio ("keep") → permanece in_brevo, contadores atualizados', () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 1, sends_count: 2, score: 10, action: "keep" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "in_brevo");
    assert.equal(c.last_score, 10);
    assert.equal(c.last_evaluated_at, "2026-07-31T00:00:00.000Z");
    assert.equal(c.promoted_at, undefined);
    assert.equal(c.suppressed_at, undefined);
  });

  it("contato já resolvido (promoted_beehiiv) NUNCA regride mesmo se reavaliado por engano", () => {
    const resolved: BrevoDiariaStore = {
      contacts: [{ ...base.contacts[0], status: "promoted_beehiiv", promoted_at: "2026-07-15T00:00:00.000Z" }],
    };
    const out = applyEvaluation(resolved, "a@b.com", {
      opens_count: 0,
      sends_count: 10,
      score: -100,
      action: "suppress",
    });
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "promoted_beehiiv", "não regride pra suppressed");
    assert.equal(c.promoted_at, "2026-07-15T00:00:00.000Z");
  });

  it("email não encontrado no store → noop (não lança, não cria)", () => {
    const out = applyEvaluation(base, "nao-existe@b.com", {
      opens_count: 1,
      sends_count: 1,
      score: 20,
      action: "keep",
    });
    assert.equal(out.contacts.length, 1);
    assert.equal(out.contacts[0].email, "a@b.com");
  });
});

describe("applySelfConfirmed — fecha o gap de duplicidade (#4266)", () => {
  it("contato in_brevo que confirmou opt-in na Beehiiv por conta própria → promoted_beehiiv, motivo self_confirmed_beehiiv", () => {
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "a@b.com",
          beehiiv_subscription_id: "sub_1",
          status: "in_brevo",
          opens_count: 1,
          sends_count: 2,
          last_score: 10,
          added_at: "2026-07-01T00:00:00.000Z",
          last_evaluated_at: "2026-07-20T00:00:00.000Z",
        },
      ],
    };
    const out = applySelfConfirmed(store, "a@b.com", "2026-07-31T00:00:00.000Z");
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "promoted_beehiiv");
    assert.equal(c.resolution_reason, "self_confirmed_beehiiv");
    assert.equal(c.promoted_at, "2026-07-31T00:00:00.000Z");
  });

  it("contato já suppressed não é afetado por applySelfConfirmed", () => {
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "a@b.com",
          beehiiv_subscription_id: "sub_1",
          status: "suppressed",
          opens_count: 0,
          sends_count: 4,
          last_score: -40,
          added_at: "2026-07-01T00:00:00.000Z",
          last_evaluated_at: "2026-07-20T00:00:00.000Z",
          suppressed_at: "2026-07-20T00:00:00.000Z",
          resolution_reason: "score_threshold",
        },
      ],
    };
    const out = applySelfConfirmed(store, "a@b.com");
    assert.equal(findContact(out, "a@b.com")!.status, "suppressed");
  });
});

describe("readStore/writeStore — I/O isolado por path injetável (#4266)", () => {
  it("readStore de path inexistente → store vazio (nunca erro)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-diaria-store-"));
    try {
      const store = readStore(resolve(dir, "nope.json"));
      assert.deepEqual(store, { contacts: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeStore + readStore round-trip preserva os dados", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-diaria-store-"));
    try {
      const path = resolve(dir, "contacts.json");
      const store = upsertIngested({ contacts: [] }, { email: "a@b.com", beehiiv_subscription_id: "sub_1" });
      writeStore(store, path);
      const reread = readStore(path);
      assert.equal(reread.contacts.length, 1);
      assert.equal(reread.contacts[0].email, "a@b.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
