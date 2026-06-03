/**
 * beehiiv-real-click.test.ts (#1764, #1705)
 *
 * Cobre os helpers puros de clique real: conversão de coords viewport→screenshot
 * (gotcha #1764) e o builder de locate-JS (localiza, não clica).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  screenshotScaleFactor,
  resolveClickPoint,
  buildLocateRectJs,
  type LocateRect,
} from "../scripts/lib/beehiiv-real-click.ts";

describe("screenshotScaleFactor (#1764)", () => {
  it("factor = screenshotWidth / viewportWidth (gotcha ~0.82)", () => {
    assert.ok(Math.abs(screenshotScaleFactor(1568, 1910) - 0.8209) < 0.001);
    assert.equal(screenshotScaleFactor(1568, 1568), 1);
  });
  it("viewport inválido → 1 (sem escala)", () => {
    assert.equal(screenshotScaleFactor(1568, 0), 1);
    assert.equal(screenshotScaleFactor(1568, -10), 1);
  });
});

describe("resolveClickPoint (#1764)", () => {
  const locate: LocateRect = {
    found: true,
    label: "x",
    rect: { left: 1800, top: 100, width: 40, height: 40, centerX: 1820, centerY: 120 },
    innerWidth: 1910,
  };

  it("converte o centro do rect pro espaço do screenshot", () => {
    const p = resolveClickPoint(locate, 1568);
    // 1820 * (1568/1910) ≈ 1494 ; 120 * 0.8209 ≈ 98.5 → 99
    assert.equal(p.x, 1494);
    assert.equal(p.y, 99);
    assert.ok(Math.abs(p.factor - 0.8209) < 0.001);
  });

  it("sem escala quando screenshotWidth == innerWidth", () => {
    const p = resolveClickPoint(locate, 1910);
    assert.equal(p.x, 1820);
    assert.equal(p.y, 120);
    assert.equal(p.factor, 1);
  });

  it("lança quando o locate não achou o elemento", () => {
    assert.throws(() => resolveClickPoint({ found: false, label: "y", error: "não achou" }, 1568), /sem rect/);
  });
});

describe("buildLocateRectJs (#1764)", () => {
  const js = buildLocateRectJs("alvo", "return document.querySelector('h3');");

  it("é JS que NÃO clica (localiza só) e devolve rect + innerWidth", () => {
    assert.match(js, /getBoundingClientRect/);
    assert.match(js, /window\.innerWidth/);
    assert.doesNotMatch(js, /\.click\(\)/);
  });
  it("embute o label e o corpo do finder", () => {
    assert.match(js, /"alvo"/);
    assert.match(js, /querySelector\('h3'\)/);
  });
  it("trata finder que retorna null (found:false)", () => {
    assert.match(js, /found: false/);
    assert.match(js, /found: true/);
  });
});
