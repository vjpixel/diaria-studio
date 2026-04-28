import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractBeehiivTrackingLinks } from "../scripts/refresh-past-editions.ts";

/**
 * Tests da extração de tracking URLs do Beehiiv (#234).
 *
 * `extractBeehiivTrackingLinks` é a peça pura — `resolveBeehiivTracking` faz
 * HEAD network request, fica fora do scope dos unit tests determinísticos
 * (smoke testado manualmente).
 */

describe("extractBeehiivTrackingLinks (#234)", () => {
  it("extrai URL de tracking diaria.beehiiv.com", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/abc123def">link</a>
      <a href="https://www.example.com/article">externa</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
    assert.ok(tracking[0].startsWith("https://diaria.beehiiv.com/c/"));
  });

  it("extrai múltiplos subdomínios beehiiv.com", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/aaa">a</a>
      <a href="https://other.beehiiv.com/c/bbb">b</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 2);
  });

  it("ignora URLs externas (não-beehiiv)", () => {
    const html = `
      <a href="https://openai.com/blog/post">openai</a>
      <a href="https://github.com/foo/bar">github</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 0);
  });

  it("dedup URLs idênticas", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/abc">1</a>
      <a href="https://diaria.beehiiv.com/c/abc">2 — mesma URL</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
  });

  it("aguenta string vazia sem crash", () => {
    assert.deepEqual(extractBeehiivTrackingLinks(""), []);
  });

  it("ignora URLs malformadas", () => {
    const html = `<a href="https://diaria.beehiiv.com/c/abc">ok</a> https://[broken not a url`;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
  });

  it("limpa pontuação ao final da URL (mesma lógica do extractLinks)", () => {
    const html = `Veja https://diaria.beehiiv.com/c/abc123, e também https://diaria.beehiiv.com/c/def456.`;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 2);
    assert.ok(tracking.every((u) => !/[.,);]+$/.test(u)));
  });
});
