/**
 * test/mark-artigo-especial-channel.test.ts (#5979, fleet review PR #6000
 * achado P1 — type-design-analyzer)
 *
 * Cobre `scripts/mark-artigo-especial-channel.ts`: o wrapper CLI fino que dá
 * enforcement de código ao canal `apoiase` (antes só prosa no SKILL.md).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMarkArtigoEspecialChannel } from "../scripts/mark-artigo-especial-channel.ts";
import { artigoEspecialStatePath, readArtigoEspecialState } from "../scripts/lib/artigo-especial-state.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mark-artigo-especial-channel-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runMarkArtigoEspecialChannel (#5979/#6000)", () => {
  it("status:done com --url -> grava channel done com a url, url:null se omitida", () => {
    runMarkArtigoEspecialChannel({
      ano: "2026",
      slug: "engenharia-de-ilusao",
      channel: "apoiase",
      status: "done",
      url: "https://apoia.se/diaria/posts/123",
      dataDir,
    });
    const statePath = artigoEspecialStatePath(dataDir, "2026", "engenharia-de-ilusao");
    const state = readArtigoEspecialState(statePath, "2026", "engenharia-de-ilusao");
    assert.equal(state.channels.apoiase?.status, "done");
    assert.equal(state.channels.apoiase?.url, "https://apoia.se/diaria/posts/123");
    assert.equal(state.channels.apoiase?.reason, null);
  });

  it("status:done SEM --url -> grava url:null (apoia.se pode não expor url estável)", () => {
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "done", dataDir });
    const state = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(state.channels.apoiase?.status, "done");
    assert.equal(state.channels.apoiase?.url, null);
  });

  it("status:failed exige --reason -> lança sem reason", () => {
    assert.throws(
      () => runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "failed", dataDir }),
      /exige --reason/,
    );
  });

  it("status:failed com --reason -> grava channel failed com o motivo", () => {
    runMarkArtigoEspecialChannel({
      ano: "2026",
      slug: "x",
      channel: "apoiase",
      status: "failed",
      reason: "DOM do painel mudou, seletor do composer sumiu",
      dataDir,
    });
    const state = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(state.channels.apoiase?.status, "failed");
    assert.equal(state.channels.apoiase?.reason, "DOM do painel mudou, seletor do composer sumiu");
    assert.equal(state.channels.apoiase?.url, null);
  });

  it("preserva o estado de OUTROS canais já gravados (não sobrescreve o arquivo inteiro)", () => {
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "box", status: "done", dataDir });
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "done", url: "https://apoia.se/x", dataDir });
    const state = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(state.channels.box?.status, "done");
    assert.equal(state.channels.apoiase?.status, "done");
  });

  it("2ª chamada com status diferente reescreve só o canal informado (idempotente, não acumula)", () => {
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "failed", reason: "1ª tentativa falhou", dataDir });
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "done", url: "https://apoia.se/x", dataDir });
    const state = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(state.channels.apoiase?.status, "done");
    assert.equal(state.channels.apoiase?.reason, null); // buildDoneChannelState zera reason
  });
});
