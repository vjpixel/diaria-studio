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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  main,
  ingestOnePost,
  loadSourceEngagementManifest,
  readPostRecords,
  invalidateSiblingManifests,
  runEngagementIngestionLoop,
  MANIFEST_FLUSH_EVERY,
} from "../scripts/diaria-subscribers-ingest-beehiiv.ts";
import {
  ensureSubscriber,
  findSubscriberIdsByEmail,
  openDiariaSubscribersDb,
  getStoreCounts,
  recordEvent,
} from "../scripts/lib/diaria-subscribers-db.ts";
import { buildInitialManifest, type IngestManifest, type IngestManifestEntry } from "../scripts/lib/diaria-subscribers-ingest-manifest.ts";
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

  // #7187: com --reset, o store novo é construído num `.db` de TRABALHO e
  // instalado por rename atômico SÓ NO FIM. Este teste pina o contrato
  // ponta-a-ponta: dado velho é SUBSTITUÍDO (não mesclado), nenhum arquivo
  // de trabalho sobra, e a instalação de fato acontece (um commit esquecido
  // deixaria o store vazio → falha).
  it("--reset reconstrói o store via build em tmp + swap atômico, sem lixo de trabalho", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-reset-"));
    mkdirSync(resolve(tmp, "data/diaria-subscribers"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    // Store "velho" com dado que NÃO existe na fonte — um reset que não
    // instala o store novo (ou que mescla em vez de substituir) deixa rastro.
    const pre = openDiariaSubscribersDb(dbPath);
    const oldSub = ensureSubscriber(pre, "beehiiv", "ext-fantasma", "fantasma@x.com", "2025-12-31T00:00:00Z");
    recordEvent(pre, {
      subscriberId: oldSub,
      platform: "beehiiv",
      type: "sent",
      externalEventId: "e-fantasma",
      ts: "2025-12-31T00:00:00Z",
    });
    pre.close();

    const sourceManifest: EngagementManifest = {
      generated_at: "2026-01-01T00:00:00Z",
      posts: [{ post_id: "post_1", title: "Edição A", status: "ok", count: 1 }],
    };
    const sourceDir = makeSourceDir(tmp, sourceManifest, {
      post_1: [{ subscriber_id: "s1", email: "a@x.com", status: "delivered", timestamp: "2026-01-01T00:00:00Z" }],
    });

    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir, "--reset"]);

    const db = openDiariaSubscribersDb(dbPath);
    assert.deepEqual(findSubscriberIdsByEmail(db, "fantasma@x.com"), [], "dado VELHO substituído, não mesclado");
    assert.equal(findSubscriberIdsByEmail(db, "a@x.com").length, 1, "dado da reingestão presente");
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();

    const litter = readdirSync(resolve(tmp, "data/diaria-subscribers")).filter((e) =>
      e.includes(".rebuild-tmp-"),
    );
    assert.deepEqual(litter, [], "nenhum `.db` de trabalho sobrou após o swap");
  });

  // #7298: --reset apaga o .db compartilhado (Kit/Brevo inclusos) mas, sem
  // este fix, os manifests PRÓPRIOS de Kit/Brevo continuavam dizendo "ok" —
  // a próxima rodada de kit-subscribers-ingest.ts relataria "0 pendentes /
  // cobertura 100%" sobre um store que acabou de perder os eventos do Kit.
  // Este teste reproduz o cenário completo do corpo da issue: popular o
  // store com dado do Kit (manifest "ok" + evento no .db) → --reset da
  // Beehiiv → assertar que o manifest do Kit foi invalidado, então a
  // próxima carga do manifest (`pendingManifestEntries`) volta a marcar o
  // broadcast como pendente em vez de "100% ok" sobre dado destruído.
  it("--reset invalida o manifest do Kit (e do Brevo) irmãos no mesmo diretório do .db (#7298)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-reset-sibling-"));
    const dataDir = resolve(tmp, "data/diaria-subscribers");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, "diaria-subscribers.db");
    const manifestPath = resolve(dataDir, "beehiiv-ingest-manifest.json");
    const kitManifestPath = resolve(dataDir, "kit-ingest-manifest.json");
    const brevoManifestPath = resolve(dataDir, "brevo-ingest-manifest.json");

    // Store populado com dado do Kit (broadcast já ingerido com sucesso) —
    // o manifest do Kit reflete esse "ok".
    const pre = openDiariaSubscribersDb(dbPath);
    const kitSub = ensureSubscriber(pre, "kit", "kit-ext-1", "kit@x.com", "2026-01-01T00:00:00Z");
    recordEvent(pre, {
      subscriberId: kitSub,
      platform: "kit",
      type: "sent",
      externalEventId: "kit-broadcast-1-sent",
      ts: "2026-01-01T00:00:00Z",
    });
    pre.close();
    writeFileSync(
      kitManifestPath,
      JSON.stringify({
        generated_at: "2026-01-01T00:00:00Z",
        entries: [{ id: "1", label: "Broadcast 1", status: "ok", counts: { sent: 1 } }],
      }),
    );
    writeFileSync(
      brevoManifestPath,
      JSON.stringify({ generated_at: "2026-01-01T00:00:00Z", entries: [{ id: "brevo_diaria", status: "ok" }] }),
    );

    const sourceManifest: EngagementManifest = {
      generated_at: "2026-01-02T00:00:00Z",
      posts: [{ post_id: "post_1", title: "Edição A", status: "ok", count: 1 }],
    };
    const sourceDir = makeSourceDir(tmp, sourceManifest, {
      post_1: [{ subscriber_id: "s1", email: "a@x.com", status: "delivered", timestamp: "2026-01-02T00:00:00Z" }],
    });

    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir, "--reset"]);

    assert.equal(existsSync(kitManifestPath), false, "manifest do Kit foi invalidado pelo reset");
    assert.equal(existsSync(brevoManifestPath), false, "manifest do Brevo foi invalidado pelo reset (defensivo)");

    // Dado do Kit de fato sumiu do store novo — é exatamente por isso que o
    // manifest do Kit não pode continuar afirmando "ok".
    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(findSubscriberIdsByEmail(db, "kit@x.com").length, 0, "evento do Kit não sobrevive ao reset");
    db.close();
  });

  it("invalidateSiblingManifests: no-op (retorna []) quando nenhum manifest irmão existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-invalidate-siblings-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const removed = invalidateSiblingManifests(resolve(tmp, "data/diaria-subscribers.db"));
    assert.deepEqual(removed, []);
  });

  // Achado do review (#7298): a garantia central do design é "invalidar só
  // DEPOIS do swap atômico ter sucesso" — sem isso, um `--reset` que aborta
  // no meio (fonte da fatia 1 ausente, aqui) não pode ter tocado nada. O
  // teste acima ("--reset reconstrói...") só cobre o caminho de SUCESSO;
  // este cobre o caminho de ABORTO, que é a metade da garantia que faltava.
  it("--reset que ABORTA antes do swap (fonte da fatia 1 ausente) NÃO invalida os manifests irmãos", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-reset-abort-"));
    const dataDir = resolve(tmp, "data/diaria-subscribers");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, "diaria-subscribers.db");
    const manifestPath = resolve(dataDir, "beehiiv-ingest-manifest.json");
    const kitManifestPath = resolve(dataDir, "kit-ingest-manifest.json");
    const brevoManifestPath = resolve(dataDir, "brevo-ingest-manifest.json");
    const kitManifestContent = JSON.stringify({
      generated_at: "2026-01-01T00:00:00Z",
      entries: [{ id: "1", status: "ok" }],
    });
    writeFileSync(kitManifestPath, kitManifestContent);
    writeFileSync(brevoManifestPath, kitManifestContent);

    // Fonte da fatia 1 propositalmente AUSENTE — main() precisa abortar
    // (exitCode 1) ANTES de sequer construir o store novo, e portanto muito
    // antes de qualquer invalidação de manifest irmão.
    const missingSourceDir = resolve(tmp, "no-such-source-dir");
    const originalExit = process.exitCode;
    await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", missingSourceDir, "--reset"]);
    assert.equal(process.exitCode, 1, "aborta cedo — fonte da fatia 1 ausente");
    process.exitCode = originalExit;

    assert.equal(existsSync(kitManifestPath), true, "manifest do Kit sobrevive a um reset abortado");
    assert.equal(existsSync(brevoManifestPath), true, "manifest do Brevo sobrevive a um reset abortado");
    assert.equal(
      readFileSync(kitManifestPath, "utf8"),
      kitManifestContent,
      "conteúdo intocado, não só o arquivo presente",
    );
  });

  // #7170: até este fix, `saveManifest` rodava 1× por post processado — numa
  // reingestão de 256 posts em ~4min isso bastou pra derrubar o cliente
  // OneDrive (409/resourceModified em loop, `onedrive.service` morrendo em
  // silêncio, `status=0/SUCCESS`). O fix batcheia a escrita a cada
  // `MANIFEST_FLUSH_EVERY` posts + 1 flush garantido no fim (`finally`).
  // Este teste trava as DUAS metades da garantia: (1) a contagem de escritas
  // cai bem abaixo de 1-por-post — se alguém reverter a condição do flush
  // pra incondicional, o assert de `saves < postCount` falha; (2) mesmo
  // batchado, o resultado final não perde NENHUM post — se alguém remover o
  // `finally`/esquecer de flushar o resto do lote, os últimos posts
  // ficariam "pending" no manifesto (embora já ingeridos no `.db`) e os
  // asserts de `manifest.entries` abaixo falham.
  it(`manifesto é persistido em LOTES de ${MANIFEST_FLUSH_EVERY} posts (não 1 por post) e ainda assim termina com TODOS os entries corretos (#7170)`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-batch-"));
    mkdirSync(resolve(tmp, "data/diaria-subscribers"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    // Cruza a fronteira de pelo menos 1 lote completo, com sobra pro
    // `finally` flushar (postCount % MANIFEST_FLUSH_EVERY !== 0, de propósito).
    const postCount = MANIFEST_FLUSH_EVERY + 7;
    const posts: EngagementManifest["posts"] = [];
    const records: Record<string, unknown[]> = {};
    for (let i = 0; i < postCount; i++) {
      const id = `post_${i}`;
      posts.push({ post_id: id, title: `Edição ${i}`, status: "ok", count: 1 });
      records[id] = [
        { subscriber_id: `s${i}`, email: `u${i}@x.com`, status: "delivered", timestamp: "2026-01-01T00:00:00Z" },
      ];
    }
    const sourceManifest: EngagementManifest = { generated_at: "2026-01-01T00:00:00Z", posts };
    const sourceDir = makeSourceDir(tmp, sourceManifest, records);

    const errLines: string[] = [];
    const originalError = console.error;
    console.error = (msg: unknown) => {
      errLines.push(String(msg));
    };
    try {
      await main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir]);
    } finally {
      console.error = originalError;
    }

    const saveLine = errLines.find((l) => l.includes("manifesto persistido"));
    assert.ok(saveLine, "esperava o log de contagem de escritas do manifesto (#7170)");
    const savesMatch = saveLine!.match(/persistido (\d+)×/);
    assert.ok(savesMatch, `formato inesperado do log: ${saveLine}`);
    const saves = Number(savesMatch![1]);

    assert.ok(
      saves < postCount,
      `esperava bem menos de ${postCount} escritas do manifesto (lotes de ${MANIFEST_FLUSH_EVERY}); saiu ${saves} — ` +
        `regressão pra escrita por item?`,
    );
    // 1 (merge inicial, antes do loop) + ceil(postCount / MANIFEST_FLUSH_EVERY)
    // (flushes do loop, incluindo o flush final do `finally`).
    const expectedSaves = 1 + Math.ceil(postCount / MANIFEST_FLUSH_EVERY);
    assert.equal(saves, expectedSaves, "contagem exata de escritas do manifesto nesta run");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.entries.length, postCount, "nenhum post ficou de fora do manifesto final");
    for (const e of manifest.entries as Array<{ id: string; status: string }>) {
      assert.equal(e.status, "ok", `entry ${e.id} deveria estar "ok" no manifesto final, saiu "${e.status}"`);
    }

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(
      getStoreCounts(db).subscribers,
      postCount,
      "todos os subscribers foram ingeridos no .db mesmo com o manifesto batchado",
    );
    db.close();
  });

  // #7170 (achado do review): a docstring e o PR afirmam que o `finally`
  // cobre "sucesso, exceção, --limit" — só o caminho de sucesso tinha
  // teste. Este cobre `--limit` truncando a run: `pending` já vem cortado
  // pelo caller ANTES do loop (não é um `break` no meio), mas o contrato
  // que importa pro editor é o mesmo — só os posts dentro do limite viram
  // "ok", o resto fica intocado ("pending"), e a contagem de flushes bate
  // com o tamanho do array truncado, não com o total disponível.
  it("--limit trunca ANTES do loop — só os posts dentro do limite são processados/flushados, o resto fica pending (#7170 review)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-ingest-limit-"));
    mkdirSync(resolve(tmp, "data/diaria-subscribers"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/beehiiv-ingest-manifest.json");

    const totalAvailable = MANIFEST_FLUSH_EVERY + 10;
    const limit = MANIFEST_FLUSH_EVERY + 3; // cruza 1 fronteira de lote, não múltiplo de MANIFEST_FLUSH_EVERY
    const posts: EngagementManifest["posts"] = [];
    const records: Record<string, unknown[]> = {};
    for (let i = 0; i < totalAvailable; i++) {
      const id = `post_${i}`;
      posts.push({ post_id: id, title: `Edição ${i}`, status: "ok", count: 1 });
      records[id] = [
        { subscriber_id: `s${i}`, email: `u${i}@x.com`, status: "delivered", timestamp: "2026-01-01T00:00:00Z" },
      ];
    }
    const sourceManifest: EngagementManifest = { generated_at: "2026-01-01T00:00:00Z", posts };
    const sourceDir = makeSourceDir(tmp, sourceManifest, records);

    const result: { processed_this_run: number; manifest_saves_this_run: number } = await new Promise((resolvePromise) => {
      const originalLog = console.log;
      console.log = (msg: string) => {
        console.log = originalLog;
        resolvePromise(JSON.parse(msg));
      };
      void main(["--db", dbPath, "--manifest", manifestPath, "--source-dir", sourceDir, "--limit", String(limit)]);
    });

    assert.equal(result.processed_this_run, limit, "só os posts dentro do --limit foram processados");
    // 1 (merge inicial) + ceil(limit / MANIFEST_FLUSH_EVERY) — mesma fórmula
    // do teste de batching acima, mas sobre o array JÁ TRUNCADO pelo --limit,
    // não sobre totalAvailable.
    const expectedSaves = 1 + Math.ceil(limit / MANIFEST_FLUSH_EVERY);
    assert.equal(result.manifest_saves_this_run, expectedSaves, "contagem de flushes reflete o limite, não o total disponível");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const byStatus = new Map<string, string>(manifest.entries.map((e: { id: string; status: string }) => [e.id, e.status]));
    for (let i = 0; i < limit; i++) {
      assert.equal(byStatus.get(`post_${i}`), "ok", `post_${i} está dentro do --limit — deveria estar "ok"`);
    }
    for (let i = limit; i < totalAvailable; i++) {
      assert.equal(byStatus.get(`post_${i}`), "pending", `post_${i} está FORA do --limit — nunca deveria ter sido tocado`);
    }
  });
});

