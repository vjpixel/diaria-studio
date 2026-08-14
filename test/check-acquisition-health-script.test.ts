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

  it("--dry-run sobre semana JÁ processada: reavalia e mostra os achados de novo, em vez de curto-circuitar (#5279 finding 2)", async () => {
    const root = join(tmpRoot, "root-dryrun-reinspect");
    const statePath = join(tmpRoot, "state-dryrun-reinspect.json");
    const date = "2026-08-09";

    // Canal com sobrevivência abaixo do piso (30% default) — sinal que NÃO
    // depende de knownChannels/streak, então continua presente em toda
    // reavaliação do mesmo snapshot (ao contrário de canal_desconhecido, que
    // "some" do 2º run em diante porque o canal passa a ser conhecido).
    // cadastros=25 (>= cohortMinSize=20, então não é amostraNova), 5 ativos
    // = sobrevivência 20% < piso 30%.
    mkdirSync(join(root, date), { recursive: true });
    const subs: BeehiivBackupSubscriber[] = [];
    for (let i = 0; i < 25; i++) {
      subs.push(sub({ email: `u${i}@x.com`, utm_source: "canal-doente", status: i < 5 ? "active" : "inactive" }));
    }
    writeFileSync(join(root, date, "subscribers.jsonl"), subs.map((s) => JSON.stringify(s)).join("\n") + "\n");

    // Seed do state simulando que a rodada REAL já processou esse mesmo
    // snapshot (idempotência por data já travada pra `date`) — sem passar
    // por main() sem --dry-run, que enviaria e-mail de verdade se achasse algo.
    saveState({ ...emptyAcquisitionHealthState(), lastCheckedSnapshotDate: date }, statePath);
    const seeded = loadState(statePath);

    const runDryRunAndCollectLogs = async () => {
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
      return logs;
    };

    const firstDryRun = await runDryRunAndCollectLogs();
    const secondDryRun = await runDryRunAndCollectLogs();

    for (const logs of [firstDryRun, secondDryRun]) {
      assert.ok(
        !logs.some((l) => l.includes("idempotência por data")),
        "dry-run não deveria curto-circuitar no guard de idempotência",
      );
      assert.ok(
        logs.some((l) => l.includes("sobrevivencia_baixa") && l.includes("canal-doente")),
        "dry-run deveria mostrar os achados mesmo com a semana já processada",
      );
    }

    // --dry-run nunca avança o state, nas duas rodadas.
    const afterDryRuns = loadState(statePath);
    assert.deepEqual(afterDryRuns, seeded);
  });

  it("snapshot mais recente sem subscribers.jsonl: NÃO avança o state, warning explícito (#5281)", async () => {
    const root = join(tmpRoot, "root-missing-subs");
    const statePath = join(tmpRoot, "state-missing-subs.json");
    // Diretório do snapshot existe (backup rodou), mas subscribers.jsonl
    // nunca foi escrito — simula falha real do endpoint (.partial preservado,
    // nunca renomeado) sem sequer um manifest.json pra diagnosticar.
    mkdirSync(join(root, "2026-08-16"), { recursive: true });

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await main(["--root", root, "--state", statePath]); // sem --dry-run
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warns.some((w) => w.includes("2026-08-16") && w.includes("não pôde rodar") && w.includes("não marcado como avaliado")),
      "deveria emitir warning explícito sobre snapshot inutilizável",
    );
    // Nenhum state jamais foi persistido — o cursor de idempotência não avançou.
    assert.ok(!existsSync(statePath));
  });

  it("snapshot mais recente com subscribers.jsonl VAZIO: NÃO avança o state, warning explícito (#5281)", async () => {
    const root = join(tmpRoot, "root-empty-subs");
    const statePath = join(tmpRoot, "state-empty-subs.json");
    mkdirSync(join(root, "2026-08-16"), { recursive: true });
    writeFileSync(join(root, "2026-08-16", "subscribers.jsonl"), "");

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await main(["--root", root, "--state", statePath]);
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warns.some((w) => w.includes("2026-08-16")));
    assert.ok(!existsSync(statePath));
  });

  it("snapshot mais recente com manifest.json reportando erro no endpoint subscribers: NÃO avança um state já existente (#5281)", async () => {
    const root = join(tmpRoot, "root-manifest-error");
    const statePath = join(tmpRoot, "state-manifest-error.json");

    // Semana 1: boa, já processada e persistida — baseline pra provar que a
    // semana 2 (quebrada) não sobrescreve esse cursor.
    mkdirSync(join(root, "2026-08-09"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-09", "subscribers.jsonl"),
      `${JSON.stringify(sub({ email: "a@x.com", utm_source: "google-ads" }))}\n`,
    );
    await main(["--root", root, "--state", statePath]);
    const afterFirstWeek = loadState(statePath);
    assert.equal(afterFirstWeek.lastCheckedSnapshotDate, "2026-08-09");

    // Semana 2: manifest existe mas reporta erro no endpoint subscribers —
    // arquivo pode até ter algum conteúdo residual de uma escrita parcial,
    // mas o manifest é a fonte de verdade de que o endpoint falhou.
    mkdirSync(join(root, "2026-08-16"), { recursive: true });
    writeFileSync(
      join(root, "2026-08-16", "manifest.json"),
      JSON.stringify({
        endpoints: [{ key: "subscribers", file: "subscribers.jsonl", status: "error", error: "ETIMEDOUT" }],
      }),
    );

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await main(["--root", root, "--state", statePath]);
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warns.some((w) => w.includes("2026-08-16") && w.includes("ETIMEDOUT")));
    // O cursor continua na última semana BOA — nunca avançou pra semana quebrada.
    const afterBrokenWeek = loadState(statePath);
    assert.equal(afterBrokenWeek.lastCheckedSnapshotDate, "2026-08-09");
  });

  it("manifest.json existe mas SEM campo `endpoints` — nunca lança, cai pro conteúdo de fato (contrato fail-soft)", async () => {
    const root = join(tmpRoot, "root-manifest-no-endpoints");
    const statePath = join(tmpRoot, "state-manifest-no-endpoints.json");

    mkdirSync(join(root, "2026-08-16"), { recursive: true });
    // manifest.json parseável mas sem `endpoints` — formato inesperado, não
    // "manifest ausente" (readBackupManifest só retorna null pra JSON
    // ausente/corrompido). isSubscribersSnapshotUsable não pode lançar aqui.
    writeFileSync(join(root, "2026-08-16", "manifest.json"), JSON.stringify({}));
    writeFileSync(
      join(root, "2026-08-16", "subscribers.jsonl"),
      `${JSON.stringify(sub({ email: "a@x.com", utm_source: "google-ads" }))}\n`,
    );

    // Não deve lançar — deve cair pro conteúdo de fato de subscribers.jsonl
    // (que aqui é usável) e avançar o cursor normalmente.
    await assert.doesNotReject(() => main(["--root", root, "--state", statePath]));
    const state = loadState(statePath);
    assert.equal(state.lastCheckedSnapshotDate, "2026-08-16");
  });
});
