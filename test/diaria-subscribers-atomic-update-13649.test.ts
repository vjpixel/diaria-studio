/**
 * diaria-subscribers-atomic-update-13649.test.ts (#13649)
 *
 * Regressão do aborto do bisync de `data/` por `diaria-subscribers.db`
 * ("can't copy - source file is being updated", ~07:4x UTC). A ingestão do
 * Kit (`Diaria-Kit-Roster-Ingest`, 04:25 BRT) gravava direto no `.db` por
 * ~20 min. O fix grava numa cópia de trabalho que o filtro do bisync ignora e
 * troca o store por `rename` no fim (`stageDbForAtomicUpdate` /
 * `commitStagedDbUpdate`).
 *
 * O teste que discrimina o bug é o de `main()`: no meio da ingestão (dentro de
 * `fetchAudience`) o arquivo definitivo tem que estar byte a byte igual ao de
 * antes. No código antigo ele já tinha o roster e os eventos gravados ali.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { drainPages, type BroadcastAudience, type KitEngagedPage } from "../scripts/kit-provider-split.ts";
import type { KitBroadcastStats, KitBroadcastSummary } from "../scripts/lib/kit-client.ts";
import { main, type KitIngestDeps } from "../scripts/diaria-subscribers-ingest-kit.ts";
import {
  commitStagedDbUpdate,
  discardStagedDbUpdate,
  ensureSubscriber,
  findSubscriberIdsByEmail,
  getStoreCounts,
  openDiariaSubscribersDb,
  stageDbForAtomicUpdate,
} from "../scripts/lib/diaria-subscribers-db.ts";

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tmpStore(prefix: string): { dir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = resolve(root, "data", "diaria-subscribers");
  mkdirSync(dir, { recursive: true });
  return { dir, dbPath: resolve(dir, "diaria-subscribers.db") };
}

function seedStore(dbPath: string, email: string): void {
  const db = openDiariaSubscribersDb(dbPath);
  ensureSubscriber(db, "kit", `id-${email}`, email);
  db.close();
}

function countSubscribers(dbPath: string): number {
  const db = openDiariaSubscribersDb(dbPath);
  try {
    return getStoreCounts(db).subscribers;
  } finally {
    db.close();
  }
}

/**
 * Converte um padrão de exclusão do rclone (`- ~*`, basename, sem `/`) em
 * regex. Só cobre `*`, que é o que os padrões globais usam.
 */
function excludedByGlobalFilter(name: string, filterFile: string): boolean {
  const patterns = readFileSync(filterFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !l.includes("/"))
    .map((l) => l.slice(2));
  return patterns.some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
    return re.test(name);
  });
}

