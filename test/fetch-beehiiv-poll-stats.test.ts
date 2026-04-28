import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPollUuidsFromHtml,
  pickTriviaPoll,
  filterAndNormalizeResponses,
} from "../scripts/fetch-beehiiv-poll-stats.ts";

describe("extractPollUuidsFromHtml", () => {
  it("extrai UUID do href de poll", () => {
    const html = `<a href="https://diaria.beehiiv.com/polls/529c183f-4cd9-4332-9416-17865125d095/respond">É IA?</a>`;
    assert.deepEqual(extractPollUuidsFromHtml(html), [
      "529c183f-4cd9-4332-9416-17865125d095",
    ]);
  });

  it("dedupa UUIDs preservando ordem da primeira ocorrência", () => {
    const html = `
      <a href="https://x.beehiiv.com/polls/aaa00000-0000-0000-0000-000000000001/r">a1</a>
      <a href="https://x.beehiiv.com/polls/bbb00000-0000-0000-0000-000000000002/r">b</a>
      <a href="https://x.beehiiv.com/polls/aaa00000-0000-0000-0000-000000000001/r">a2</a>
    `;
    assert.deepEqual(extractPollUuidsFromHtml(html), [
      "aaa00000-0000-0000-0000-000000000001",
      "bbb00000-0000-0000-0000-000000000002",
    ]);
  });

  it("normaliza UUID para lowercase", () => {
    const html = `https://x.beehiiv.com/polls/ABC00000-0000-0000-0000-000000000001/x`;
    assert.deepEqual(extractPollUuidsFromHtml(html), [
      "abc00000-0000-0000-0000-000000000001",
    ]);
  });

  it("HTML sem polls retorna vazio", () => {
    assert.deepEqual(extractPollUuidsFromHtml("<p>nada aqui</p>"), []);
  });
});

describe("pickTriviaPoll", () => {
  it("acha trivia entre polls do post (retorna com prefixo poll_)", () => {
    const postUuids = [
      "11111111-1111-1111-1111-111111111111", // voting
      "22222222-2222-2222-2222-222222222222", // trivia
    ];
    const trivia = new Set(["poll_22222222-2222-2222-2222-222222222222"]);
    assert.equal(
      pickTriviaPoll(postUuids, trivia),
      "poll_22222222-2222-2222-2222-222222222222",
    );
  });

  it("aceita set trivia sem prefixo poll_", () => {
    const postUuids = ["aaa00000-0000-0000-0000-000000000001"];
    const trivia = new Set(["aaa00000-0000-0000-0000-000000000001"]);
    assert.equal(
      pickTriviaPoll(postUuids, trivia),
      "poll_aaa00000-0000-0000-0000-000000000001",
    );
  });

  it("retorna null se nenhum poll do post for trivia", () => {
    const postUuids = ["11111111-1111-1111-1111-111111111111"];
    const trivia = new Set(["poll_99999999-9999-9999-9999-999999999999"]);
    assert.equal(pickTriviaPoll(postUuids, trivia), null);
  });

  it("retorna null se post não tem polls", () => {
    assert.equal(pickTriviaPoll([], new Set(["poll_x"])), null);
  });

  it("preserva ordem do post (primeira trivia ganha)", () => {
    const postUuids = [
      "aaa00000-0000-0000-0000-000000000001", // trivia
      "bbb00000-0000-0000-0000-000000000002", // trivia
    ];
    const trivia = new Set([
      "poll_aaa00000-0000-0000-0000-000000000001",
      "poll_bbb00000-0000-0000-0000-000000000002",
    ]);
    assert.equal(
      pickTriviaPoll(postUuids, trivia),
      "poll_aaa00000-0000-0000-0000-000000000001",
    );
  });
});

describe("filterAndNormalizeResponses", () => {
  const POST = "post_target";
  const ts = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

  it("filtra por post_id e converte unix→ISO", () => {
    const r = filterAndNormalizeResponses(
      [
        {
          id: "1",
          poll_choice_label: "A",
          created_at: ts("2026-04-23T10:00:00Z"),
          post_id: POST,
        },
        {
          id: "2",
          poll_choice_label: "B",
          created_at: ts("2026-04-22T10:00:00Z"),
          post_id: "post_other",
        },
        {
          id: "3",
          poll_choice_label: "B",
          created_at: ts("2026-04-23T11:00:00Z"),
          post_id: POST,
        },
      ],
      POST,
    );
    assert.equal(r.length, 2);
    assert.deepEqual(r, [
      { choice: "A", responded_at: "2026-04-23T10:00:00.000Z" },
      { choice: "B", responded_at: "2026-04-23T11:00:00.000Z" },
    ]);
  });

  it("dropa responses sem poll_choice_label", () => {
    const r = filterAndNormalizeResponses(
      [
        { id: "1", created_at: ts("2026-04-23T10:00:00Z"), post_id: POST },
        {
          id: "2",
          poll_choice_label: "A",
          created_at: ts("2026-04-23T11:00:00Z"),
          post_id: POST,
        },
      ],
      POST,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].choice, "A");
  });

  it("dropa responses com created_at inválido", () => {
    const r = filterAndNormalizeResponses(
      [
        {
          id: "1",
          poll_choice_label: "A",
          post_id: POST,
        },
        {
          id: "2",
          poll_choice_label: "B",
          created_at: NaN,
          post_id: POST,
        },
        {
          id: "3",
          poll_choice_label: "C",
          created_at: ts("2026-04-23T11:00:00Z"),
          post_id: POST,
        },
      ],
      POST,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].choice, "C");
  });

  it("array vazio quando nenhuma response bate o post_id", () => {
    const r = filterAndNormalizeResponses(
      [
        {
          id: "1",
          poll_choice_label: "A",
          created_at: ts("2026-04-23T10:00:00Z"),
          post_id: "post_other",
        },
      ],
      POST,
    );
    assert.equal(r.length, 0);
  });
});
