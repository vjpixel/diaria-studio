/**
 * #11105 — recuperação de `send_unknown` (#11076) no publish-threads.
 *
 * 1. A instrução dizia "rodar com --no-skip-existing", que é GLOBAL: com só o
 *    d2 ambíguo, d1/d3/um (já `published`) saíam de novo. Agora `--retry d2`
 *    re-tenta só o post pedido e recusa o que já saiu.
 * 2. `send_unknown` sumia do resumo (`published: 0, failed: 0`) e dos
 *    invariantes do Stage 5 (consent-binding acusava "dispatch parcial", outro
 *    problema; social-published-no-failed só olhava `failed`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideThreadsDispatch,
  parseRetryIds,
  sendUnknownRecoveryHint,
  summarizeThreadsResults,
} from "../scripts/publish-threads.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";
import { checkConsentBinding, checkSocialPublishedComplete } from "../scripts/lib/invariant-checks/stage-5.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const entry = (destaque: string, status: PostEntry["status"]): PostEntry => ({
  platform: "threads",
  destaque,
  url: null,
  status,
  scheduled_at: null,
});

describe("parseRetryIds (#11105)", () => {
  it("ausente = null (comportamento de sempre)", () => {
    assert.deepEqual(parseRetryIds(undefined, false), { ok: true, ids: null });
  });
  it("lista válida, case-insensitive", () => {
    const r = parseRetryIds("D2, um", false);
    assert.ok(r.ok);
    assert.deepEqual([...(r.ok ? r.ids! : [])].sort(), ["d2", "um"]);
  });
  it("flag sem valor é erro (não vira 'retry de tudo')", () => {
    assert.equal(parseRetryIds(undefined, true).ok, false);
    assert.equal(parseRetryIds("", false).ok, false);
  });
  it("id fora de d1/d2/d3/um é erro", () => {
    const r = parseRetryIds("d4", false);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /d4/);
  });
});

describe("decideThreadsDispatch (#11105)", () => {
  const retryD2 = { skipExisting: true, retryIds: new Set(["d2"]) };

  it("cenário da issue: só d2 send_unknown → --retry d2 refaz d2 e não toca d1/d3/um publicados", () => {
    const posts: Record<string, PostEntry> = {
      d1: entry("d1", "published"),
      d2: entry("d2", "send_unknown"),
      d3: entry("d3", "published"),
      um: entry("um", "published"),
    };
    const actions = Object.fromEntries(
      Object.entries(posts).map(([d, e]) => [d, decideThreadsDispatch(d, e, retryD2).action]),
    );
    assert.deepEqual(actions, { d1: "not-selected", d2: "dispatch", d3: "not-selected", um: "not-selected" });
  });

  it("--retry recusa post já published/scheduled/draft (refazer duplicaria)", () => {
    for (const status of ["published", "scheduled", "draft"] as const) {
      assert.equal(decideThreadsDispatch("d2", entry("d2", status), retryD2).action, "retry-refused", status);
    }
  });

  it("--retry refaz failed e post sem entrada", () => {
    assert.equal(decideThreadsDispatch("d2", entry("d2", "failed"), retryD2).action, "dispatch");
    assert.equal(decideThreadsDispatch("d2", undefined, retryD2).action, "dispatch");
  });

  it("sem --retry: resume de sempre (send_unknown segue pulado, #11076)", () => {
    const opts = { skipExisting: true, retryIds: null };
    assert.equal(decideThreadsDispatch("d2", entry("d2", "send_unknown"), opts).action, "skip-existing");
    assert.equal(decideThreadsDispatch("d2", entry("d2", "published"), opts).action, "skip-existing");
    assert.equal(decideThreadsDispatch("d2", entry("d2", "failed"), opts).action, "dispatch");
  });

  it("--no-skip-existing continua global (sem --retry)", () => {
    assert.equal(decideThreadsDispatch("d1", entry("d1", "published"), { skipExisting: false, retryIds: null }).action, "dispatch");
  });
});

describe("resumo e mensagem (#11105)", () => {
  it("summary conta send_unknown", () => {
    const s = summarizeThreadsResults([entry("d1", "published"), entry("d2", "send_unknown"), entry("d3", "failed")], 0);
    assert.deepEqual(s, { total: 3, published: 1, failed: 1, send_unknown: 1, skipped: 0 });
  });
  it("a instrução de recuperação aponta pro --retry do post, não pro --no-skip-existing global", () => {
    const hint = sendUnknownRecoveryHint("d2");
    assert.match(hint, /--retry d2/);
    assert.doesNotMatch(hint, /--no-skip-existing/);
  });
  it("publish-threads.ts usa a instrução nova e não cita mais --no-skip-existing como recuperação", () => {
    const src = readFileSync(resolve(ROOT, "scripts/publish-threads.ts"), "utf8");
    assert.match(src, /sendUnknownRecoveryHint\(d\)/);
    assert.doesNotMatch(src, /se o post não saiu, rodar com --no-skip-existing/);
    assert.match(src, /decideThreadsDispatch\(d, existingPost, \{ skipExisting, retryIds \}\)/);
  });
});

describe("invariantes do Stage 5 com send_unknown (#11105)", () => {
  function mkDir(posts: unknown[], consent?: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "send-unknown-11105-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "06-social-published.json"), JSON.stringify({ posts }));
    if (consent) writeFileSync(join(dir, "_internal", "05-publish-consent.json"), JSON.stringify(consent));
    return dir;
  }

  it("social-published-send-unknown avisa, com o post e a instrução de conferir o perfil", () => {
    const dir = mkDir([
      { platform: "threads", destaque: "d1", status: "published" },
      { platform: "threads", destaque: "d2", status: "send_unknown" },
    ]);
    try {
      const v = checkSocialPublishedComplete(dir);
      const su = v.find((x) => x.rule === "social-published-send-unknown");
      assert.ok(su, JSON.stringify(v));
      assert.equal(su!.severity, "warning");
      assert.match(su!.message, /threads\/d2/);
      assert.match(su!.message, /conferir o perfil/);
      assert.equal(v.some((x) => x.rule === "social-published-no-failed"), false, "não é failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consent-binding aceita send_unknown como status de dispatch (não é 'dispatch parcial')", () => {
    const dir = mkDir(
      [
        { platform: "linkedin", destaque: "d1", status: "scheduled" },
        { platform: "linkedin", destaque: "d2", status: "send_unknown" },
      ],
      { newsletter: "manual", linkedin: "auto" },
    );
    try {
      const v = checkConsentBinding(dir, "beehiiv");
      assert.equal(v.some((x) => x.rule === "consent-binding-linkedin"), false, JSON.stringify(v));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
