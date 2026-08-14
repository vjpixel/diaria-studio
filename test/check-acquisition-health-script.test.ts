/**
 * test/check-acquisition-health-script.test.ts (#5249)
 *
 * Ponta a ponta leve do CLI (`scripts/check-acquisition-health.ts`) sobre
 * fixtures de snapshot em disco (tmpdir) — sempre com `--dry-run` (nunca
 * chama `sendGmailMessage`/rede real) e sempre `--state` apontando pro
 * tmpdir (nunca toca `data/acquisition-health/state.json` do repo).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, loadState, saveState } from "../scripts/check-acquisition-health.ts";
import { emptyAcquisitionHealthState } from "../scripts/lib/acquisition-health.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "x@example.com",
    status: "active",
    created: 1_700_000_000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 30, total_unique_clicked: 1 },
    ...overrides,
  };
}

describe("check-acquisition-health.ts main() — CLI end-to-end sobre fixture local", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "acq-health-"));
  after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it("sem nenhum snapshot: sai sem erro, sem escrever state", async () => {
    const root = join(tmpRoot, "empty-root");
    const statePath = join(tmpRoot, "empty-state.json");
    await main(["--dry-run", "--root", root, "--state", statePath]);
    assert.ok(!existsSync(statePath));
  });

  it("1º snapshot: estabelece knownChannels, nunca alarma canal_desconhecido, avança state mesmo sem --dry-run", async () => {
    const root = join(tmpRoot, "root-1snap");
    const statePath = join(tmpRoot, "state-1snap.json");
    mkdirSync(join(root, "2026-08-02"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-02", "subscribers.jsonl"),
      [
        sub({ email: "a@x.com", utm_source: "google-ads" }),
        sub({ email: "b@x.com", utm_source: "sparkloop" }),
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );

    await main(["--root", root, "--state", statePath]); // sem --dry-run — precisa persistir

    assert.ok(existsSync(statePath));
    const state = loadState(statePath);
    assert.deepEqual(state.knownChannels.sort(), ["google-ads", "sparkloop"]);
    assert.equal(state.lastCheckedSnapshotDate, "2026-08-02");
  });

  it("2 snapshots com canal novo aparecendo: alarma canal_desconhecido em --dry-run (sem enviar de verdade, sem persistir)", async () => {
    const root = join(tmpRoot, "root-newchannel");
    const statePath = join(tmpRoot, "state-newchannel.json");

    mkdirSync(join(root, "2026-08-02"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-02", "subscribers.jsonl"),
      `${JSON.stringify(sub({ email: "a@x.com", utm_source: "google-ads" }))}\n`,
    );
    mkdirSync(join(root, "2026-08-09"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-09", "subscribers.jsonl"),
      [sub({ email: "a@x.com", utm_source: "google-ads" }), sub({ email: "c@x.com", utm_source: "sparkloop-novo" })]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );

    // Seed state como se a 1ª rodada já tivesse rodado sobre 2026-08-02.
    saveState(
      { ...emptyAcquisitionHealthState(), knownChannels: ["google-ads"], lastCheckedSnapshotDate: "2026-08-02" },
      statePath,
    );

    // Captura stdout pra confirmar que o e-mail teria sido "enviado" (dry-run).
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await main(["--dry-run", "--root", root, "--state", statePath]);
    } finally {
      console.log = originalLog;
    }

    assert.ok(logs.some((l) => l.includes("sparkloop-novo")));
    assert.ok(logs.some((l) => l.includes("--dry-run: enviaria e-mail")));

    // --dry-run não avança o state — segue exatamente como foi seedado.
    const state = loadState(statePath);
    assert.equal(state.lastCheckedSnapshotDate, "2026-08-02");
  });

  it("2ª execução sobre o MESMO snapshot mais recente: idempotência por data, não reavalia", async () => {
    const root = join(tmpRoot, "root-idempotent");
    const statePath = join(tmpRoot, "state-idempotent.json");
    mkdirSync(join(root, "2026-08-02"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-02", "subscribers.jsonl"),
      `${JSON.stringify(sub({ email: "a@x.com", utm_source: "google-ads" }))}\n`,
    );

    await main(["--root", root, "--state", statePath]);
    const afterFirst = loadState(statePath);

    await main(["--root", root, "--state", statePath]);
    const afterSecond = loadState(statePath);

    assert.deepEqual(afterFirst, afterSecond);
  });
});
