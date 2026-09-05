/**
 * beehiiv-engagement-read.test.ts (#7460, residual do #7181/#7172)
 *
 * Cobre o leitor canônico do backup de engagement — as 5 classes de
 * contaminação medidas pelo #7181 (auditoria por assinatura de chaves),
 * fixtures tiradas do padrão real observado no acervo (`data/beehiiv-backup/
 * subscriber-engagement/`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEngagementRecord,
  classifyEngagementRecords,
  readCanonicalEngagementRecords,
  nonCanonicalFraction,
} from "../scripts/lib/beehiiv-engagement-read.ts";

const CANONICAL = {
  subscriber_id: "7bfa5666-27a9-4b14-8d1d-2a461af241b6",
  email: "pedro_avelaneda@hotmail.com",
  status: "opened",
  timestamp: "2025-09-09T12:00:33Z",
  total_clicked: 0,
  total_opened: 1,
  acquisition_channel: "website",
  acquisition_source: "website: linkedin.com / referral",
};

describe("classifyEngagementRecord — classe canônica", () => {
  it("registro canônico completo → class canonical, record preservado", () => {
    const r = classifyEngagementRecord(CANONICAL);
    assert.equal(r.class, "canonical");
    assert.deepEqual(r.record, CANONICAL);
  });

  it("variante sem acquisition_channel/acquisition_source (schema real observado, post_077f565f) → ainda canonical, não é fora-do-canônico", () => {
    const { acquisition_channel, acquisition_source, ...reduced } = CANONICAL;
    const r = classifyEngagementRecord(reduced);
    assert.equal(r.class, "canonical", "campos de acquisition são opcionais, não obrigatórios pro núcleo mínimo");
  });
});

describe("classifyEngagementRecord — classe A (stub sintético, #7181)", () => {
  it("{ subscriber_id: 's1' } → class stub, descartado (record: null)", () => {
    const r = classifyEngagementRecord({ subscriber_id: "s1" });
    assert.equal(r.class, "stub");
    assert.equal(r.record, null);
  });

  it("{ subscriber_id: 'sub1', subscription_id: 'sub1' } (2 chaves, ambas de identidade) também é stub", () => {
    const r = classifyEngagementRecord({ subscriber_id: "sub1", subscription_id: "sub1" });
    assert.equal(r.class, "stub");
  });
});

describe("classifyEngagementRecord — classe B (schema list_post_click_subscribers, #7206)", () => {
  it("shape FLAT (url/url_hash/clicked_at no nível do registro) → class click-identity, roteado (record: null)", () => {
    const clickRecord = {
      subscription_id: "sub_d0620b3e-f02d-40eb-8825-68626d9981a8",
      email: "eduacquarone@gmail.com",
      url: "https://eia.diar.ia.br/vote?choice=B",
      url_hash: "7989819519831038341",
      clicked_at: "2026-08-29T15:01:40Z",
      acquisition_channel: "import",
      acquisition_source: "import: direct / (none)",
    };
    const r = classifyEngagementRecord(clickRecord);
    assert.equal(r.class, "click-identity");
    assert.equal(r.record, null);
  });

  it("registro com clicks[] aninhado e SEM status → também click-identity (não confundir com classe E, que TEM status)", () => {
    const r = classifyEngagementRecord({
      subscriber_id: "sub1",
      clicks: [{ subscription_id: "sub_x", url_hash: "1", clicked_at: "2026-01-01T00:00:00Z" }],
    });
    assert.equal(r.class, "click-identity");
  });
});

describe("classifyEngagementRecord — classe C (e-mail em subscriber_id, #7181)", () => {
  it("sem chave email, subscriber_id contém '@' → class email-remapped, email preenchido, email_recuperado: true", () => {
    const r = classifyEngagementRecord({
      subscriber_id: "robertachavesnegociosonline@gmail.com",
      status: "opened",
      timestamp: "2026-02-18T13:03:01Z",
      total_clicked: 0,
      total_opened: 1,
      acquisition_channel: "website",
      acquisition_source: "website: android.googlequicksearchbox / referral",
    });
    assert.equal(r.class, "email-remapped");
    assert.equal(r.email_recuperado, true);
    assert.equal(r.record?.email, "robertachavesnegociosonline@gmail.com");
    assert.equal(r.record?.subscriber_id, "robertachavesnegociosonline@gmail.com", "subscriber_id original preservado");
  });

  it("e-mail é normalizado pra lowercase no remap (mesma convenção de extractBeehiivIdentity)", () => {
    const r = classifyEngagementRecord({ subscriber_id: "Maiuscula@Example.COM", status: "delivered" });
    assert.equal(r.record?.email, "maiuscula@example.com");
  });
});

describe("classifyEngagementRecord — classe D (email: null, #7181)", () => {
  it("email ausente/null, subscriber_id não é e-mail → class no-email, has_email: false, record preservado", () => {
    const r = classifyEngagementRecord({
      subscriber_id: "7bfa5666-27a9-4b14-8d1d-2a461af241b6",
      email: null,
      status: "delivered",
      timestamp: "2026-01-01T00:00:00Z",
    });
    assert.equal(r.class, "no-email");
    assert.equal(r.has_email, false);
    assert.equal(r.record?.subscriber_id, "7bfa5666-27a9-4b14-8d1d-2a461af241b6");
  });
});

describe("classifyEngagementRecord — classe E (canônica + clicks[] aninhado, #7181)", () => {
  it("registro canônico COM status e clicks[] → class canonical, clicks_preserved traz o array verbatim", () => {
    const clicks = [{ subscription_id: "sub_51dba302", url_hash: "1746414200", clicked_at: "2026-04-13T03:13:38Z" }];
    const r = classifyEngagementRecord({ ...CANONICAL, status: "clicked", clicks });
    assert.equal(r.class, "canonical", "clicks[] a MAIS não deve descartar a linha — validador é superconjunto, não igualdade");
    assert.deepEqual(r.clicks_preserved, clicks);
    assert.deepEqual((r.record as any).clicks, clicks, "o array também continua no record cru");
  });
});

describe("classifyEngagementRecord — malformado", () => {
  it("não é objeto → class malformed", () => {
    assert.equal(classifyEngagementRecord("not an object").class, "malformed");
    assert.equal(classifyEngagementRecord(null).class, "malformed");
    assert.equal(classifyEngagementRecord([1, 2, 3]).class, "malformed");
  });

  it("objeto sem NENHUMA identidade (nem subscriber_id/subscription_id, nem email) → malformed", () => {
    const r = classifyEngagementRecord({ status: "delivered", timestamp: "2026-01-01T00:00:00Z" });
    assert.equal(r.class, "malformed");
  });
});

describe("readCanonicalEngagementRecords — separa usable de click-identity, conta cada classe", () => {
  it("mistura das 5 classes + malformado → summary bate, usable nunca inclui stub/click-identity/malformed", () => {
    const clickRecord = { subscription_id: "sub_x", url: "https://x", url_hash: "1", clicked_at: "2026-01-01T00:00:00Z" };
    const stub = { subscriber_id: "s1" };
    const classC = { subscriber_id: "recuperavel@example.com", status: "opened" };
    const classD = { subscriber_id: "7bfa5666", email: null, status: "delivered" };
    const malformed = { status: "delivered" };
    const result = readCanonicalEngagementRecords([CANONICAL, clickRecord, stub, classC, classD, malformed]);

    assert.equal(result.summary.total, 6);
    assert.equal(result.summary.canonical, 1);
    assert.equal(result.summary.click_identity, 1);
    assert.equal(result.summary.stub, 1);
    assert.equal(result.summary.email_remapped, 1);
    assert.equal(result.summary.no_email, 1);
    assert.equal(result.summary.malformed, 1);

    assert.equal(result.usable.length, 3, "canonical + email-remapped + no-email");
    assert.equal(result.clickIdentity.length, 1);
    assert.deepEqual(result.clickIdentity[0], clickRecord, "roteado verbatim, sem reshape");
  });

  it("array vazio → summary zerado, usable/clickIdentity vazios", () => {
    const result = readCanonicalEngagementRecords([]);
    assert.equal(result.summary.total, 0);
    assert.deepEqual(result.usable, []);
    assert.deepEqual(result.clickIdentity, []);
  });
});

describe("nonCanonicalFraction — métrica do guard schema-fora-do-canonico", () => {
  it("array vazio → 0", () => {
    assert.equal(nonCanonicalFraction([]), 0);
  });

  it("100% stub → 1", () => {
    const stubs = Array.from({ length: 5 }, (_, i) => ({ subscriber_id: `s${i}` }));
    assert.equal(nonCanonicalFraction(stubs), 1);
  });

  it("click-identity NÃO conta como não-canônico pra esta métrica (payload legítimo de outro endpoint)", () => {
    const clicks = Array.from({ length: 5 }, (_, i) => ({
      subscription_id: `sub_${i}`,
      url: "https://x",
      url_hash: "1",
      clicked_at: "2026-01-01T00:00:00Z",
    }));
    assert.equal(nonCanonicalFraction(clicks), 0, "100% click-identity não deveria disparar o guard de schema");
  });

  it("classes C/D (recuperáveis) também não contam como não-canônico", () => {
    const records = [
      { subscriber_id: "a@b.com", status: "opened" }, // C
      { subscriber_id: "x", email: null, status: "delivered" }, // D
    ];
    assert.equal(nonCanonicalFraction(records), 0);
  });

  it("mistura 1 stub em 4 registros bons → 0.25", () => {
    const records = [
      { ...CANONICAL },
      { ...CANONICAL, subscriber_id: "b" + CANONICAL.subscriber_id },
      { ...CANONICAL, subscriber_id: "c" + CANONICAL.subscriber_id },
      { subscriber_id: "s1" },
    ];
    assert.equal(nonCanonicalFraction(records), 0.25);
  });
});

describe("classifyEngagementRecords — array completo", () => {
  it("mapeia cada elemento independentemente, preservando a ordem", () => {
    const results = classifyEngagementRecords([{ subscriber_id: "s1" }, CANONICAL]);
    assert.equal(results.length, 2);
    assert.equal(results[0].class, "stub");
    assert.equal(results[1].class, "canonical");
  });
});