describe("stageDbForAtomicUpdate / commitStagedDbUpdate (#13649)", () => {
  it("escrita na cópia de trabalho não toca o store até o commit; o commit instala", () => {
    const { dir, dbPath } = tmpStore("diaria-atomic-update-");
    seedStore(dbPath, "velho@x.com");
    const before = sha(dbPath);

    const stage = stageDbForAtomicUpdate(dbPath);
    assert.equal(dirname(stage.workPath), dir, "cópia de trabalho no mesmo diretório (rename sem EXDEV)");
    const work = openDiariaSubscribersDb(stage.workPath);
    ensureSubscriber(work, "kit", "id-novo", "novo@x.com");
    assert.equal(sha(dbPath), before, "store definitivo intacto enquanto a escrita acontece");
    work.close();
    assert.equal(sha(dbPath), before, "fechar a cópia de trabalho também não toca o store");

    commitStagedDbUpdate(stage);
    assert.equal(countSubscribers(dbPath), 2, "store tem o dado antigo (copiado) e o novo");
    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(findSubscriberIdsByEmail(db, "velho@x.com").length, 1);
    db.close();
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.startsWith("~")),
      [],
      "nenhuma sobra da cópia de trabalho depois do commit",
    );
  });

  it("a cópia de trabalho e os sidecars dela casam um exclude global do bisync de data/", () => {
    const { dbPath } = tmpStore("diaria-atomic-update-filter-");
    seedStore(dbPath, "a@x.com");
    const stage = stageDbForAtomicUpdate(dbPath);
    const filters = resolve(import.meta.dirname, "..", "scripts", "systemd", "gdrive-data-bisync-filters.txt");
    const name = basename(stage.workPath);
    for (const candidate of [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]) {
      assert.ok(excludedByGlobalFilter(candidate, filters), `${candidate} precisa ficar fora do bisync`);
    }
    // E o store definitivo continua no sync (é lido em outra máquina).
    assert.equal(excludedByGlobalFilter(basename(dbPath), filters), false);
    discardStagedDbUpdate(stage);
  });

  it("recusa o commit se outro escritor mexeu no store no meio, sem perder a escrita alheia", () => {
    const { dir, dbPath } = tmpStore("diaria-atomic-update-race-");
    seedStore(dbPath, "velho@x.com");
    const stage = stageDbForAtomicUpdate(dbPath);
    const work = openDiariaSubscribersDb(stage.workPath);
    ensureSubscriber(work, "kit", "id-meu", "meu@x.com");
    work.close();

    seedStore(dbPath, "alheio@x.com"); // outra task / o sync gravou no store

    assert.throws(() => commitStagedDbUpdate(stage), /mudou durante a atualização/);
    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(findSubscriberIdsByEmail(db, "alheio@x.com").length, 1, "escrita alheia preservada");
    assert.equal(findSubscriberIdsByEmail(db, "meu@x.com").length, 0, "cópia de trabalho não instalada");
    db.close();
    assert.equal(existsSync(stage.workPath), false, "cópia de trabalho descartada");
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("~")), []);
  });

  it("store ausente: a cópia de trabalho nasce vazia e o commit cria o store", () => {
    const { dbPath } = tmpStore("diaria-atomic-update-new-");
    const stage = stageDbForAtomicUpdate(dbPath);
    assert.equal(stage.baseline, null);
    const work = openDiariaSubscribersDb(stage.workPath);
    ensureSubscriber(work, "kit", "id-1", "um@x.com");
    work.close();
    assert.equal(existsSync(dbPath), false);
    commitStagedDbUpdate(stage);
    assert.equal(countSubscribers(dbPath), 1);
  });

  it("varre a sobra de uma atualização morta no meio", () => {
    const { dir, dbPath } = tmpStore("diaria-atomic-update-litter-");
    seedStore(dbPath, "a@x.com");
    const litter = resolve(dir, "~diaria-subscribers.db.update-tmp-999-1-abc");
    writeFileSync(litter, "lixo");
    writeFileSync(`${litter}-wal`, "lixo");
    const stage = stageDbForAtomicUpdate(dbPath);
    assert.equal(existsSync(litter), false);
    assert.equal(existsSync(`${litter}-wal`), false);
    discardStagedDbUpdate(stage);
  });
});

function filterPage(emails: string[]): KitEngagedPage {
  return {
    subscribers: emails.map((e) => ({ email_address: e })),
    pagination: { has_next_page: false, end_cursor: null },
  };
}

function makeStats(recipients: number): KitBroadcastStats {
  return {
    recipients,
    open_rate: 0,
    emails_opened: 0,
    click_rate: 0,
    unsubscribe_rate: 0,
    unsubscribes: 0,
    total_clicks: 0,
    show_total_clicks: false,
    status: "completed",
    progress: 100,
    open_tracking_disabled: false,
    click_tracking_disabled: false,
  };
}

const broadcast: KitBroadcastSummary = {
  id: 1,
  subject: "Edição A",
  send_at: null,
  status: "completed",
  public: true,
  published_at: "2026-08-27T09:00:00.000Z",
  created_at: "2026-08-27T08:00:00.000Z",
  preview_text: null,
  description: null,
  thumbnail_alt: null,
  thumbnail_url: null,
  publication_id: 1,
};

