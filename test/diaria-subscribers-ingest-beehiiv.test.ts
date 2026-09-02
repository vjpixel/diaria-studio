/**
 * diaria-subscribers-ingest-beehiiv.test.ts (#6464 fatia 3b — #7104)
 *
 * Cobre a camada de I/O do builder Beehiiv: leitura do manifest da fatia 1
 * (`beehiiv-engagement-manifest.ts`) + `.jsonl` locais, `ingestOnePost`
 * (guard + escrita, fail-soft), e `main()` ponta-a-ponta contra um tmpdir —
 * sem rede, sem MCP.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  main,
  ingestOnePost,
  loadSourceEngagementManifest,
  readPostRecords,
} from "../scripts/diaria-subscribers-ingest-beehiiv.ts";
import { openDiariaSubscribersDb, getStoreCounts } from "../scripts/lib/diaria-subscribers-db.ts";
import type { EngagementManifest } from "../scripts/lib/beehiiv-engagement-manifest.ts";

/** Monta um diretório de backup fixture: manifest.json + N .jsonl. */
function makeSourceDir(
  tmp: string,
  manifest: EngagementManifest,
  posts: Record<string, unknown[]>,
): string {
  const dir = resolve(tmp, "subscriber-engagement");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [postId, records] of Object.entries(posts)) {
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
    writeFileSync(resolve(dir, `${postId}.jsonl`), body);
  }
  return dir;
}

describe("loadSourceEngagementManifest", () => {
  it("null quando o manifest não existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    assert.equal(loadSourceEngagementManifest(tmp), null);
  });

  it("null quando o manifest está corrompido (JSON inválido)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    writeFileSync(resolve(tmp, "manifest.json"), "{not json");
    assert.equal(loadSourceEngagementManifest(tmp), null);
  });

  it("lê o manifest válido", () => {
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    const manifest: EngagementManifest = { generated_at: "2026-01-01T00:00:00Z", posts: [{ post_id: "post_1", status: "ok", count: 2 }] };
    writeFileSync(resolve(tmp, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(loadSourceEngagementManifest(tmp), manifest);
  });
});

describe("readPostRecords", () => {
  it("[] quando o .jsonl não existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    assert.deepEqual(readPostRecords(tmp, "post_missing"), []);
  });

  it("ignora linha corrompida sem lançar", () => {
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    writeFileSync(resolve(tmp, "post_x.jsonl"), '{"subscriber_id":"a"}\nNOT JSON\n{"subscriber_id":"b"}\n');
    const records = readPostRecords(tmp, "post_x");
    assert.equal(records.length, 2);
  });
});

