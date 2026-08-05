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
  applyNativeUnsubscribe,
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
    assert.equal(c.last_open_rate, null);
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

describe("applyEvaluation — thresholds (#4266, formula reescrita no #4476)", () => {
  const base: BrevoDiariaStore = {
    contacts: [
      {
        email: "a@b.com",
        beehiiv_subscription_id: "sub_1",
        status: "in_brevo",
        opens_count: 0,
        sends_count: 0,
        last_open_rate: null,
        added_at: "2026-07-01T00:00:00.000Z",
        last_evaluated_at: null,
      },
    ],
  };

  it("action=promote_to_beehiiv → status promoted_beehiiv, promoted_at setado", () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 3, sends_count: 3, open_rate: 1, action: "promote_to_beehiiv" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "promoted_beehiiv");
    assert.equal(c.promoted_at, "2026-07-31T00:00:00.000Z");
    assert.equal(c.resolution_reason, "score_threshold");
    assert.equal(c.last_open_rate, 1);
    assert.equal(c.opens_count, 3);
  });

  it("action=suppress → status suppressed, suppressed_at setado", () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 0, sends_count: 5, open_rate: 0, action: "suppress" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "suppressed");
    assert.equal(c.suppressed_at, "2026-07-31T00:00:00.000Z");
    assert.equal(c.resolution_reason, "score_threshold");
  });

  it('action="keep" (meio da faixa) → permanece in_brevo, contadores atualizados', () => {
    const out = applyEvaluation(
      base,
      "a@b.com",
      { opens_count: 1, sends_count: 2, open_rate: 0.5, action: "keep" },
      "2026-07-31T00:00:00.000Z",
    );
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "in_brevo");
    assert.equal(c.last_open_rate, 0.5);
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
      open_rate: 0,
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
      open_rate: 1,
      action: "keep",
    });
    assert.equal(out.contacts.length, 1);
    assert.equal(out.contacts[0].email, "a@b.com");
  });
});

describe("applyNativeUnsubscribe — 3ª saída terminal, distinta de suppress (#4476 item 7)", () => {
  const base: BrevoDiariaStore = {
    contacts: [
      {
        email: "a@b.com",
        beehiiv_subscription_id: "sub_1",
        status: "in_brevo",
        opens_count: 1,
        sends_count: 3,
        last_open_rate: 0.33,
        added_at: "2026-07-01T00:00:00.000Z",
        last_evaluated_at: "2026-07-20T00:00:00.000Z",
      },
    ],
  };

  it("contato in_brevo descadastrado nativamente → status unsubscribed, motivo native_unsubscribe", () => {
    const out = applyNativeUnsubscribe(base, "a@b.com", "2026-08-02T00:00:00.000Z");
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "unsubscribed");
    assert.equal(c.unsubscribed_at, "2026-08-02T00:00:00.000Z");
    assert.equal(c.resolution_reason, "native_unsubscribe");
  });

  it("reason override (#4633) — 404 permanente na propagação Beehiiv → resolution_reason native_unsubscribe_beehiiv_404", () => {
    const out = applyNativeUnsubscribe(base, "a@b.com", "2026-08-04T00:00:00.000Z", "native_unsubscribe_beehiiv_404");
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "unsubscribed");
    assert.equal(c.resolution_reason, "native_unsubscribe_beehiiv_404");
  });

  it("distinto de suppressed: mesmo evento base, resolution_reason nunca vira score_threshold", () => {
    const out = applyNativeUnsubscribe(base, "a@b.com");
    const c = findContact(out, "a@b.com")!;
    assert.notEqual(c.resolution_reason, "score_threshold");
    assert.notEqual(c.status, "suppressed");
  });

  it("contato já promovido/suprimido NUNCA regride pra unsubscribed", () => {
    const resolved: BrevoDiariaStore = {
      contacts: [{ ...base.contacts[0], status: "suppressed", suppressed_at: "2026-07-25T00:00:00.000Z", resolution_reason: "score_threshold" }],
    };
    const out = applyNativeUnsubscribe(resolved, "a@b.com");
    const c = findContact(out, "a@b.com")!;
    assert.equal(c.status, "suppressed", "não regride pra unsubscribed");
    assert.equal(c.resolution_reason, "score_threshold");
  });

  it("email não encontrado → noop", () => {
    const out = applyNativeUnsubscribe(base, "nao-existe@b.com");
    assert.equal(out.contacts.length, 1);
    assert.equal(out.contacts[0].status, "in_brevo");
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
          last_open_rate: 0.5,
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
          last_open_rate: 0,
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
