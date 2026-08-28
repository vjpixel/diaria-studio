/**
 * test/claude-config-autosync.test.ts (#6310)
 *
 * Cobre a lógica PURA de `scripts/lib/claude-config-autosync.ts` — a
 * decisão por trás do hook `SessionStart` que auto-arma o sync do repo
 * `claude-config` (`.claude/hooks/session-start-claude-config-sync.mjs`).
 *
 * Não testa `git clone`/`bootstrap.ps1`/IO real de propósito (efeito de
 * rede — ver docstring do módulo e do hook para o porquê e como isso é
 * verificado em runtime real). O que é coberto:
 *
 *   1. `resolvePlatformKind`/`bootstrapScriptName` — Windows vs
 *      Linux/macOS, incluindo plataformas desconhecidas caindo no default
 *      seguro (unix/`bootstrap.sh`).
 *   2. `shouldDebounce` — janela de debounce, timestamp ausente/corrompido.
 *   3. `decideClaudeConfigAutosyncAction` — as 4 combinações de estado
 *      (repo ausente / não armado / já armado / debounce ativo), incluindo
 *      que debounce vence sobre qualquer outro estado (1ª regra que casa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePlatformKind,
  bootstrapScriptName,
  shouldDebounce,
  decideClaudeConfigAutosyncAction,
  DEFAULT_AUTOSYNC_DEBOUNCE_MS,
} from "../scripts/lib/claude-config-autosync.ts";

describe("resolvePlatformKind", () => {
  it("reconhece win32 como windows", () => {
    assert.equal(resolvePlatformKind("win32"), "windows");
  });

  it("trata qualquer outro valor como unix (linux, darwin, desconhecido)", () => {
    assert.equal(resolvePlatformKind("linux"), "unix");
    assert.equal(resolvePlatformKind("darwin"), "unix");
    assert.equal(resolvePlatformKind("sunos"), "unix");
    assert.equal(resolvePlatformKind(""), "unix");
  });
});

describe("bootstrapScriptName", () => {
  it("windows -> bootstrap.ps1, unix -> bootstrap.sh", () => {
    assert.equal(bootstrapScriptName("windows"), "bootstrap.ps1");
    assert.equal(bootstrapScriptName("unix"), "bootstrap.sh");
  });
});

describe("shouldDebounce", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("lastRunAt null nunca debounça (1ª execução na máquina)", () => {
    assert.equal(shouldDebounce(null, now, DEFAULT_AUTOSYNC_DEBOUNCE_MS), false);
  });

  it("execução recente (dentro da janela) debounça", () => {
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    assert.equal(shouldDebounce(fiveMinAgo, now, DEFAULT_AUTOSYNC_DEBOUNCE_MS), true);
  });

  it("execução fora da janela não debounça", () => {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    assert.equal(shouldDebounce(twoHoursAgo, now, DEFAULT_AUTOSYNC_DEBOUNCE_MS), false);
  });

  it("exatamente na borda da janela não debounça (limite exclusivo)", () => {
    const exactly = new Date(now.getTime() - DEFAULT_AUTOSYNC_DEBOUNCE_MS).toISOString();
    assert.equal(shouldDebounce(exactly, now, DEFAULT_AUTOSYNC_DEBOUNCE_MS), false);
  });

  it("timestamp corrompido (não-ISO) não debounça — deixa rodar em vez de travar preso", () => {
    assert.equal(shouldDebounce("nao-e-uma-data", now, DEFAULT_AUTOSYNC_DEBOUNCE_MS), false);
  });
});

describe("decideClaudeConfigAutosyncAction", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const base = { now, debounceMs: DEFAULT_AUTOSYNC_DEBOUNCE_MS, lastRunAt: null as string | null };

  it("repo ausente -> clone-and-bootstrap, independente de isArmed", () => {
    const action = decideClaudeConfigAutosyncAction({ ...base, repoExists: false, isArmed: false });
    assert.equal(action.kind, "clone-and-bootstrap");
  });

  it("repo presente mas não armado -> bootstrap", () => {
    const action = decideClaudeConfigAutosyncAction({ ...base, repoExists: true, isArmed: false });
    assert.equal(action.kind, "bootstrap");
  });

  it("repo presente e já armado -> skip (sync-check.cjs assume)", () => {
    const action = decideClaudeConfigAutosyncAction({ ...base, repoExists: true, isArmed: true });
    assert.equal(action.kind, "skip");
    assert.equal(action.reason, "ja-armado-sync-check-cjs-assume");
  });

  it("debounce ativo vence sobre qualquer outro estado — nem repo ausente força a ação", () => {
    const recentRunAt = new Date(now.getTime() - 60 * 1000).toISOString();
    const action = decideClaudeConfigAutosyncAction({
      now,
      debounceMs: DEFAULT_AUTOSYNC_DEBOUNCE_MS,
      lastRunAt: recentRunAt,
      repoExists: false,
      isArmed: false,
    });
    assert.equal(action.kind, "skip");
    assert.equal(action.reason, "debounce-ativo");
  });

  it("nunca lança para nenhuma combinação booleana de repoExists/isArmed", () => {
    for (const repoExists of [true, false]) {
      for (const isArmed of [true, false]) {
        assert.doesNotThrow(() => decideClaudeConfigAutosyncAction({ ...base, repoExists, isArmed }));
      }
    }
  });
});
