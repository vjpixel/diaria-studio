/**
 * minor-release-blocklist-12933.test.ts (#12933)
 *
 * Regressão do caso real da edição 261113: a release `v2.1.323` do Claude Code
 * entrou em LANÇAMENTOS e foi removida à mão no gate 4. Release menor
 * (patch/pré-release) de `anthropics/claude-code` sai no dedup Pass 0; release
 * `X.Y.0`/`X.0.0`, outros repos e submissão do editor ficam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMinorRelease,
  parseReleaseTag,
  MINOR_RELEASE_BLOCKED_REPOS,
} from "../scripts/lib/minor-release-blocklist.ts";
import { dedup } from "../scripts/dedup.ts";

const REL = "https://github.com/anthropics/claude-code/releases/tag/";

describe("isMinorRelease (#12933)", () => {
  it("bloqueia o caso real da 261113 (v2.1.323) e as tags vistas nas edições 2611*", () => {
    for (const tag of ["v2.1.323", "v2.1.322", "v2.1.321", "v2.1.318", "v2.1.314"]) {
      assert.equal(isMinorRelease(REL + tag), true, tag);
    }
  });

  it("bloqueia pré-release mesmo em X.Y.0", () => {
    assert.equal(isMinorRelease(REL + "v2.2.0-beta.1"), true);
    assert.equal(isMinorRelease(REL + "v3.0.0-rc1"), true);
  });

  it("deixa passar versão maior: minor (X.Y.0) e major (X.0.0)", () => {
    assert.equal(isMinorRelease(REL + "v2.2.0"), false);
    assert.equal(isMinorRelease(REL + "v3.0.0"), false);
    assert.equal(isMinorRelease(REL + "3.0"), false);
    assert.equal(isMinorRelease(REL + "v3"), false);
  });

  it("www., maiúsculas no owner/repo, query e fragmento não escapam do bloqueio", () => {
    assert.equal(isMinorRelease("https://www.github.com/Anthropics/Claude-Code/releases/tag/v2.1.323?utm_source=x#top"), true);
  });

  it("tag percent-encoded é decodificada; `%` malformado não lança e não bloqueia", () => {
    assert.equal(isMinorRelease(REL + "v2%2E1%2E400"), true);
    assert.doesNotThrow(() => isMinorRelease(REL + "v1%2"));
    assert.equal(isMinorRelease(REL + "v1%2"), false);
  });

  it("não bloqueia outros repos, outras páginas do repo, tag não numérica nem URL inválida", () => {
    assert.equal(isMinorRelease("https://github.com/openai/codex/releases/tag/v0.9.1"), false);
    assert.equal(isMinorRelease("https://github.com/anthropics/claude-code"), false);
    assert.equal(isMinorRelease("https://github.com/anthropics/claude-code/releases"), false);
    assert.equal(isMinorRelease("https://github.com/anthropics/claude-code/issues/123"), false);
    assert.equal(isMinorRelease(REL + "nightly"), false);
    assert.equal(isMinorRelease("https://code.claude.com/docs/en/changelog"), false);
    assert.equal(isMinorRelease("not a url"), false);
    assert.equal(isMinorRelease(""), false);
  });

  it("parseReleaseTag lê major/minor/patch/sufixo", () => {
    assert.deepEqual(parseReleaseTag("v2.1.323"), { major: 2, minor: 1, patch: 323, suffix: "" });
    assert.deepEqual(parseReleaseTag("3.0"), { major: 3, minor: 0, patch: 0, suffix: "" });
    assert.deepEqual(parseReleaseTag("v2.2.0-beta.1"), { major: 2, minor: 2, patch: 0, suffix: "-beta.1" });
    assert.equal(parseReleaseTag("nightly"), null);
  });

  it("lista curada contém o repo do Claude Code (forma owner/repo minúscula)", () => {
    assert.ok(MINOR_RELEASE_BLOCKED_REPOS.has("anthropics/claude-code"));
    for (const repo of MINOR_RELEASE_BLOCKED_REPOS) {
      assert.equal(repo, repo.toLowerCase());
      assert.match(repo, /^[^/]+\/[^/]+$/);
    }
  });
});

describe("dedup Pass 0 aplica a blacklist de release menor (#12933)", () => {
  it("remove v2.1.323, mantém v2.2.0 e outros itens", () => {
    const { kept, removed } = dedup(
      [
        { url: REL + "v2.1.323", title: "v2.1.323" },
        { url: REL + "v2.2.0", title: "v2.2.0" },
        { url: "https://www.anthropic.com/news/claude-opus-6", title: "Introducing Claude Opus 6" },
      ],
      new Set(),
      0.85,
    );
    const keptUrls = kept.map((a) => a.url);
    assert.ok(!keptUrls.includes(REL + "v2.1.323"));
    assert.ok(keptUrls.includes(REL + "v2.2.0"));
    assert.ok(keptUrls.includes("https://www.anthropic.com/news/claude-opus-6"));
    const entry = removed.find((r) => r.url === REL + "v2.1.323");
    assert.ok(entry, "release menor precisa aparecer em removed");
    assert.match(JSON.stringify(entry), /#12933/);
  });

  it("submissão do editor de release menor fica no pool", () => {
    const { kept } = dedup(
      [{ url: REL + "v2.1.323", title: "v2.1.323", flag: "editor_submitted" }],
      new Set(),
      0.85,
    );
    assert.deepEqual(kept.map((a) => a.url), [REL + "v2.1.323"]);
  });
});
