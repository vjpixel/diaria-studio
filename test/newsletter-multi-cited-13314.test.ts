import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildMultiCited, renderMultiCitedSection, senderDisplayName } from "../scripts/lib/newsletter-multi-cited.ts";
import { buildIntake, joinKey } from "../scripts/audit-newsletter-intake.ts";
import { buildMultiCited as readMultiCited } from "../scripts/studio-ui/studio-gate.ts";
import { formatMultiCitedLine } from "../scripts/studio-ui/public/rv-gate-format.js";
import type { SenderRegistry } from "../scripts/lib/newsletter-senders.ts";

const l = (url: string, newsletter: string, score: number | null = 50, destino = "fora da edição") => ({url, title: "T " + url, score, newsletter, destino});

describe("citados em 2+ newsletters #13314", () => {
  it("conta remetentes distintos; mesma newsletter duas vezes vale 1", () => {
    const out = buildMultiCited([l("https://a.com/x", "A <a@x.com>"), l("https://a.com/x", "A <A@x.com>"), l("https://b.com/y", "B <b@x.com>"),
      l("https://b.com/y", "C <c@x.com>")], joinKey);
    assert.deepEqual(out.map((o) => o.url), ["https://b.com/y"]);
    assert.deepEqual(out[0].newsletters, ["B", "C"]);
  });
  it("ordena por nº desc, depois score desc; http e https agrupam", () => {
    const out = buildMultiCited([l("http://a.com/1", "A <a@x.com>", 10), l("https://a.com/1", "B <b@x.com>", 10),
      l("https://c.com/2", "A <a@x.com>", 90), l("https://c.com/2", "B <b@x.com>", 90), l("https://c.com/2", "C <c@x.com>", 90),
      l("https://d.com/3", "A <a@x.com>", 99), l("https://d.com/3", "B <b@x.com>", 99)], joinKey);
    assert.deepEqual(out.map((o) => [o.count, o.score]), [[3, 90], [2, 99], [2, 10]]);
  });
  it("nome de exibição com aspas e fallback para o e-mail", () => {
    assert.equal(senderDisplayName('"The Rundown" <hi@x.com>'), "The Rundown");
    assert.equal(senderDisplayName("solo@x.com"), "solo@x.com");
  });
  it("renderiza vazio e tabela sem quebrar com pipe no título", () => {
    assert.match(renderMultiCitedSection([]).join("\n"), /Nenhum link/);
    const md = renderMultiCitedSection([{url: "u", title: "a|b", score: null, destino: "d1", count: 2, newsletters: ["A", "B"]}]).join("\n");
    assert.match(md, /\| 2 \| a b \| A, B \| d1 \| PENDENTE \| u \|/);
  });
  it("buildIntake expõe cited_multi com destino refletindo a edição atual", () => {
    const reg: SenderRegistry = {version: 1, senders: {"a@x.com": {status: "aprovado", reason: "r", decided_at: "2026-11-04"}, "b@x.com": {status: "aprovado", reason: "r", decided_at: "2026-11-04"}}};
    const body = "https://openai.com/news/article-one";
    const threads = [{thread_id: "1", sender: "A <a@x.com>", subject: "s", date: "2026-11-04T10:00:00Z", body}, {thread_id: "2", sender: "B <b@x.com>", subject: "s", date: "2026-11-04T10:00:00Z", body}];
    const scores = [{all_scored: [{url: body, score: 70, title: "One"}]}];
    const fora = buildIntake(threads, reg, scores, [], {});
    assert.equal(fora.cited_multi[0].destino, "fora da edição");
    const dentro = buildIntake(threads, reg, scores, [], {highlights: [{article: {url: body}}]});
    assert.equal(dentro.cited_multi[0].destino, "destaque");
    assert.deepEqual(dentro.cited_multi[0].newsletters, ["A", "B"]);
  });
  it("painel: lê cited_multi do relatório e degrada sem ele", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mc-13314-"));
    try {
      assert.equal(readMultiCited(dir).available, false);
      mkdirSync(resolve(dir, "_internal"));
      writeFileSync(resolve(dir, "_internal/newsletter-link-scores.json"), JSON.stringify({links: []}));
      assert.equal(readMultiCited(dir).available, false);
      writeFileSync(resolve(dir, "_internal/newsletter-link-scores.json"), JSON.stringify({cited_multi: [{url: "u", title: "T", score: 5, destino: "radar", count: 2, newsletters: ["A", "B"]}]}));
      const got = readMultiCited(dir);
      assert.equal(got.available, true);
      assert.equal(formatMultiCitedLine(got.items[0]), "2× T — A, B — destino: radar — score 5");
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});
