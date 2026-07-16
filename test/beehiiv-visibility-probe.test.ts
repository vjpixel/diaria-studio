/**
 * test/beehiiv-visibility-probe.test.ts (#3450)
 *
 * Regressão central: edição 260714 — dispatch automático de
 * `/diaria-5-publicacao` foi abortado (halt) por timeout de screenshot CDP
 * logo após o paste do corpo já ter sido verificado como persistido. O
 * classifier extraído aqui (`classifyVisibilityProbe`) formaliza a decisão
 * antes embutida só em prosa no playbook, e adiciona o rebaixamento
 * halt→warn_and_proceed quando o conteúdo crítico já foi verificado (#3450).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVisibilityProbe,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
} from "../scripts/lib/beehiiv-visibility-probe.ts";

describe("classifyVisibilityProbe (#3450)", () => {
  it("visibilityState visible → proceed, independente do screenshot", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "visible",
      screenshotOk: false,
      screenshotElapsedMs: null,
    });
    assert.equal(d.action, "proceed");
    assert.equal(d.reason, "visible");
  });

  it("hidden + screenshot OK dentro do timeout → proceed (stale_hidden, #2075)", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: true,
      screenshotElapsedMs: 3000,
    });
    assert.equal(d.action, "proceed");
    assert.equal(d.reason, "stale_hidden");
  });

  it("hidden + screenshot OK exatamente no limite do timeout → proceed", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: true,
      screenshotElapsedMs: DEFAULT_SCREENSHOT_TIMEOUT_MS,
    });
    assert.equal(d.action, "proceed");
  });

  it("#3450: timeout default é 20s (alargado de 10s — contexto lento)", () => {
    assert.equal(DEFAULT_SCREENSHOT_TIMEOUT_MS, 20_000);
  });

  it("hidden + screenshot falhou + SEM conteúdo já verificado → halt (frozen real)", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: false,
      screenshotElapsedMs: null,
    });
    assert.equal(d.action, "halt");
    assert.equal(d.reason, "frozen");
  });

  it("hidden + screenshot demorou além do timeout + SEM conteúdo verificado → halt", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: true, // retornou, mas tarde demais
      screenshotElapsedMs: 25_000,
    });
    assert.equal(d.action, "halt");
    assert.equal(d.reason, "frozen");
  });

  it("#3450 regressão central: hidden + screenshot falhou + conteúdo JÁ verificado → warn_and_proceed (não halt)", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: false,
      screenshotElapsedMs: null,
      contentAlreadyPasted: true,
    });
    assert.equal(d.action, "warn_and_proceed");
    assert.equal(d.reason, "frozen_but_content_verified");
    assert.match(d.message, /paste/i);
  });

  it("#3450: contentAlreadyPasted=false se comporta igual a omitido (halt preservado)", () => {
    const d1 = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: false,
      screenshotElapsedMs: null,
      contentAlreadyPasted: false,
    });
    const d2 = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: false,
      screenshotElapsedMs: null,
    });
    assert.equal(d1.action, "halt");
    assert.equal(d2.action, "halt");
  });

  it("timeout customizado via opção — respeita override", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "hidden",
      screenshotOk: true,
      screenshotElapsedMs: 12_000,
      timeoutMs: 10_000, // custom mais curto — 12s excede
    });
    assert.equal(d.action, "halt");
  });

  it("visibilityState com valor inesperado é tratado como hidden (fail-safe)", () => {
    const d = classifyVisibilityProbe({
      visibilityState: "prerender",
      screenshotOk: false,
      screenshotElapsedMs: null,
    });
    assert.equal(d.action, "halt");
  });
});
