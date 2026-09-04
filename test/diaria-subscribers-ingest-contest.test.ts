/**
 * diaria-subscribers-ingest-contest.test.ts (#7209 residual — sessão develop)
 *
 * Cobre a camada de I/O do CLI de wiring que faltava: `main()` ponta-a-ponta
 * lendo `data/raffle-numbers.json` (fonte VIVA — ver docstring de
 * `contest-poll-ingest.ts`) e opcionalmente `data/contest-entries.jsonl`
 * (fonte histórica), gravando eventos `contest_reply` no store real via
 * SQLite em disco (mesmo padrão de `diaria-subscribers-ingest-kit.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { main, DEFAULT_RAFFLE_PATH, DEFAULT_LEGACY_JSONL_PATH } from "../scripts/diaria-subscribers-ingest-contest.ts";
import { openDiariaSubscribersDb, getStoreCounts, findSubscriberIdByAlias, getSubscriberTimeline } from "../scripts/lib/diaria-subscribers-db.ts";
import type { RaffleEntry } from "../scripts/lib/raffle-numbers.ts";

function makeTmpDataDir(prefix: string): { tmp: string; dbPath: string; rafflePath: string; legacyPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(resolve(tmp, "data"), { recursive: true });
  return {
    tmp,
    dbPath: resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db"),
    rafflePath: resolve(tmp, "data/raffle-numbers.json"),
    legacyPath: resolve(tmp, "data/contest-entries.jsonl"),
  };
}

const RAFFLE_FIXTURE: RaffleEntry[] = [
  { cycle: "2609", email: "leitor@example.com", nickname: "Leitor", number: 1, edition: "260901", issued_at: "2026-09-02T10:00:00Z" },
  { cycle: "2609", email: "bea@example.com", number: 2, edition: "260902", issued_at: "2026-09-03T11:00:00Z" },
];

describe("diaria-subscribers-ingest-contest main()", () => {
  it("DEFAULT_RAFFLE_PATH/DEFAULT_LEGACY_JSONL_PATH resolvem sob data/, irmãos de diaria-subscribers/", () => {
    assert.match(DEFAULT_RAFFLE_PATH, /data[\\/]raffle-numbers\.json$/);
    assert.match(DEFAULT_LEGACY_JSONL_PATH, /data[\\/]contest-entries\.jsonl$/);
  });

  it("nenhuma fonte presente: exit limpo, summary com 0 entradas, store vazio", () => {
    const { dbPath, rafflePath, legacyPath } = makeTmpDataDir("diaria-contest-ingest-empty-");
    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);
    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).events, 0);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });

  it("ingere data/raffle-numbers.json (fonte VIVA) — 1 subscriber + 1 evento contest_reply por entry", () => {
    const { dbPath, rafflePath, legacyPath } = makeTmpDataDir("diaria-contest-ingest-raffle-");
    writeFileSync(rafflePath, JSON.stringify(RAFFLE_FIXTURE, null, 2));

    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).subscribers, 2);
    assert.equal(getStoreCounts(db).events, 2);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", null, "leitor@example.com");
    assert.notEqual(subscriberId, null);
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "contest_reply");
    assert.equal(timeline[0].edicao, "260901");
    assert.equal(timeline[0].ts, "2026-09-02T10:00:00Z");
    db.close();
  });

  it("entry malformada (raffle-numbers.json corrompido à mão, sem edition) é pulada, não derruba o loop (#7419 self-review)", () => {
    const { dbPath, rafflePath, legacyPath } = makeTmpDataDir("diaria-contest-ingest-malformed-");
    const malformed = [
      { cycle: "2609", email: "quebrado@example.com", number: 1, edition: "", issued_at: "2026-09-01T10:00:00Z" },
      ...RAFFLE_FIXTURE,
    ];
    writeFileSync(rafflePath, JSON.stringify(malformed, null, 2));

    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);

    const db = openDiariaSubscribersDb(dbPath);
    // Só as 2 entries bem-formadas do fixture entram — a malformada não
    // derruba o processamento das seguintes nem vira subscriber.
    assert.equal(getStoreCounts(db).subscribers, 2);
    assert.equal(getStoreCounts(db).events, 2);
    assert.equal(findSubscriberIdByAlias(db, "beehiiv", null, "quebrado@example.com"), null);
    db.close();
  });

  it("2ª rodada é idempotente — mesma entry no raffle não duplica evento", () => {
    const { dbPath, rafflePath, legacyPath } = makeTmpDataDir("diaria-contest-ingest-idem-");
    writeFileSync(rafflePath, JSON.stringify(RAFFLE_FIXTURE, null, 2));

    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);
    const db1 = openDiariaSubscribersDb(dbPath);
    const before = getStoreCounts(db1).events;
    db1.close();

    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);
    const db2 = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db2).events, before, "raffle-numbers.json já processado — nada duplicado");
    db2.close();
  });

  it("ingere TAMBÉM data/contest-entries.jsonl (fonte histórica) quando presente, sem duplicar entre as 2 fontes", () => {
    const { dbPath, rafflePath, legacyPath } = makeTmpDataDir("diaria-contest-ingest-legacy-");
    writeFileSync(rafflePath, JSON.stringify(RAFFLE_FIXTURE, null, 2));
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ reader_email: "carlos@example.com", edition: "260828", confirmed_at: "2026-08-29T09:00:00Z" }),
        // Mesma pessoa/edição já coberta pela fonte VIVA — não deve duplicar
        // (chave natural é e-mail+edição, independente da fonte).
        JSON.stringify({ reader_email: "leitor@example.com", edition: "260901", confirmed_at: "2026-09-02T10:00:00Z" }),
      ].join("\n"),
    );

    main(["--db", dbPath, "--raffle", rafflePath, "--legacy-jsonl", legacyPath]);

    const db = openDiariaSubscribersDb(dbPath);
    // 3 pessoas distintas: leitor, bea (raffle) + carlos (legado) — o legado
    // "leitor@example.com:260901" colide com a entry do raffle, não soma.
    assert.equal(getStoreCounts(db).subscribers, 3);
    assert.equal(getStoreCounts(db).events, 3);
    db.close();
  });

  it("data/ ausente: recusa cedo, exitCode 1, nunca cria o diretório", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-contest-ingest-nodata-"));
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const originalExit = process.exitCode;
    main(["--db", dbPath]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });
});
