/**
 * test/observe-channel-keys.test.ts (#5493)
 *
 * `scripts/observe-channel-keys.ts` — instrumento de OBSERVAÇÃO das chaves
 * de grupo (`utm_source`/`referring_site`) num snapshot local, dentro de uma
 * janela de datas. Núcleo puro (`observeChannelKeys`) + camada CLI
 * (parsing/exit-codes) + end-to-end com fixtures em tmpdir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeChannelKeys,
  parseObserveChannelKeysArgs,
  main,
  DEFAULT_BACKUP_ROOT,
} from "../scripts/observe-channel-keys.ts";
import { parseSinceToEpochSeconds, parseUntilToEpochSecondsExclusive, type EngagementSubscriber } from "../scripts/cohort-engagement.ts";

function sub(overrides: Partial<EngagementSubscriber> = {}): EngagementSubscriber {
  return {
    status: "active",
    created: parseSinceToEpochSeconds("2026-08-10"),
    utm_source: "direct",
    referring_site: "",
    ...overrides,
  };
}

describe("observeChannelKeys (núcleo puro)", () => {
  it("agrupa por resolveGroupKey e ordena por volume descendente", () => {
    const subs = [
      sub({ utm_source: "facebook.com" }),
      sub({ utm_source: "facebook.com" }),
      sub({ utm_source: "google.com" }),
    ];
    const result = observeChannelKeys(subs, { since: null, untilExclusive: null });
    assert.deepEqual(result.observations, [
      { key: "facebook.com", count: 2 },
      { key: "google.com", count: 1 },
    ]);
    assert.equal(result.totalConsidered, 3);
  });

  it("empate de volume desempata por ordem alfabética da chave", () => {
    const subs = [sub({ utm_source: "b.com" }), sub({ utm_source: "a.com" })];
    const result = observeChannelKeys(subs, { since: null, untilExclusive: null });
    assert.deepEqual(
      result.observations.map((o) => o.key),
      ["a.com", "b.com"],
    );
  });

  it("respeita janela — cadastro fora não entra na contagem", () => {
    const window = { since: parseSinceToEpochSeconds("2026-08-01"), untilExclusive: parseUntilToEpochSecondsExclusive("2026-08-16") };
    const subs = [
      sub({ utm_source: "facebook.com", created: parseSinceToEpochSeconds("2026-08-10") }),
      sub({ utm_source: "facebook.com", created: parseSinceToEpochSeconds("2026-01-01") }),
    ];
    const result = observeChannelKeys(subs, window);
    assert.equal(result.observations[0].count, 1);
  });

  it("assinante sem created é descartado e contado em excludedMissingCreated quando janela ativa", () => {
    const window = { since: parseSinceToEpochSeconds("2026-08-01"), untilExclusive: null };
    const subs = [sub({ created: undefined as unknown as number })];
    const result = observeChannelKeys(subs, window);
    assert.equal(result.excludedMissingCreated, 1);
    assert.equal(result.totalConsidered, 0);
  });

  it("--filter (regex) restringe as chaves observadas", () => {
    const subs = [sub({ utm_source: "facebook.com" }), sub({ utm_source: "google.com" })];
    const result = observeChannelKeys(subs, { since: null, untilExclusive: null }, /facebook/i);
    assert.deepEqual(
      result.observations.map((o) => o.key),
      ["facebook.com"],
    );
  });

  it("fallback pra referring_site quando utm_source ausente (mesma resolução de resolveGroupKey)", () => {
    const subs = [sub({ utm_source: "", referring_site: "l.facebook.com" })];
    const result = observeChannelKeys(subs, { since: null, untilExclusive: null });
    assert.deepEqual(result.observations, [{ key: "l.facebook.com", count: 1 }]);
  });
});

describe("parseObserveChannelKeysArgs", () => {
  it("defaults", () => {
    const args = parseObserveChannelKeysArgs([]);
    assert.equal(args.backupRoot, DEFAULT_BACKUP_ROOT);
    assert.equal(args.snapshotDate, null);
    assert.equal(args.since, null);
    assert.equal(args.until, null);
    assert.equal(args.filter, null);
    assert.equal(args.json, false);
  });

  it("--since/--until/--filter/--snapshot/--root/--json", () => {
    const args = parseObserveChannelKeysArgs([
      "--since",
      "2026-08-17",
      "--until",
      "2026-08-20",
      "--filter",
      "facebook",
      "--snapshot",
      "2026-08-14",
      "--root",
      "/x",
      "--json",
    ]);
    assert.equal(args.since, "2026-08-17");
    assert.equal(args.until, "2026-08-20");
    assert.equal(args.filter, "facebook");
    assert.equal(args.snapshotDate, "2026-08-14");
    assert.equal(args.backupRoot, "/x");
    assert.equal(args.json, true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end com tmpdir
// ---------------------------------------------------------------------------

function subscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: parseSinceToEpochSeconds("2026-08-17"),
    utm_source: "facebook.com",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  });
}

describe("main — end-to-end com fixtures em tmpdir", () => {
  it("--since ausente -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "observe-keys-nosince-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      mkdirSync(join(backupRoot, "2026-08-17"), { recursive: true });
      writeFileSync(join(backupRoot, "2026-08-17", "subscribers.jsonl"), subscriberLine() + "\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhum snapshot encontrado -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "observe-keys-nosnap-"));
    try {
      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", join(root, "vazio"), "--since", "2026-08-17"], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caminho feliz: agrupa chaves do snapshot, filtra internos/teste, exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "observe-keys-happy-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      const snapshotDir = join(backupRoot, "2026-08-17");
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(
        join(snapshotDir, "subscribers.jsonl"),
        [
          subscriberLine({ email: "a@example.com", utm_source: "facebook.com" }),
          subscriberLine({ email: "b@example.com", utm_source: "facebook.com" }),
          subscriberLine({ email: "vjpixel@gmail.com", utm_source: "facebook.com" }), // interno — excluído
        ].join("\n") + "\n",
        "utf8",
      );

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot, "--since", "2026-08-01"], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.notEqual(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--since formato inválido -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "observe-keys-badsince-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      mkdirSync(join(backupRoot, "2026-08-17"), { recursive: true });
      writeFileSync(join(backupRoot, "2026-08-17", "subscribers.jsonl"), subscriberLine() + "\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot, "--since", "not-a-date"], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
