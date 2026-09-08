/**
 * test/hermes-fork-issue-queue.test.ts (#6817 item 7)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDualQueueReportLines,
  FORK_REPO,
  formatForkIssueRef,
  InvalidForkIssuesJsonError,
  parseForkIssuesJson,
  shouldConsultForkQueue,
} from "../scripts/lib/hermes-fork-issue-queue.ts";

describe("formatForkIssueRef", () => {
  it("prefixa com o repo do fork, nunca #N cru", () => {
    assert.equal(formatForkIssueRef(9), "vjpixel/hermes#9");
  });
  it("FORK_REPO é a constante única usada no prefixo", () => {
    assert.equal(formatForkIssueRef(1), `${FORK_REPO}#1`);
  });
});

describe("parseForkIssuesJson", () => {
  it("parseia o formato real de 'gh issue list --json number,title,labels,url'", () => {
    const raw = JSON.stringify([
      { number: 9, title: "Sync bidirecional do config", labels: [{ name: "enhancement" }], url: "https://github.com/vjpixel/hermes/issues/9" },
      { number: 6, title: "Redação de segredos", labels: [], url: "https://github.com/vjpixel/hermes/issues/6" },
    ]);
    const parsed = parseForkIssuesJson(raw);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      number: 9,
      title: "Sync bidirecional do config",
      labels: ["enhancement"],
      url: "https://github.com/vjpixel/hermes/issues/9",
    });
    assert.deepEqual(parsed[1].labels, []);
  });

  it("array vazio -> [] (fork sem issue aberta, não é erro)", () => {
    assert.deepEqual(parseForkIssuesJson("[]"), []);
  });

  it("labels como array de strings cru também é aceito", () => {
    const raw = JSON.stringify([{ number: 1, title: "x", labels: ["bug"], url: "u" }]);
    assert.deepEqual(parseForkIssuesJson(raw)[0].labels, ["bug"]);
  });

  it("title/url ausentes viram string vazia, não lançam", () => {
    const raw = JSON.stringify([{ number: 1 }]);
    const parsed = parseForkIssuesJson(raw);
    assert.equal(parsed[0].title, "");
    assert.equal(parsed[0].url, "");
    assert.deepEqual(parsed[0].labels, []);
  });

  it("JSON inválido lança InvalidForkIssuesJsonError", () => {
    assert.throws(() => parseForkIssuesJson("{not json"), InvalidForkIssuesJsonError);
  });

  it("não-array no topo lança InvalidForkIssuesJsonError", () => {
    assert.throws(() => parseForkIssuesJson('{"number": 1}'), InvalidForkIssuesJsonError);
  });

  it("item sem number numérico lança InvalidForkIssuesJsonError", () => {
    assert.throws(() => parseForkIssuesJson(JSON.stringify([{ number: "9", title: "x" }])), InvalidForkIssuesJsonError);
  });

  it("item que não é objeto lança InvalidForkIssuesJsonError", () => {
    assert.throws(() => parseForkIssuesJson(JSON.stringify([42])), InvalidForkIssuesJsonError);
  });
});

describe("shouldConsultForkQueue — fila do fork é SEGUNDA, sem decisão nova de prioridade", () => {
  it("fila primária tem trabalho elegível -> não consulta o fork neste ciclo", () => {
    assert.equal(shouldConsultForkQueue(true), false);
  });
  it("fila primária SEM trabalho elegível -> consulta o fork", () => {
    assert.equal(shouldConsultForkQueue(false), true);
  });
});

describe("buildDualQueueReportLines", () => {
  it("fila do fork vazia produz linha explícita, não omite a fila", () => {
    const lines = buildDualQueueReportLines(3, []);
    assert.equal(lines[0], "Fila primária (diaria-studio): 3 issue(s) elegível(is) via classifyExecTrack.");
    assert.equal(lines[1], `Fila secundária (${FORK_REPO}): nenhuma issue aberta.`);
  });

  it("cada issue do fork aparece prefixada, com labels quando presentes", () => {
    const lines = buildDualQueueReportLines(0, [
      { number: 9, title: "Sync bidirecional do config", labels: ["enhancement"], url: "u" },
      { number: 6, title: "Redação de segredos", labels: [], url: "u2" },
    ]);
    assert.ok(lines.some((l) => l.includes("vjpixel/hermes#9: Sync bidirecional do config [enhancement]")));
    assert.ok(lines.some((l) => l.includes("vjpixel/hermes#6: Redação de segredos") && !l.includes("[")));
    assert.ok(!lines.some((l) => l.includes("#9:") && !l.includes("vjpixel/hermes#9:")));
  });
});
