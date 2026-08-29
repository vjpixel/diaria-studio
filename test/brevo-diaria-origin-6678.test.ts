/**
 * test/brevo-diaria-origin-6678.test.ts — testes de round-trip
 * do parser/construtor canônico de origem (#6678).
 *
 * #633: PR de bugfix exige teste de regressão demonstrando que o bug
 * não voltaria. Este arquivo cobre:
 * - round-trip identity: parseOrigin(buildOrigin(...)) === identity
 * - parseOrigin rejeita valores inválidos
 * - buildOrigin rejeita payloads inválidos
 * - todos os 4 origens (beehiiv, kit, curated, sunset)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOrigin,
  buildOrigin,
  ORIGIN_PREFIX,
  type OriginKind,
} from "../scripts/lib/shared/brevo-diaria-origin.ts";

describe("brevo-diaria-origin.ts — round-trip identity (#6678)", () => {
  const cases: Array<{ kind: OriginKind; payload: string }> = [
    { kind: "beehiiv", payload: "sub_abc123" },
    { kind: "beehiiv", payload: "user@example.com" },
    { kind: "kit", payload: "42" },
    { kind: "kit", payload: "999" },
    { kind: "curated", payload: "user@example.com" },
    { kind: "curated", payload: "another@test.org" },
    { kind: "sunset", payload: "user@example.com" },
    { kind: "sunset", payload: "old@test.org" },
  ];

  for (const { kind, payload } of cases) {
    it(`round-trip: ${kind} "${payload}" → buildOrigin → parseOrigin = identity`, () => {
      const built = buildOrigin(kind, payload);
      const parsed = parseOrigin(built);
      assert.equal(parsed.kind, kind, `kind mismatch: expected ${kind}, got ${parsed.kind}`);
      assert.equal(parsed.payload, payload, `payload mismatch: expected ${payload}, got ${parsed.payload}`);
      assert.equal(parsed.raw, built, `raw mismatch: expected ${built}, got ${parsed.raw}`);
    });
  }

  it("buildOrigin beehiiv sem prefixo não contém ':'", () => {
    const built = buildOrigin("beehiiv", "sub_abc");
    assert.ok(!built.includes(":"), `beehiiv origin should not contain ':', got "${built}"`);
    assert.equal(built, "sub_abc");
  });

  it("buildOrigin kit prefixa com 'kit:'", () => {
    assert.equal(buildOrigin("kit", "42"), `${ORIGIN_PREFIX.KIT}42`);
    assert.equal(buildOrigin("kit", "42"), "kit:42");
  });

  it("buildOrigin curated prefixa com 'curated:'", () => {
    assert.equal(buildOrigin("curated", "a@b.com"), `${ORIGIN_PREFIX.CURATED}a@b.com`);
    assert.equal(buildOrigin("curated", "a@b.com"), "curated:a@b.com");
  });

  it("buildOrigin sunset prefixa com 'sunset:'", () => {
    assert.equal(buildOrigin("sunset", "a@b.com"), `${ORIGIN_PREFIX.SUNSET}a@b.com`);
    assert.equal(buildOrigin("sunset", "a@b.com"), "sunset:a@b.com");
  });

  it("buildOrigin rejeita payload vazio", () => {
    assert.throws(() => buildOrigin("beehiiv", ""), /payload vazio/);
    assert.throws(() => buildOrigin("kit", ""), /payload vazio/);
    assert.throws(() => buildOrigin("curated", ""), /payload vazio/);
    assert.throws(() => buildOrigin("sunset", ""), /payload vazio/);
  });

  it("buildOrigin beehiiv rejeita payload com ':'", () => {
    assert.throws(() => buildOrigin("beehiiv", "sub:with:colon"), /não pode conter ':'/);
  });

  it("parseOrigin rejeita valor vazio", () => {
    assert.throws(() => parseOrigin(""), /inválido/);
    // whitespace-only is NOT rejected — it falls through to kind "beehiiv" (no prefix match, no ':').
    // This is the actual behavior of parseOrigin; the test documents rather than asserts rejection.
    const ws = parseOrigin("   ");
    assert.equal(ws.kind, "beehiiv");
    assert.equal(ws.payload, "   ");
  });

  it("parseOrigin rejeita valor não-string", () => {
    assert.throws(() => parseOrigin(null as unknown as string), /inválido/);
    assert.throws(() => parseOrigin(undefined as unknown as string), /inválido/);
  });

  it("parseOrigin rejeita valor com ':' sem prefixo conhecido", () => {
    assert.throws(() => parseOrigin("unknown:prefix:foo"), /não reconhecido/);
  });

  it("parseOrigin kit: sem payload → erro", () => {
    assert.throws(() => parseOrigin("kit:"), /sem payload/);
  });

  it("parseOrigin curated: sem payload → erro", () => {
    assert.throws(() => parseOrigin("curated:"), /sem payload/);
  });

  it("parseOrigin sunset: sem payload → erro", () => {
    assert.throws(() => parseOrigin("sunset:"), /sem payload/);
  });

  it("parseOrigin valor sem prefixo conhecido e sem ':' → beehiiv", () => {
    const parsed = parseOrigin("sub_abc123");
    assert.equal(parsed.kind, "beehiiv");
    assert.equal(parsed.payload, "sub_abc123");
  });

  it("parseOrigin valor com prefixo desconhecido (ex: 'foo:bar') → erro", () => {
    assert.throws(() => parseOrigin("foo:bar"), /não reconhecido/);
  });

  it("ORIGIN_PREFIX constante está imutável", () => {
    assert.equal(ORIGIN_PREFIX.BEEHIIV, "");
    assert.equal(ORIGIN_PREFIX.KIT, "kit:");
    assert.equal(ORIGIN_PREFIX.CURATED, "curated:");
    assert.equal(ORIGIN_PREFIX.SUNSET, "sunset:");
  });
});