describe("ingestOnePost", () => {
  it("guard ok: processados bate com manifest.count → status ok", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    writeFileSync(
      resolve(tmp, "post_1.jsonl"),
      [
        JSON.stringify({ subscriber_id: "s1", email: "a@x.com", status: "delivered", timestamp: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ subscriber_id: "s2", email: "b@x.com", status: "opened", timestamp: "2026-01-01T00:00:00Z" }),
      ].join("\n") + "\n",
    );
    const outcome = ingestOnePost(db, tmp, { post_id: "post_1", title: "Edição X", status: "ok", count: 2 });
    assert.equal(outcome.entry.status, "ok");
    assert.equal(outcome.entry.counts?.records_processados, 2);
    assert.equal(outcome.eventsNew, 3); // delivered(s1) + delivered(s2) + open(s2)
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });

  it("guard falha: JSONL truncado (menos registros que manifest.count) → status partial, eventos gravados mesmo assim", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    writeFileSync(
      resolve(tmp, "post_2.jsonl"),
      JSON.stringify({ subscriber_id: "s1", email: "a@x.com", status: "delivered" }) + "\n",
    );
    const outcome = ingestOnePost(db, tmp, { post_id: "post_2", status: "ok", count: 5 });
    assert.equal(outcome.entry.status, "partial");
    assert.match(outcome.entry.error!, /5/);
    assert.equal(outcome.eventsNew, 1, "o que foi lido é gravado mesmo sob guard falho");
    db.close();
  });

  it("manifest da fatia 1 SEM count → status error explícito, nunca 'ok' por fallback pra records.length (#7135 finding 1)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    // 2 registros no JSONL, count AUSENTE no manifest da fatia 1 — antes do
    // fix, `sourceEntry.count ?? records.length` comparava 2 contra 2 e
    // passava trivialmente mesmo que o JSONL estivesse truncado.
    writeFileSync(
      resolve(tmp, "post_3.jsonl"),
      [
        JSON.stringify({ subscriber_id: "s1", email: "a@x.com", status: "delivered" }),
        JSON.stringify({ subscriber_id: "s2", email: "b@x.com", status: "delivered" }),
      ].join("\n") + "\n",
    );
    const outcome = ingestOnePost(db, tmp, { post_id: "post_3", status: "ok", count: undefined });
    assert.equal(outcome.entry.status, "error");
    assert.match(outcome.entry.error!, /count/i);
    // Os eventos já lidos são gravados mesmo assim — não descarta trabalho.
    assert.equal(outcome.eventsNew, 2);
    assert.equal(getStoreCounts(db).events, 2);
    db.close();
  });

  it("post not_applicable (nunca enviado) vira ok com 0 registros, sem tentar ler jsonl", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const tmp = mkdtempSync(join(tmpdir(), "beehiiv-ingest-src-"));
    const outcome = ingestOnePost(db, tmp, { post_id: "post_never_sent", status: "not_applicable" });
    assert.equal(outcome.entry.status, "ok");
    assert.equal(outcome.entry.counts?.records, 0);
    assert.equal(outcome.eventsNew, 0);
    db.close();
  });
});

