/**
 * contest-poll-ingest.test.ts (#7209, fatia 14 do épico #7163)
 *
 * Cobre o miolo puro da ingestão de resposta ao concurso "ache o erro" e
 * voto do "É IA?" — parse tolerante do jsonl, chaves naturais, guard de
 * identidade anônima do poll, e a escrita idempotente contra um SQLite
 * `:memory:` real (mesmo padrão de kit-subscribers-ingest.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseContestEntriesJsonl,
  buildContestReplyExternalId,
  ingestContestReplies,
  mapRaffleEntryToContestEntry,
  isAnonymousPollIdentity,
  buildPollVoteExternalId,
  ingestPollVotes,
} from "../scripts/lib/contest-poll-ingest.ts";
import {
  openDiariaSubscribersDb,
  findSubscriberIdByAlias,
  getSubscriberTimeline,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";

// ---------------------------------------------------------------------------
// parseContestEntriesJsonl
// ---------------------------------------------------------------------------

describe("parseContestEntriesJsonl", () => {
  it("parseia N linhas válidas", () => {
    const raw = [
      JSON.stringify({ reader_email: "a@x.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }),
      JSON.stringify({
        reader_email: "b@x.com",
        reader_name: "Bea",
        edition: "260901",
        reply_thread_id: "t1",
        confirmed_at: "2026-09-01T11:00:00Z",
      }),
    ].join("\n");
    const entries = parseContestEntriesJsonl(raw);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].reader_name, "Bea");
    assert.equal(entries[1].reply_thread_id, "t1");
  });

  it("linha malformada (JSON inválido) é ignorada, não aborta o resto do arquivo", () => {
    const raw = [
      JSON.stringify({ reader_email: "a@x.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }),
      "{not valid json",
      JSON.stringify({ reader_email: "b@x.com", edition: "260901", confirmed_at: "2026-09-01T11:00:00Z" }),
    ].join("\n");
    const entries = parseContestEntriesJsonl(raw);
    assert.equal(entries.length, 2);
  });

  it("linha sem reader_email/edition/confirmed_at utilizável é ignorada", () => {
    const raw = [
      JSON.stringify({ edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }), // sem reader_email
      JSON.stringify({ reader_email: "a@x.com", confirmed_at: "2026-09-01T10:00:00Z" }), // sem edition
      JSON.stringify({ reader_email: "a@x.com", edition: "260901" }), // sem confirmed_at
      JSON.stringify({ reader_email: "", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }), // vazio
    ].join("\n");
    assert.equal(parseContestEntriesJsonl(raw).length, 0);
  });

  it("linhas vazias são puladas sem erro", () => {
    const raw = "\n\n" + JSON.stringify({ reader_email: "a@x.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }) + "\n\n";
    assert.equal(parseContestEntriesJsonl(raw).length, 1);
  });

  it("string vazia devolve []", () => {
    assert.deepEqual(parseContestEntriesJsonl(""), []);
  });
});

// ---------------------------------------------------------------------------
// buildContestReplyExternalId
// ---------------------------------------------------------------------------

describe("buildContestReplyExternalId", () => {
  it("normaliza e-mail e escopa por edição", () => {
    assert.equal(
      buildContestReplyExternalId("  Leitor@Example.com ", "260901"),
      "leitor@example.com:contest_reply:260901",
    );
  });

  it("inclui reply_thread_id quando presente (2 threads da mesma pessoa/edição não colidem)", () => {
    const a = buildContestReplyExternalId("a@x.com", "260901", "t1");
    const b = buildContestReplyExternalId("a@x.com", "260901", "t2");
    assert.notEqual(a, b);
    assert.equal(a, "a@x.com:contest_reply:260901:t1");
  });
});

// ---------------------------------------------------------------------------
// ingestContestReplies
// ---------------------------------------------------------------------------

describe("ingestContestReplies", () => {
  it("grava 1 subscriber (platform beehiiv) + 1 evento contest_reply por entrada nova", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestContestReplies(
      db,
      [{ reader_email: "leitor@example.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }],
      "2026-09-02T00:00:00Z",
    );
    assert.equal(result.newEvents, 1);
    assert.equal(result.subscribersTouched, 1);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", null, "leitor@example.com");
    assert.notEqual(subscriberId, null);
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "contest_reply");
    assert.equal(timeline[0].edicao, "260901");
    assert.equal(timeline[0].ts, "2026-09-01T10:00:00Z");
    db.close();
  });

  it("idempotente — re-rodar a MESMA entrada não duplica evento", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const entry = { reader_email: "leitor@example.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" };
    ingestContestReplies(db, [entry]);
    const r2 = ingestContestReplies(db, [entry]);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    assert.equal(getStoreCounts(db).events, 1);
    db.close();
  });

  it("a MESMA pessoa em 2 edições diferentes grava 2 eventos distintos", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestContestReplies(db, [
      { reader_email: "leitor@example.com", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" },
      { reader_email: "leitor@example.com", edition: "260902", confirmed_at: "2026-09-02T10:00:00Z" },
    ]);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", null, "leitor@example.com");
    assert.equal(getSubscriberTimeline(db, subscriberId!).length, 2);
    db.close();
  });

  it("email vazio é contado em skippedNoEmail, nunca vira subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestContestReplies(db, [{ reader_email: "  ", edition: "260901", confirmed_at: "2026-09-01T10:00:00Z" }]);
    assert.equal(result.skippedNoEmail, 1);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// mapRaffleEntryToContestEntry (#7209 residual — fonte VIVA raffle-numbers.json)
// ---------------------------------------------------------------------------

describe("mapRaffleEntryToContestEntry", () => {
  it("mapeia email/nickname/edition/issued_at 1:1, reply_thread_id sempre undefined", () => {
    const mapped = mapRaffleEntryToContestEntry({
      email: "leitor@example.com",
      nickname: "Leitor",
      edition: "260901",
      issued_at: "2026-09-01T10:00:00Z",
    });
    assert.deepEqual(mapped, {
      reader_email: "leitor@example.com",
      reader_name: "Leitor",
      edition: "260901",
      confirmed_at: "2026-09-01T10:00:00Z",
    });
  });

  it("nickname ausente vira reader_name undefined, não string vazia", () => {
    const mapped = mapRaffleEntryToContestEntry({
      email: "bea@example.com",
      edition: "260902",
      issued_at: "2026-09-02T11:00:00Z",
    });
    assert.equal(mapped.reader_name, undefined);
  });

  it("saída alimenta ingestContestReplies diretamente (mesmo shape que parseContestEntriesJsonl produz)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const mapped = mapRaffleEntryToContestEntry({
      email: "leitor@example.com",
      edition: "260901",
      issued_at: "2026-09-01T10:00:00Z",
    });
    const result = ingestContestReplies(db, [mapped]);
    assert.equal(result.newEvents, 1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// isAnonymousPollIdentity
// ---------------------------------------------------------------------------

describe("isAnonymousPollIdentity", () => {
  it("identifica o domínio anônimo do voto web (#4433)", () => {
    assert.equal(isAnonymousPollIdentity("a1b2c3@web.eia.diaria.local"), true);
    assert.equal(isAnonymousPollIdentity("A1B2C3@WEB.EIA.DIARIA.LOCAL"), true, "case-insensitive");
    assert.equal(isAnonymousPollIdentity("  a1b2c3@web.eia.diaria.local  "), true, "tolera espaço nas pontas");
  });

  it("e-mail real não casa", () => {
    assert.equal(isAnonymousPollIdentity("leitor@example.com"), false);
    assert.equal(isAnonymousPollIdentity("a@webmail.com"), false, "não é bastante conter 'web'");
  });
});

// ---------------------------------------------------------------------------
// buildPollVoteExternalId
// ---------------------------------------------------------------------------

describe("buildPollVoteExternalId", () => {
  it("normaliza e-mail e escopa por edição", () => {
    assert.equal(buildPollVoteExternalId("  Leitor@Example.com ", "260901"), "leitor@example.com:poll_vote:260901");
  });
});

// ---------------------------------------------------------------------------
// ingestPollVotes
// ---------------------------------------------------------------------------

describe("ingestPollVotes", () => {
  it("grava 1 subscriber (platform beehiiv) + 1 evento poll_vote por voto identificado novo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestPollVotes(db, [{ email: "leitor@example.com", edition: "260901", ts: "2026-09-01T12:00:00Z" }]);
    assert.equal(result.newEvents, 1);
    assert.equal(result.subscribersTouched, 1);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", null, "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(timeline[0].type, "poll_vote");
    assert.equal(timeline[0].edicao, "260901");
    db.close();
  });

  it("voto anônimo ({uuid}@web.eia.diaria.local) NUNCA vira subscriber/event (#4433)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestPollVotes(db, [
      { email: "a1b2c3@web.eia.diaria.local", edition: "260901", ts: "2026-09-01T12:00:00Z" },
    ]);
    assert.equal(result.skippedAnonymous, 1);
    assert.equal(result.newEvents, 0);
    assert.equal(getStoreCounts(db).subscribers, 0, "identidade anônima nunca é gravada — guard de fusão do #4433");
    db.close();
  });

  it("mistura de votos identificados e anônimos: só os identificados entram", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestPollVotes(db, [
      { email: "leitor@example.com", edition: "260901", ts: "2026-09-01T12:00:00Z" },
      { email: "anon@web.eia.diaria.local", edition: "260901", ts: "2026-09-01T12:05:00Z" },
    ]);
    assert.equal(result.newEvents, 1);
    assert.equal(result.skippedAnonymous, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("idempotente — re-rodar o MESMO voto não duplica evento", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const vote = { email: "leitor@example.com", edition: "260901", ts: "2026-09-01T12:00:00Z" };
    ingestPollVotes(db, [vote]);
    const r2 = ingestPollVotes(db, [vote]);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    db.close();
  });

  it("email vazio é contado em skippedNoEmail, nunca vira subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestPollVotes(db, [{ email: "  ", edition: "260901", ts: "2026-09-01T12:00:00Z" }]);
    assert.equal(result.skippedNoEmail, 1);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });
});
