/**
 * test/build-origem-map.test.ts (#5235 Parte 2)
 *
 * Trava a precedência de reconstrução de origem (snapshot mais antigo com
 * origem não-promocional vence) e o invariante `original`/`recuperado`
 * mutuamente exclusivos, com fixtures sintéticas de snapshots.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMOTIONAL_UTM_SOURCES,
  isPromotionalUtmSource,
  buildOrigemMap,
  loadSnapshots,
  parseBuildOrigemMapArgs,
  DEFAULT_BACKUP_ROOT,
  DEFAULT_OUT_PATH,
  type SnapshotInput,
} from "../scripts/build-origem-map.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function rec(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "x@example.com",
    status: "active",
    created: 1700000000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isPromotionalUtmSource / PROMOTIONAL_UTM_SOURCES
// ---------------------------------------------------------------------------

describe("PROMOTIONAL_UTM_SOURCES", () => {
  it("inclui brevo-diaria (as duas vias de reativação compartilham o source)", () => {
    assert.ok(PROMOTIONAL_UTM_SOURCES.includes("brevo-diaria"));
  });

  it("isPromotionalUtmSource reconhece brevo-diaria e rejeita origens orgânicas", () => {
    assert.equal(isPromotionalUtmSource("brevo-diaria"), true);
    assert.equal(isPromotionalUtmSource("direct"), false);
    assert.equal(isPromotionalUtmSource("android.googlequicksearchbox"), false);
    assert.equal(isPromotionalUtmSource("instagram"), false);
  });
});

// ---------------------------------------------------------------------------
// buildOrigemMap — precedência e invariante original/recuperado
// ---------------------------------------------------------------------------

describe("buildOrigemMap", () => {
  it("contato nunca sobrescrito: latest não-promocional → original:true", () => {
    const snapshots: SnapshotInput[] = [
      { date: "2026-06-05", records: [rec({ email: "a@x.com", utm_source: "instagram", created: 111 })] },
      { date: "2026-08-14", records: [rec({ email: "a@x.com", utm_source: "instagram", created: 111 })] },
    ];
    const result = buildOrigemMap(snapshots);
    assert.deepEqual(result.origem["a@x.com"], {
      utm_source: "instagram",
      utm_medium: "",
      utm_campaign: "",
      referring_site: "",
      created: 111,
      snapshot_date: "2026-08-14",
      original: true,
    });
    assert.equal(result.coverage.original_count, 1);
    assert.equal(result.coverage.recovered_count, 0);
    assert.equal(result.coverage.unrecovered_count, 0);
  });

  it("contato sobrescrito: usa o snapshot MAIS ANTIGO com origem não-promocional → recuperado:true", () => {
    const snapshots: SnapshotInput[] = [
      {
        date: "2026-06-05",
        records: [
          rec({
            email: "b@x.com",
            utm_source: "android.googlequicksearchbox",
            utm_campaign: "google-ads-dez",
            created: 222,
          }),
        ],
      },
      {
        date: "2026-06-17",
        records: [
          rec({
            email: "b@x.com",
            utm_source: "android.googlequicksearchbox",
            utm_campaign: "google-ads-dez",
            created: 222,
          }),
        ],
      },
      {
        date: "2026-08-14",
        records: [rec({ email: "b@x.com", utm_source: "brevo-diaria", utm_campaign: "pending-promocao-score" })],
      },
    ];
    const result = buildOrigemMap(snapshots);
    assert.deepEqual(result.origem["b@x.com"], {
      utm_source: "android.googlequicksearchbox",
      utm_medium: "",
      utm_campaign: "google-ads-dez",
      referring_site: "",
      created: 222,
      snapshot_date: "2026-06-05", // o MAIS ANTIGO, não o 06-17
      recuperado: true,
    });
    assert.equal(result.coverage.recovered_count, 1);
    assert.equal(result.coverage.original_count, 0);
  });

  it("sem nenhuma aparição não-promocional em nenhum snapshot → sem recuperação, fora do mapa origem", () => {
    const snapshots: SnapshotInput[] = [
      { date: "2026-06-05", records: [rec({ email: "c@x.com", utm_source: "brevo-diaria" })] },
      { date: "2026-08-14", records: [rec({ email: "c@x.com", utm_source: "brevo-diaria" })] },
    ];
    const result = buildOrigemMap(snapshots);
    assert.equal(result.origem["c@x.com"], undefined);
    assert.ok(result.unrecoveredEmails.includes("c@x.com"));
    assert.equal(result.coverage.unrecovered_count, 1);
  });

  it("todo registro do mapa tem EXATAMENTE um de original/recuperado, nunca os dois nem nenhum", () => {
    const snapshots: SnapshotInput[] = [
      { date: "2026-06-05", records: [rec({ email: "orig@x.com", utm_source: "direct" })] },
      {
        date: "2026-06-05",
        records: [rec({ email: "rec@x.com", utm_source: "newsletter" })],
      },
      { date: "2026-08-14", records: [rec({ email: "rec@x.com", utm_source: "brevo-diaria" })] },
    ];
    // junta o snapshot 06-05 (2 registros de emails diferentes) numa lista só
    const merged: SnapshotInput[] = [
      {
        date: "2026-06-05",
        records: [rec({ email: "orig@x.com", utm_source: "direct" }), rec({ email: "rec@x.com", utm_source: "newsletter" })],
      },
      { date: "2026-08-14", records: [rec({ email: "orig@x.com", utm_source: "direct" }), rec({ email: "rec@x.com", utm_source: "brevo-diaria" })] },
    ];
    const result = buildOrigemMap(merged);
    for (const [email, entry] of Object.entries(result.origem)) {
      const flags = [entry.original === true, entry.recuperado === true].filter(Boolean);
      assert.equal(flags.length, 1, `${email} deveria ter exatamente 1 flag, tem ${flags.length}`);
    }
    assert.equal(result.origem["orig@x.com"].original, true);
    assert.equal(result.origem["orig@x.com"].recuperado, undefined);
    assert.equal(result.origem["rec@x.com"].recuperado, true);
    assert.equal(result.origem["rec@x.com"].original, undefined);
  });

  it("ordena snapshots por data internamente, mesmo passados fora de ordem", () => {
    const outOfOrder: SnapshotInput[] = [
      { date: "2026-08-14", records: [rec({ email: "d@x.com", utm_source: "brevo-diaria" })] },
      { date: "2026-06-05", records: [rec({ email: "d@x.com", utm_source: "facebook", created: 999 })] },
    ];
    const result = buildOrigemMap(outOfOrder);
    assert.equal(result.origem["d@x.com"].snapshot_date, "2026-06-05");
    assert.equal(result.origem["d@x.com"].utm_source, "facebook");
    assert.deepEqual(result.coverage.snapshots_used, ["2026-06-05", "2026-08-14"]);
  });

  it("snapshots vazios não quebram — coverage tudo zero", () => {
    const result = buildOrigemMap([]);
    assert.equal(result.coverage.emails_seen_total, 0);
    assert.deepEqual(result.origem, {});
    assert.deepEqual(result.unrecoveredEmails, []);
  });

  it("promotionalSources customizado sobrescreve o default sem mutar PROMOTIONAL_UTM_SOURCES", () => {
    const snapshots: SnapshotInput[] = [
      { date: "2026-06-05", records: [rec({ email: "e@x.com", utm_source: "custom-promo" })] },
    ];
    const result = buildOrigemMap(snapshots, { promotionalSources: ["custom-promo"] });
    assert.equal(result.origem["e@x.com"], undefined);
    assert.ok(result.unrecoveredEmails.includes("e@x.com"));
    assert.ok(!PROMOTIONAL_UTM_SOURCES.includes("custom-promo"));
  });
});

// ---------------------------------------------------------------------------
// loadSnapshots / parseBuildOrigemMapArgs — I/O real contra fixture em disco
// ---------------------------------------------------------------------------

describe("loadSnapshots (I/O)", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "origem-map-"));
  after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it("lê múltiplos diretórios de snapshot e ignora diretório com nome não-data", () => {
    const d1 = join(tmpRoot, "2026-06-05");
    const d2 = join(tmpRoot, "2026-08-14");
    const notASnapshot = join(tmpRoot, "scratch");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    mkdirSync(notASnapshot, { recursive: true });
    writeFileSync(join(d1, "subscribers.jsonl"), `${JSON.stringify(rec({ email: "f@x.com", utm_source: "google" }))}\n`);
    writeFileSync(
      join(d2, "subscribers.jsonl"),
      `${JSON.stringify(rec({ email: "f@x.com", utm_source: "brevo-diaria" }))}\n`,
    );
    writeFileSync(join(notASnapshot, "subscribers.jsonl"), `${JSON.stringify(rec({ email: "ghost@x.com" }))}\n`);

    const snapshots = loadSnapshots(tmpRoot);
    assert.deepEqual(
      snapshots.map((s) => s.date),
      ["2026-06-05", "2026-08-14"],
    );
    const result = buildOrigemMap(snapshots);
    assert.equal(result.origem["f@x.com"].utm_source, "google");
    assert.equal(result.origem["f@x.com"].recuperado, true);
    assert.equal(result.origem["ghost@x.com"], undefined); // dir "scratch" nunca foi lido
  });

  it("root inexistente retorna []", () => {
    assert.deepEqual(loadSnapshots(join(tmpRoot, "does-not-exist")), []);
  });
});

describe("parseBuildOrigemMapArgs", () => {
  it("defaults: root e out apontam pros caminhos padrão do repo", () => {
    const args = parseBuildOrigemMapArgs([]);
    assert.equal(args.root, DEFAULT_BACKUP_ROOT);
    assert.equal(args.out, DEFAULT_OUT_PATH);
  });

  it("aceita --root e --out customizados", () => {
    const args = parseBuildOrigemMapArgs(["--root", "/tmp/a", "--out", "/tmp/b/out.json"]);
    assert.equal(args.root, "/tmp/a");
    assert.equal(args.out, "/tmp/b/out.json");
  });
});

// ---------------------------------------------------------------------------
// Ponta a ponta leve: main() escreve o arquivo esperado
// ---------------------------------------------------------------------------

describe("main (CLI end-to-end sobre fixture local)", () => {
  it("escreve origem-original.json com coverage + mapa origem", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "origem-map-e2e-"));
    try {
      const d1 = join(tmpRoot, "2026-06-05");
      mkdirSync(d1, { recursive: true });
      writeFileSync(
        join(d1, "subscribers.jsonl"),
        `${JSON.stringify(rec({ email: "g@x.com", utm_source: "direct", created: 42 }))}\n`,
      );
      const outPath = join(tmpRoot, "out", "origem-original.json");

      const { main } = await import("../scripts/build-origem-map.ts");
      main(["--root", tmpRoot, "--out", outPath]);

      assert.ok(existsSync(outPath));
      const parsed = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(parsed.snapshots_used.length, 1);
      assert.equal(parsed.origem["g@x.com"].original, true);
      assert.equal(parsed.origem["g@x.com"].created, 42);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
