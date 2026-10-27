/**
 * test/shorts-linkedin-timer-scope-11159.test.ts (#11159)
 *
 * `--linkedin-timer` sem `--only linkedin_profile` gravava as páginas do
 * Facebook e o Instagram no registro do timer (`06-shorts-published.linkedin-timer.json`),
 * que o 300 também escreve: com o OneDrive resolvendo "último a escrever vence",
 * as entradas `facebook:*` sumiam e o próximo `--publish` no neo republicava os
 * Reels. Também cobre o resíduo do review do #11157: o lock do upsert e a
 * reconferência do laço agora têm teste de comportamento, não só grep. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORTS_TIMER_LEDGER_DESTINATION,
  SHORTS_TIMER_LEDGER_FILE,
  linkedinTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryPath,
} from "../scripts/lib/diaria/shorts-published-store.ts";
import { acquireLock, releaseLock } from "../scripts/lib/file-lock.ts";
import type { ShortPublishedEntry, ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { LINKEDIN_TIMER_DETAIL, recheckBeforePublish } from "../scripts/publish-shorts.ts";

const AAMMDD = "261027";

const entry = (destination: string, at = "2026-10-27T11:00:00Z"): ShortPublishedEntry => ({
  destination,
  status: "published",
  id: `${destination}-id`,
  url: `https://example.test/${destination}`,
  at,
});

function withEdition(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "shorts-11159-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#11159 escopo do --linkedin-timer", () => {
  it("o cenário da issue: --linkedin-timer sem --only é recusado", () => {
    const err = linkedinTimerScopeError({ linkedinTimer: true, only: null });
    assert.ok(err);
    assert.match(err, /exige --only linkedin_profile/);
  });

  it("--only com outro destino junto do linkedin_profile é recusado", () => {
    assert.ok(linkedinTimerScopeError({ linkedinTimer: true, only: ["linkedin_profile", "facebook:diaria"] }));
    assert.ok(linkedinTimerScopeError({ linkedinTimer: true, only: ["instagram"] }));
    assert.ok(linkedinTimerScopeError({ linkedinTimer: true, only: [] }));
  });

  it("--only linkedin_profile passa (é o que o timer do 300 roda)", () => {
    assert.equal(linkedinTimerScopeError({ linkedinTimer: true, only: ["linkedin_profile"] }), null);
    assert.equal(linkedinTimerScopeError({ linkedinTimer: true, only: ["linkedin_profile", "linkedin_profile"] }), null);
  });

  it("o comando do timer continua cabendo no escopo", () => {
    const src = readFileSync(new URL("../scripts/shorts-linkedin-profile-timer.ts", import.meta.url), "utf8");
    assert.match(src, /"--only", "linkedin_profile", "--publish", "--linkedin-timer"/);
  });

  it("--mark: só linkedin_profile com --linkedin-timer", () => {
    assert.equal(linkedinTimerScopeError({ linkedinTimer: true, only: null, markDestination: "linkedin_profile" }), null);
    assert.match(linkedinTimerScopeError({ linkedinTimer: true, only: null, markDestination: "facebook_profile" })!, /só aceita linkedin_profile/);
  });

  it("--confirm-instagram nunca combina com --linkedin-timer", () => {
    assert.ok(linkedinTimerScopeError({ linkedinTimer: true, only: ["linkedin_profile"], confirmInstagram: true }));
  });

  it("sem --linkedin-timer nada muda", () => {
    assert.equal(linkedinTimerScopeError({ linkedinTimer: false, only: null }), null);
    assert.equal(linkedinTimerScopeError({ linkedinTimer: false, only: ["facebook:diaria"], markDestination: "x", confirmInstagram: true }), null);
  });

  it("o store recusa gravar outro destino no registro do timer (defesa em profundidade)", () => {
    withEdition((dir) => {
      assert.throws(() => persistShortEntry(dir, AAMMDD, "linkedin-timer", entry("facebook:diaria")), /registro do timer só aceita linkedin_profile/);
      assert.equal(existsSync(shortsRegistryPath(dir, "linkedin-timer")), false, "nada foi gravado");
      persistShortEntry(dir, AAMMDD, "linkedin-timer", entry(SHORTS_TIMER_LEDGER_DESTINATION));
      const onDisk = JSON.parse(readFileSync(join(dir, SHORTS_TIMER_LEDGER_FILE), "utf8"));
      assert.deepEqual(onDisk.entries.map((e: ShortPublishedEntry) => e.destination), ["linkedin_profile"]);
    });
  });

  it("LINKEDIN_TIMER_DETAIL e o SKILL.md mandam rodar com --only linkedin_profile", () => {
    assert.match(LINKEDIN_TIMER_DETAIL, /--only linkedin_profile --linkedin-timer/);
    const skill = readFileSync(new URL("../.claude/skills/diaria-shorts/SKILL.md", import.meta.url), "utf8");
    assert.match(skill, /--only linkedin_profile --publish --linkedin-timer/);
  });
});

describe("#11159 resíduo do #11157: lock e reconferência com teste de comportamento", () => {
  it("persistShortEntry espera o lock: com o lock tomado por outro processo, não grava", () => {
    withEdition((dir) => {
      const path = shortsRegistryPath(dir, "main");
      acquireLock(`${path}.lock`);
      try {
        assert.throws(() => persistShortEntry(dir, AAMMDD, "main", entry("instagram"), 200));
        assert.equal(existsSync(path), false, "gravou sem o lock");
      } finally {
        releaseLock(`${path}.lock`);
      }
      persistShortEntry(dir, AAMMDD, "main", entry("instagram"), 200);
      assert.equal(existsSync(path), true);
    });
  });

  it("recheckBeforePublish: destino gravado por outro processo depois da leitura vira already", () => {
    withEdition((dir) => {
      assert.equal(recheckBeforePublish(dir, AAMMDD, "linkedin_profile").kind, "proceed");
      persistShortEntry(dir, AAMMDD, "linkedin-timer", entry("linkedin_profile"));
      const r = recheckBeforePublish(dir, AAMMDD, "linkedin_profile");
      assert.equal(r.kind, "already");
      assert.equal(r.kind === "already" && r.entry.id, "linkedin_profile-id");
      assert.equal(recheckBeforePublish(dir, AAMMDD, "instagram").kind, "proceed");
    });
  });

  it("recheckBeforePublish: registro ilegível nunca vira proceed", () => {
    const boom = (): ShortsPublishedFile => {
      throw new Error("JSON inválido");
    };
    const r = recheckBeforePublish("/nao-existe", AAMMDD, "instagram", boom);
    assert.equal(r.kind, "unreadable");
    assert.match(r.kind === "unreadable" ? r.error : "", /não publica: JSON inválido/);
  });

  it("recheckBeforePublish lê do disco a cada chamada (nunca da cópia do início da rodada)", () => {
    withEdition((dir) => {
      const atStart = readShortsRegistry(dir, AAMMDD);
      assert.equal(atStart.entries.length, 0);
      persistShortEntry(dir, AAMMDD, "main", entry("facebook:diaria"));
      assert.equal(recheckBeforePublish(dir, AAMMDD, "facebook:diaria").kind, "already");
    });
  });
});
