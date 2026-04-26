import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandBreakdownToResponses,
  pickFirstPoll,
  normalizeStats,
} from "../scripts/fetch-beehiiv-poll-stats.ts";

describe("expandBreakdownToResponses", () => {
  it("expande breakdown em responses sintéticas", () => {
    const poll = {
      options: [
        { label: "A", votes: 30 },
        { label: "B", votes: 12 },
      ],
    };
    const r = expandBreakdownToResponses(poll);
    assert.equal(r.length, 42);
    assert.equal(r.filter((x) => x.choice === "A").length, 30);
    assert.equal(r.filter((x) => x.choice === "B").length, 12);
  });

  it("opções sem votos são ignoradas", () => {
    const poll = {
      options: [
        { label: "A", votes: 5 },
        { label: "B", votes: 0 },
      ],
    };
    assert.equal(expandBreakdownToResponses(poll).length, 5);
  });

  it("opções sem label são ignoradas", () => {
    const poll = {
      options: [
        { label: "A", votes: 3 },
        { votes: 5 },
      ],
    };
    assert.equal(expandBreakdownToResponses(poll).length, 3);
  });

  it("poll sem options retorna vazio", () => {
    assert.deepEqual(expandBreakdownToResponses({}), []);
  });

  it("poll com options vazio retorna vazio", () => {
    assert.deepEqual(expandBreakdownToResponses({ options: [] }), []);
  });
});

describe("pickFirstPoll", () => {
  it("trivia tem prioridade sobre polls", () => {
    const stats = {
      trivia: [{ total_responses: 10 }],
      polls: [{ total_responses: 5 }],
    };
    assert.equal(pickFirstPoll(stats)?.total_responses, 10);
  });

  it("polls quando trivia ausente", () => {
    const stats = { polls: [{ total_responses: 5 }] };
    assert.equal(pickFirstPoll(stats)?.total_responses, 5);
  });

  it("poll_results como fallback final", () => {
    const stats = { poll_results: [{ total_responses: 3 }] };
    assert.equal(pickFirstPoll(stats)?.total_responses, 3);
  });

  it("retorna null se nenhum match", () => {
    assert.equal(pickFirstPoll({}), null);
  });
});

describe("normalizeStats", () => {
  it("identifica api_shape trivia + expande breakdown", () => {
    const stats = {
      trivia: [
        {
          options: [
            { label: "A", votes: 30 },
            { label: "B", votes: 12 },
          ],
        },
      ],
    };
    const r = normalizeStats(stats);
    assert.equal(r.api_shape, "trivia");
    assert.equal(r.responses.length, 42);
  });

  it("api_shape none + responses vazio quando sem polls", () => {
    const r = normalizeStats({});
    assert.equal(r.api_shape, "none");
    assert.equal(r.responses.length, 0);
    assert.equal(r.raw_poll, null);
  });

  it("usa polls se trivia ausente", () => {
    const stats = {
      polls: [{ options: [{ label: "A", votes: 7 }] }],
    };
    const r = normalizeStats(stats);
    assert.equal(r.api_shape, "polls");
    assert.equal(r.responses.length, 7);
  });
});
