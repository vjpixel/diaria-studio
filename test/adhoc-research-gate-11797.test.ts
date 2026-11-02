/**
 * test/adhoc-research-gate-11797.test.ts
 *
 * Regressão do #11797: pesquisa ad-hoc das newsletters recebidas (edição
 * 261103) sugeriu o Gemini 4 Carbon com data de newsletter (30/10, real 28/10)
 * e comparações não sustentadas pela primária, e o Cathedral x Anthropic
 * (26-28/10) fora da janela que começava em 30/10.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyAdhocCandidate,
  classifyAdhocCandidates,
  normalizeDay,
} from "../scripts/lib/adhoc-research-gate.ts";
import { parseCandidatesJson } from "../scripts/check-adhoc-research-candidates.ts";

const WINDOW = "2026-10-30";

describe("classifyAdhocCandidate (#11797)", () => {
  it("caso real Carbon: data de newsletter + comparação sem primária → nao_verificado", () => {
    const r = classifyAdhocCandidate(
      {
        url: "https://blog.google/technology/ai/gemini-4-carbon/",
        title: "Gemini 4 Carbon",
        date: "2026-10-30",
        date_source: "newsletter",
        claims: [{ text: "supera Opus e GPT em código", source: "newsletter" }],
      },
      WINDOW,
    );
    assert.equal(r.verdict, "nao_verificado");
    assert.deepEqual(r.unverified_claims, ["supera Opus e GPT em código"]);
    assert.ok(r.reasons.some((x) => x.includes("não lida da fonte primária")));
  });

  it("Carbon com a data primária real (28/10) cai fora da janela que começa em 30/10", () => {
    const r = classifyAdhocCandidate(
      {
        url: "https://blog.google/technology/ai/gemini-4-carbon/",
        date: "2026-10-28",
        date_source: "primary",
        claims: [{ text: "59 pts no índice da Artificial Analysis", source: "primary" }],
      },
      WINDOW,
    );
    assert.equal(r.verdict, "fora_da_janela");
  });

  it("caso real Cathedral: data anterior à janela vence nao_verificado", () => {
    const r = classifyAdhocCandidate(
      { url: "https://example.com/cathedral-anthropic", date: "2026-10-27", date_source: "unknown" },
      WINDOW,
    );
    assert.equal(r.verdict, "fora_da_janela");
  });

  it("data primária dentro da janela e todos os claims primários → ok", () => {
    const r = classifyAdhocCandidate(
      {
        url: "https://a.com/1",
        date: "2026-10-30T14:00:00Z",
        date_source: "primary",
        claims: [{ text: "88,2% no SEC-bench Pro", source: "PRIMARY" }],
      },
      WINDOW,
    );
    assert.equal(r.verdict, "ok");
    assert.equal(r.date, "2026-10-30");
    assert.deepEqual(r.reasons, []);
  });

  it("data ausente, ilegível ou inexistente → nao_verificado", () => {
    for (const date of [null, "", "30/10/2026", "2026-02-31"]) {
      const r = classifyAdhocCandidate({ url: "https://a.com/x", date, date_source: "primary" }, WINDOW);
      assert.equal(r.verdict, "nao_verificado", `date=${String(date)}`);
    }
  });

  it("claim sem campo source conta como não verificado", () => {
    const r = classifyAdhocCandidate(
      { url: "https://a.com/1", date: "2026-10-31", date_source: "primary", claims: [{ text: "o primeiro a" }] },
      WINDOW,
    );
    assert.equal(r.verdict, "nao_verificado");
  });
});

describe("classifyAdhocCandidates", () => {
  it("agrega contagens e rejeita window_start inválido", () => {
    const rep = classifyAdhocCandidates(
      [
        { url: "https://a.com/1", date: "2026-10-31", date_source: "primary" },
        { url: "https://a.com/2", date: "2026-10-28", date_source: "primary" },
        { url: "https://a.com/3", date: "2026-10-31", date_source: "newsletter" },
      ],
      WINDOW,
    );
    assert.deepEqual([rep.total, rep.ok, rep.fora_da_janela, rep.nao_verificado], [3, 1, 1, 1]);
    assert.throws(() => classifyAdhocCandidates([], "30/10"));
  });

  it("normalizeDay", () => {
    assert.equal(normalizeDay("2026-10-30"), "2026-10-30");
    assert.equal(normalizeDay("2026-10-30 08:00"), "2026-10-30");
    assert.equal(normalizeDay("2026-13-01"), null);
    assert.equal(normalizeDay(undefined), null);
  });
});

describe("CLI check-adhoc-research-candidates", () => {
  it("parseCandidatesJson aceita array e { candidates } e recusa item sem url", () => {
    assert.equal(parseCandidatesJson('[{"url":"https://a"}]').length, 1);
    assert.equal(parseCandidatesJson('{"candidates":[{"url":"https://a"}]}').length, 1);
    assert.throws(() => parseCandidatesJson('[{"title":"x"}]'));
    assert.throws(() => parseCandidatesJson('{"x":1}'));
  });

  it("exit 3 quando há item marcado, exit 0 quando todos ok; grava --out", () => {
    const dir = mkdtempSync(join(tmpdir(), "adhoc-11797-"));
    try {
      const flagged = join(dir, "flagged.json");
      const clean = join(dir, "clean.json");
      const out = join(dir, "out.json");
      writeFileSync(flagged, JSON.stringify([{ url: "https://a.com/1", date: "2026-10-27", date_source: "primary" }]));
      writeFileSync(clean, JSON.stringify([{ url: "https://a.com/1", date: "2026-10-31", date_source: "primary" }]));
      const run = (file: string, extra: string[] = []) =>
        spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/check-adhoc-research-candidates.ts", "--candidates", file, "--window-start", WINDOW, ...extra],
          { encoding: "utf8" },
        );
      const a = run(flagged, ["--out", out]);
      assert.equal(a.status, 3, a.stderr);
      assert.equal(JSON.parse(readFileSync(out, "utf8")).fora_da_janela, 1);
      const b = run(clean);
      assert.equal(b.status, 0, b.stderr);
      assert.equal(JSON.parse(b.stdout).ok, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
