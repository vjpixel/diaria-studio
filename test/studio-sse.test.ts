/**
 * test/studio-sse.test.ts (#3555) — formatação SSE de scripts/studio-ui/sse.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSseComment, formatSseEvent } from "../scripts/studio-ui/sse.ts";

describe("formatSseEvent (#3555)", () => {
  it("formata event + data JSON terminado em linha em branco dupla", () => {
    const out = formatSseEvent("state", { a: 1 });
    assert.equal(out, 'event: state\ndata: {"a":1}\n\n');
  });

  it("serializa arrays e objetos aninhados como JSON de uma linha", () => {
    const out = formatSseEvent("log-init", [{ message: "a" }, { message: "b" }]);
    assert.ok(out.startsWith("event: log-init\ndata: "));
    assert.ok(out.endsWith("\n\n"));
    const dataLine = out.split("\n")[1].slice("data: ".length);
    assert.deepEqual(JSON.parse(dataLine), [{ message: "a" }, { message: "b" }]);
  });
});

describe("formatSseComment (#3555)", () => {
  it("formata como linha de comentário SSE (heartbeat)", () => {
    assert.equal(formatSseComment("heartbeat"), ": heartbeat\n\n");
  });
});
