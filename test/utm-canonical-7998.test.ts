/**
 * test/utm-canonical-7998.test.ts (#7998)
 *
 * Cobre `scripts/lib/shared/utm-canonical.ts` contra os casos reais
 * observados no store de assinantes (`data/diaria-subscribers/diaria-subscribers.db`):
 * canal canônico, `direct` literal, vazio, hostname vazado, `google.com`
 * ambíguo, e as variantes fragmentadas de um mesmo canal (linkedin,
 * instagram, clarice).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeUtmSource, summarizeUtmCanonical, type UtmSourceClass } from "../scripts/lib/shared/utm-canonical.ts";

describe("canonicalizeUtmSource — canal canônico (#7998)", () => {
  it("reconhece meta-ads", () => {
    const r = canonicalizeUtmSource("meta-ads");
    assert.equal(r.classe, "canal");
    assert.equal(r.canal, "meta-ads");
    assert.equal(r.host, null);
  });

  it("reconhece google-ads", () => {
    assert.equal(canonicalizeUtmSource("google-ads").canal, "google-ads");
  });

  it("reconhece diaria-apex", () => {
    assert.equal(canonicalizeUtmSource("diaria-apex").canal, "diaria-apex");
  });

  it("é case-insensitive e faz trim", () => {
    const r = canonicalizeUtmSource("  Meta-Ads  ");
    assert.equal(r.classe, "canal");
    assert.equal(r.canal, "meta-ads");
  });
});

describe("canonicalizeUtmSource — grupos hoje fragmentados (#7998)", () => {
  it("colapsa as 4 variantes de linkedin num único canal", () => {
    const variantes = ["linkedin", "linkedin.com", "linkedin.android", "linkedin-pessoal"];
    const canais = variantes.map((v) => canonicalizeUtmSource(v).canal);
    assert.deepEqual(new Set(canais), new Set(["linkedin"]));
    for (const v of variantes) {
      assert.equal(canonicalizeUtmSource(v).classe, "canal");
    }
  });

  it("colapsa as 3 variantes de instagram num único canal", () => {
    const variantes = ["instagram-diaria", "instagram.com", "instagram-pessoal"];
    const canais = variantes.map((v) => canonicalizeUtmSource(v).canal);
    assert.deepEqual(new Set(canais), new Set(["instagram"]));
  });

  it("colapsa as 2 variantes de clarice num único canal", () => {
    assert.equal(canonicalizeUtmSource("clarice").canal, "clarice");
    assert.equal(canonicalizeUtmSource("clarice-email").canal, "clarice");
  });
});

describe("canonicalizeUtmSource — direct literal (#7998)", () => {
  it("classifica 'direct' como direct, sem canal", () => {
    const r = canonicalizeUtmSource("direct");
    assert.equal(r.classe, "direct");
    assert.equal(r.canal, null);
  });

  it("é case-insensitive", () => {
    assert.equal(canonicalizeUtmSource("Direct").classe, "direct");
  });
});

describe("canonicalizeUtmSource — vazio (#7998)", () => {
  it("classifica null como vazio", () => {
    assert.equal(canonicalizeUtmSource(null).classe, "vazio");
  });

  it("classifica undefined como vazio", () => {
    assert.equal(canonicalizeUtmSource(undefined).classe, "vazio");
  });

  it("classifica string vazia como vazio", () => {
    assert.equal(canonicalizeUtmSource("").classe, "vazio");
  });

  it("classifica string só-espaço como vazio", () => {
    assert.equal(canonicalizeUtmSource("   ").classe, "vazio");
  });

  it("vazio nunca é confundido com direct — são classes distintas", () => {
    assert.notEqual(canonicalizeUtmSource(null).classe, canonicalizeUtmSource("direct").classe);
  });
});

describe("canonicalizeUtmSource — hostname de referrer vazado (#7998)", () => {
  it("classifica android.googlequicksearchbox como referrer", () => {
    const r = canonicalizeUtmSource("android.googlequicksearchbox");
    assert.equal(r.classe, "referrer");
    assert.equal(r.host, "android.googlequicksearchbox");
    assert.equal(r.canal, null);
  });

  it("classifica um domínio *.beehiiv.com qualquer como referrer", () => {
    const r = canonicalizeUtmSource("email.beehiiv.com");
    assert.equal(r.classe, "referrer");
    assert.equal(r.host, "email.beehiiv.com");
  });

  it("classifica www.alquimiaoperativa.news como referrer", () => {
    assert.equal(canonicalizeUtmSource("www.alquimiaoperativa.news").classe, "referrer");
  });

  it("classifica sparkloop-upscribe (sem formato de hostname) como referrer via allowlist", () => {
    const r = canonicalizeUtmSource("sparkloop-upscribe");
    assert.equal(r.classe, "referrer");
    assert.equal(r.host, "sparkloop-upscribe");
  });
});

describe("canonicalizeUtmSource — google.com ambíguo (#7998)", () => {
  it("nunca vira canal nem referrer puro — classe própria ambiguo", () => {
    const r = canonicalizeUtmSource("google.com");
    assert.equal(r.classe, "ambiguo");
    assert.equal(r.host, "google.com");
    assert.equal(r.canal, null);
  });

  it("é distinto de google-ads (canal canônico)", () => {
    assert.notEqual(canonicalizeUtmSource("google.com").classe, canonicalizeUtmSource("google-ads").classe);
  });
});

describe("canonicalizeUtmSource — desconhecido (rede de segurança, #7998)", () => {
  it("nunca lança para um valor nunca visto", () => {
    assert.doesNotThrow(() => canonicalizeUtmSource("um-valor-totalmente-novo-e-esquisito"));
  });

  it("classifica um valor sem formato de hostname e fora dos aliases como desconhecido", () => {
    const r = canonicalizeUtmSource("um-valor-totalmente-novo-e-esquisito");
    assert.equal(r.classe, "desconhecido");
    assert.equal(r.canal, null);
    assert.equal(r.host, null);
  });
});

describe("summarizeUtmCanonical (#7998)", () => {
  it("agrupa uma lista mista nos buckets corretos", () => {
    const raw = ["meta-ads", "linkedin", "linkedin.com", "direct", null, "", "google.com", "android.googlequicksearchbox", "algo-nunca-visto"];
    const buckets = summarizeUtmCanonical(raw);

    assert.equal(buckets.canal.length, 3); // meta-ads, linkedin, linkedin.com
    assert.equal(buckets.direct.length, 1);
    assert.equal(buckets.vazio.length, 2); // null e ""
    assert.equal(buckets.ambiguo.length, 1); // google.com
    assert.equal(buckets.referrer.length, 1); // android.googlequicksearchbox
    assert.equal(buckets.desconhecido.length, 1); // algo-nunca-visto
  });

  it("todas as classes de UtmSourceClass existem como chave do resultado", () => {
    const buckets = summarizeUtmCanonical([]);
    const classes: UtmSourceClass[] = ["canal", "direct", "vazio", "referrer", "ambiguo", "desconhecido"];
    for (const c of classes) {
      assert.ok(c in buckets);
      assert.deepEqual(buckets[c], []);
    }
  });
});
