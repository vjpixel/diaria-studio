import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  decideChannelAction,
  buildDoneChannelState,
  buildFailedChannelState,
  withChannelState,
  type ArtigoEspecialState,
} from "../scripts/lib/artigo-especial-state.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "artigo-especial-state-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("artigoEspecialStatePath (#5979)", () => {
  it("compoe o path com {ano}-{slug}", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "engenharia-de-ilusao");
    assert.ok(p.endsWith(join("artigo-especial", "2026-engenharia-de-ilusao", "published.json")));
  });
});

describe("readArtigoEspecialState (#5979)", () => {
  it("arquivo ausente -> estado vazio, sem lancar", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    const state = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(state, { ano: "2026", slug: "x", channels: {} });
  });

  it("roundtrip write/read preserva os canais", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    const state: ArtigoEspecialState = {
      ano: "2026",
      slug: "x",
      channels: { box: buildDoneChannelState("2026-08-23T10:00:00Z", null) },
    };
    writeArtigoEspecialState(p, state);
    const read = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(read, state);
  });

  it("arquivo corrompido (JSON invalido) -> estado vazio, sem lancar", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    mkdirSync(join(dataDir, "artigo-especial", "2026-x"), { recursive: true });
    writeFileSync(p, "{ nao eh json valido", "utf8");
    const state = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(state, { ano: "2026", slug: "x", channels: {} });
  });

  it("shape inesperado (channels ausente) -> estado vazio", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    mkdirSync(join(dataDir, "artigo-especial", "2026-x"), { recursive: true });
    writeFileSync(p, JSON.stringify({ ano: "2026", slug: "x" }), "utf8");
    const state = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(state, { ano: "2026", slug: "x", channels: {} });
  });

  it("status invalido de um canal eh descartado (canal some do resultado)", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    mkdirSync(join(dataDir, "artigo-especial", "2026-x"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ ano: "2026", slug: "x", channels: { box: { status: "bogus" } } }),
      "utf8",
    );
    const state = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(state.channels, {});
  });
});

describe("decideChannelAction (#5979)", () => {
  const emptyState: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };

  it("canal nunca tentado -> run", () => {
    assert.deepEqual(decideChannelAction(emptyState, "box", false), { action: "run" });
  });

  it("canal done sem force -> skip", () => {
    const state = withChannelState(emptyState, "box", buildDoneChannelState("t", "https://x"));
    const d = decideChannelAction(state, "box", false);
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.match(d.reason, /já está marcado como concluído/);
  });

  it("canal done com force -> run", () => {
    const state = withChannelState(emptyState, "box", buildDoneChannelState("t", "https://x"));
    assert.deepEqual(decideChannelAction(state, "box", true), { action: "run" });
  });

  it("canal failed -> run mesmo sem force (falha sempre retentavel)", () => {
    const state = withChannelState(emptyState, "apoiase", buildFailedChannelState("t", "DOM mudou"));
    assert.deepEqual(decideChannelAction(state, "apoiase", false), { action: "run" });
  });

  it("canais sao independentes: box done nao afeta apoiase pendente", () => {
    let state = withChannelState(emptyState, "box", buildDoneChannelState("t", null));
    assert.deepEqual(decideChannelAction(state, "apoiase", false), { action: "run" });
    state = withChannelState(state, "apoiase", buildDoneChannelState("t2", "https://apoia.se/x"));
    const d = decideChannelAction(state, "box", false);
    assert.equal(d.action, "skip");
  });
});

describe("withChannelState (#5979)", () => {
  it("nao muta o state original", () => {
    const original: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
    const updated = withChannelState(original, "linkedin_pagina", buildDoneChannelState("t", null));
    assert.deepEqual(original.channels, {});
    assert.ok(updated.channels.linkedin_pagina);
  });
});