describe("main() da ingestão do Kit grava no store só no fim (#13649)", () => {
  function run(prefix: string) {
    const { dir, dbPath } = tmpStore(prefix);
    seedStore(dbPath, "velho@x.com");
    const manifestPath = resolve(dir, "kit-ingest-manifest.json");
    return { dir, dbPath, manifestPath, before: sha(dbPath) };
  }

  it("no meio da ingestão o .db definitivo e o manifest estão como antes; no fim, gravados", async () => {
    const { dbPath, manifestPath, before } = run("diaria-atomic-update-main-");
    const seen: { dbSha: string; walExists: boolean; manifestExists: boolean }[] = [];
    const audience: Record<BroadcastAudience, string[]> = {
      sent: ["a@x.com"],
      delivered: ["a@x.com"],
      opens: [],
      clicks: [],
    };
    const deps: KitIngestDeps = {
      listAllBroadcasts: async () => [broadcast],
      fetchAudience: (_id, axis) => {
        seen.push({ dbSha: sha(dbPath), walExists: existsSync(`${dbPath}-wal`), manifestExists: existsSync(manifestPath) });
        return drainPages(async () => filterPage(audience[axis]), axis);
      },
      getBroadcastStats: async () => makeStats(1),
      sleep: async () => {},
      listAllRosterSubscribers: async () => [],
      readOnboardingExclusion: () => ({ ids: new Set<string>(), source: "store", kitTransportEnabled: false, warning: null }),
    };
    await main(["--db", dbPath, "--manifest", manifestPath], deps);

    assert.ok(seen.length > 0, "fetchAudience foi chamado");
    for (const s of seen) {
      assert.equal(s.dbSha, before, "store definitivo intocado durante a ingestão (o bisync pode copiá-lo)");
      assert.equal(s.walExists, false, "nenhuma conexão aberta no store definitivo (escrita iria pro -wal dele)");
      assert.equal(s.manifestExists, false, "manifest só vai pro disco depois do commit do banco");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.entries[0].status, "ok");
    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).events, 2, "sent + delivered gravados no store depois do commit");
    assert.equal(findSubscriberIdsByEmail(db, "velho@x.com").length, 1, "dado anterior preservado");
    db.close();
  });

  it("cópia de conflito (escritor único): não grava nem a cópia de trabalho", async () => {
    const { dir, dbPath, before } = run("diaria-atomic-update-conflict-");
    const capturaDir = resolve(dir, "..", "metrics");
    mkdirSync(capturaDir, { recursive: true });
    writeFileSync(resolve(capturaDir, "captura-log-Neo.jsonl"), "");
    const originalExit = process.exitCode;
    await main(
      ["--db", dbPath, "--write", "--captura-log", resolve(capturaDir, "captura-log.jsonl")],
      {
        listAllBroadcasts: async () => [],
        fetchAudience: async () => ({ emails: [], descartadas: 0 }),
        getBroadcastStats: async () => makeStats(0),
        sleep: async () => {},
        listAllRosterSubscribers: async () => [],
      },
    );
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
    assert.equal(sha(dbPath), before, "store byte a byte igual");
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("~")), [], "cópia de trabalho descartada");
  });

  it("exceção no meio ainda commita o progresso parcial (como a escrita direta fazia)", async () => {
    const { dbPath, manifestPath } = run("diaria-atomic-update-throw-");
    await assert.rejects(
      () =>
        main(["--db", dbPath, "--manifest", manifestPath], {
          listAllBroadcasts: async () => {
            throw new Error("Kit fora do ar");
          },
          fetchAudience: async () => ({ emails: [], descartadas: 0 }),
          getBroadcastStats: async () => makeStats(0),
          sleep: async () => {},
          listAllRosterSubscribers: async () => [],
          readOnboardingExclusion: () => ({ ids: new Set<string>(), source: "store", kitTransportEnabled: false, warning: null }),
        }),
      /Kit fora do ar/,
    );
    assert.equal(countSubscribers(dbPath), 1, "store válido depois da falha");
    assert.deepEqual(readdirSync(dirname(dbPath)).filter((f) => f.startsWith("~")), []);
  });

  // #13747: o teste acima roda sem `--write` e com roster vazio, então passava
  // com o defeito. Aqui o roster grava linhas na cópia de trabalho (frames na
  // WAL, abaixo do autocheckpoint) e só então `listAllBroadcasts` lança. Com a
  // conexão ainda aberta no commit, o rename levava o `.db` sem esses frames e
  // o `rmSync` do `-wal` os apagava: o store final ficava sem o roster que o
  // `captura-log.jsonl` dizia ter gravado.
  for (const [label, failingDeps] of [
    [
      "listAllBroadcasts",
      {
        listAllBroadcasts: async () => {
          throw new Error("Kit fora do ar");
        },
      },
    ],
    [
      // `ingestOneBroadcast` é fail-soft no fetch; o throw no laço vem do
      // pacing entre broadcasts (ou de uma escrita SQLite), já com eventos do
      // 1º broadcast na WAL.
      "o laço de broadcasts (pacing)",
      {
        listAllBroadcasts: async () => [broadcast, { ...broadcast, id: 2, subject: "Edição B" }],
        sleep: async () => {
          throw new Error("Kit fora do ar");
        },
      },
    ],
  ] as const) {
    it(`--write com roster gravado e ${label} lançando: o roster chega ao store final (#13747)`, async () => {
      const { dir, dbPath, manifestPath } = run(`diaria-atomic-update-13747-${label.length}-`);
      const capturaDir = resolve(dir, "..", "metrics");
      mkdirSync(capturaDir, { recursive: true });
      const capturaLog = resolve(capturaDir, "captura-log.jsonl");
      const roster = [
        { id: 101, email_address: "r1@x.com", state: "active" as const, created_at: "2026-11-01T10:00:00Z" },
        { id: 102, email_address: "r2@x.com", state: "active" as const, created_at: "2026-11-02T10:00:00Z" },
        { id: 103, email_address: "r3@x.com", state: "cancelled" as const, created_at: "2026-11-03T10:00:00Z" },
      ];
      await assert.rejects(
        () =>
          main(
            [
              "--db",
              dbPath,
              "--manifest",
              manifestPath,
              "--write",
              "--captura-log",
              capturaLog,
              "--kit-active-history",
              resolve(capturaDir, "kit-active-history.jsonl"),
              "--snapshot-root",
              resolve(dir, "..", "snapshots-inexistentes"),
            ],
            {
              fetchAudience: async () => ({ emails: [], descartadas: 0 }),
              getBroadcastStats: async () => makeStats(0),
              sleep: async () => {},
              listAllRosterSubscribers: async () => roster,
              readOnboardingExclusion: () => ({ ids: new Set<string>(), source: "store", kitTransportEnabled: false, warning: null }),
              ...failingDeps,
            } as KitIngestDeps,
          ),
        /Kit fora do ar/,
      );
      const log = readFileSync(capturaLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(log.length, 1);
      assert.equal(log[0].exit, 0, "o log registrou o roster como gravado");
      const db = openDiariaSubscribersDb(dbPath);
      try {
        for (const s of roster) {
          assert.equal(findSubscriberIdsByEmail(db, s.email_address).length, 1, `${s.email_address} no store final`);
        }
        assert.equal(findSubscriberIdsByEmail(db, "velho@x.com").length, 1, "dado anterior preservado");
      } finally {
        db.close();
      }
      assert.deepEqual(readdirSync(dirname(dbPath)).filter((f) => f.startsWith("~")), [], "sem cópia de trabalho sobrando");
    });
  }
});