describe("main() — ponta a ponta com fixture de disco (sem MCP)", () => {
  it("ingere só posts ok/not_applicable da fatia 1, grava eventos, persiste manifest próprio", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    const sourceManifest: EngagementManifest = {
      generated_at: "2026-01-01T00:00:00Z",
      posts: [
        { post_id: "post_1", title: "Edição A", status: "ok", count: 2 },
        { post_id: "post_2", title: "Edição B (ainda em drenagem)", status: "partial", count: 3 },
        { post_id: "post_3", title: "Rascunho nunca enviado", status: "not_applicable" },
      ],
    };
    const sourceDir = makeSourceDir(tmp, sourceManifest, {
      post_1: [
        { subscriber_id: "s1", email: "a@x.com", status: "delivered", timestamp: "2026-01-01T00:00:00Z" },
        { subscriber_id: "s2", email: "b@x.com", status: "clicked", timestamp: "2026-01-01T00:00:00Z" },
      ],
      post_2: [{ subscriber_id: "s3", email: "c@x.com", status: "delivered" }], // não deve ser lido (source ainda partial)
    });

    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // post_2 nunca entra no manifest desta ingestão — a fatia 1 ainda não confirmou.
    assert.deepEqual(
      manifest.entries.map((e: { id: string }) => e.id).sort(),
      ["post_1", "post_3"],
    );
    assert.ok(manifest.entries.every((e: { status: string }) => e.status === "ok"));

    const db = openDiariaSubscribersDb(dbPath);
    // post_1: delivered(s1) + delivered(s2) + open(s2) + click(s2) = 4; post_3: 0
    assert.equal(getStoreCounts(db).events, 4);
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });

  it("2ª rodada é idempotente — nada pendente, nenhum evento novo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");
    const sourceManifest: EngagementManifest = {
      generated_at: "2026-01-01T00:00:00Z",
      posts: [{ post_id: "post_1", status: "ok", count: 1 }],
    };
    const sourceDir = makeSourceDir(tmp, sourceManifest, {
      post_1: [{ subscriber_id: "s1", email: "a@x.com", status: "delivered" }],
    });

    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);
    const db1 = openDiariaSubscribersDb(dbPath);
    const before = getStoreCounts(db1).events;
    db1.close();

    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);
    const db2 = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db2).events, before, "manifest já ok — nada re-processado, nada duplicado");
    db2.close();
  });

  it("post que passa de partial pra ok na fatia 1 entre rodadas é pego na 2ª rodada", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    const sourceDir = resolve(tmp, "subscriber-engagement");
    mkdirSync(sourceDir, { recursive: true });
    const writeSourceManifest = (m: EngagementManifest) =>
      writeFileSync(resolve(sourceDir, "manifest.json"), JSON.stringify(m));
    writeFileSync(
      resolve(sourceDir, "post_1.jsonl"),
      JSON.stringify({ subscriber_id: "s1", email: "a@x.com", status: "delivered" }) + "\n",
    );

    writeSourceManifest({ generated_at: "t1", posts: [{ post_id: "post_1", status: "partial", count: 5 }] });
    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).entries.length, 0, "post partial na fatia 1 não entra ainda");

    writeSourceManifest({ generated_at: "t2", posts: [{ post_id: "post_1", status: "ok", count: 1 }] });
    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].status, "ok");
  });

  it("--post filtra pra 1 post específico com 2+ pendentes (#7135 finding 2 — trava a regressão do getArg vs getStringArg)", async () => {
    // Bug original: `getArg(argv, "post")` devolve `""` (não `undefined`)
    // quando a flag está ausente — `pending.filter((e) => e.id === "")`
    // sempre falha, então NENHUM post nunca era filtrado (o filtro virava
    // no-op silencioso). Pior: com a flag PASSADA, `getArg` também não
    // distinguia "valor não fornecido" de string vazia do mesmo jeito que
    // `getStringArg` — este teste exercita o caminho `--post post_1` de
    // ponta a ponta e falha se `getStringArg` for trocado de volta por
    // `getArg` (`postFilter` viraria sempre `""`, o filtro pra `e.id === ""`
    // nunca casaria, e os 2 posts seriam processados em vez de só 1).
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-postfilter-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    const sourceManifest: EngagementManifest = {
      generated_at: "2026-01-01T00:00:00Z",
      posts: [
        { post_id: "post_1", title: "Edição A", status: "ok", count: 1 },
        { post_id: "post_2", title: "Edição B", status: "ok", count: 1 },
      ],
    };
    const sourceDir = makeSourceDir(tmp, sourceManifest, {
      post_1: [{ subscriber_id: "s1", email: "a@x.com", status: "delivered" }],
      post_2: [{ subscriber_id: "s2", email: "b@x.com", status: "delivered" }],
    });

    const result: { processed_this_run: number } = await new Promise((resolvePromise) => {
      const originalLog = console.log;
      console.log = (msg: string) => {
        console.log = originalLog;
        resolvePromise(JSON.parse(msg));
      };
      void main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir, "--post", "post_1"]);
    });

    assert.equal(result.processed_this_run, 1, "só post_1 foi processado, não os 2 pendentes");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const post1Entry = manifest.entries.find((e: { id: string }) => e.id === "post_1");
    const post2Entry = manifest.entries.find((e: { id: string }) => e.id === "post_2");
    assert.equal(post1Entry.status, "ok", "post_1 (filtrado) foi de fato processado");
    assert.equal(post2Entry.status, "pending", "post_2 (fora do filtro) permanece pending, não tocado");

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).subscribers, 1, "só o subscriber do post_1 foi ingerido");
    db.close();
  });

  it("recusa cedo (exitCode 1) quando data/ está ausente, nunca tenta ler o backup", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-nodata-"));
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const originalExit = process.exitCode;
    await main(["--db", dbPath]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });

  it("erro claro (exitCode 1) quando o manifest.json da fatia 1 não existe", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-nosrc-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const sourceDir = resolve(tmp, "no-such-dir");
    const originalExit = process.exitCode;
    await main(["--db", dbPath, "--source-dir", sourceDir]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });
});