describe("runEngagementIngestionLoop — finally sob exceção mid-lote (#7170 review)", () => {
  // Achado do review: a docstring/PR afirmam que o `finally` cobre o
  // caminho de EXCEÇÃO, mas nada exercitava isso — `ingestOnePost` é
  // fail-soft (nunca lança), então a única fonte real de exceção dentro do
  // loop é `saveManifestFn` falhando durante um flush intermediário. Este
  // teste injeta exatamente esse cenário via dependency injection (o
  // parâmetro `saveManifestFn`, adicionado para viabilizar este teste sem
  // mockar `node:fs` — mock de fs neste repo já foi tentado e descartado,
  // ver comentário em test/stage4-capture-state.test.ts) e prova as duas
  // metades da garantia: (1) a exceção NUNCA é engolida — sempre propaga
  // pra quem chamou, e (2) o `finally` ainda tenta persistir o progresso
  // pendente até o ponto da falha antes de deixar a exceção subir.
  it("saveManifestFn lança no flush intermediário: propaga a exceção E o finally tenta persistir de novo o mesmo lote pendente", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-beehiiv-loop-exception-"));
    const dbPath = resolve(tmp, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(dbPath);

    const flushEvery = 5;
    const total = flushEvery + 3; // 1 fronteira de flush intermediário (no 5º) + 3 que NUNCA chegam a ser processados
    const pending: IngestManifestEntry[] = Array.from({ length: total }, (_, i) => ({
      id: `post_${i}`,
      status: "pending",
    }));
    // status "not_applicable" — ingestOnePost retorna cedo sem tocar
    // sourceDir/db, mantendo o teste focado só na lógica de flush do loop.
    const byId = new Map(
      pending.map((p) => [
        p.id,
        { post_id: p.id, title: p.id, status: "not_applicable" as const, count: undefined as number | undefined },
      ]),
    );

    const calls: IngestManifest[] = [];
    let callCount = 0;
    const flaky = (_path: string, manifest: IngestManifest) => {
      callCount++;
      calls.push(manifest);
      if (callCount === 1) throw new Error("falha simulada no flush intermediário (#7170 review)");
      // 2ª chamada (a do `finally`) "sucede" — não escreve em disco de
      // fato, só registra, pra manter o teste rápido e sem depender de fs.
    };

    let thrown: Error | undefined;
    try {
      runEngagementIngestionLoop(
        pending,
        byId,
        db,
        tmp,
        buildInitialManifest("2026-01-01T00:00:00Z"),
        resolve(tmp, "manifest.json"),
        flushEvery,
        flaky,
      );
    } catch (e) {
      thrown = e as Error;
    }
    db.close();

    assert.ok(thrown, "a exceção do flush intermediário precisa propagar — nunca ser engolida em silêncio");
    assert.equal(thrown!.message, "falha simulada no flush intermediário (#7170 review)");
    assert.equal(callCount, 2, "o finally tenta persistir de novo mesmo depois do flush intermediário ter falhado");

    // O loop PARA de iterar no momento da exceção (não continua pros 3
    // posts restantes) — as duas chamadas capturadas (a que falhou + a do
    // finally) refletem o MESMO estado: só os `flushEvery` primeiros posts,
    // nunca os 3 que viriam depois da fronteira de flush.
    for (const manifest of calls) {
      assert.equal(manifest.entries.length, flushEvery, "cada chamada de flush só tem os posts processados ANTES da exceção");
      assert.deepEqual(
        manifest.entries.map((e) => e.id).sort(),
        pending.slice(0, flushEvery).map((e) => e.id).sort(),
        "só post_0..post_4 — post_5/6/7 nunca chegaram a ser processados",
      );
    }
  });
});
