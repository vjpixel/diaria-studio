/**
 * Regressão #12540: claim conferido só contra o `article.summary` saía SUSTAINED
 * quando a fonte bloqueava.
 *
 * Caso real (edição 261026, D2, Axios): prefetch `blocked` (HTTP 403) e WebFetch
 * 403; dois claims SUSTAINED com a nota "verificado contra article.summary/título
 * do 01-approved.json". O gate mostrava "confirmado" para fato que ninguém leu
 * na fonte. Agora o runner rebaixa para SOURCE_UNREACHABLE (`secondary_match:
 * true`) e o gate lista o destaque com a fonte principal bloqueada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  downgradeSummaryOnlyClaim,
  formatGateSummary,
  formatUnverifiedSources,
  isSummaryOnlyCheck,
  normalizeFactCheckResult,
  type FactClaim,
  type ManifestEntry,
} from "../scripts/run-fact-checker.ts";

const AXIOS = "https://www.axios.com/2026/10/22/ai-agents-banks-unauthorized-accounts-access";
const D1_URL = "https://example.com/d1";

const REAL_NOTE = "verificado contra article.summary/título do 01-approved.json; detalhes além disso não puderam ser conferidos";

function claim(over: Partial<FactClaim> = {}): FactClaim {
  return {
    destaque: 2,
    claim_type: "number",
    text: "40% dos bancos",
    context: "Segundo a Axios, 40% dos bancos já...",
    sources: ["newsletter"],
    verdict: "SUSTAINED",
    source_url: AXIOS,
    note: REAL_NOTE,
    ...over,
  };
}

const BLOCKED_MANIFEST: ManifestEntry[] = [
  { destaque: 1, url: D1_URL, status: "ok", erro: null, bytes: 1200, fetched_at: "2026-10-26T10:00:00Z" },
  { destaque: 2, url: AXIOS, status: "blocked", erro: "HTTP 403", bytes: 0, fetched_at: "2026-10-26T10:00:00Z" },
];

describe("#12540 — claim conferido só contra article.summary", () => {
  it("nota real de 261026 (\"verificado contra article.summary\") é detectada", () => {
    assert.equal(isSummaryOnlyCheck({ note: REAL_NOTE }), true);
    assert.equal(isSummaryOnlyCheck({ note: "verificado via article.summary" }), true);
    assert.equal(isSummaryOnlyCheck({ note: "conferido só no resumo do 01-approved" }), true);
    assert.equal(isSummaryOnlyCheck({ secondary_match: true }), true);
  });

  it("nota de claim checado na fonte não dispara o rebaixamento", () => {
    assert.equal(isSummaryOnlyCheck({ note: "fonte diz 40% dos bancos, mesmo valor" }), false);
    assert.equal(isSummaryOnlyCheck({ note: undefined }), false);
    assert.equal(isSummaryOnlyCheck({ secondary_match: false, note: "confirmado no texto bruto" }), false);
  });

  it("SUSTAINED/INFERRED só contra o summary viram SOURCE_UNREACHABLE com secondary_match", () => {
    for (const verdict of ["SUSTAINED", "INFERRED"] as const) {
      const out = downgradeSummaryOnlyClaim(claim({ verdict }));
      assert.equal(out.verdict, "SOURCE_UNREACHABLE");
      assert.equal(out.secondary_match, true);
      assert.match(out.note!, new RegExp(`rebaixado de ${verdict}`));
      assert.match(out.note!, /detalhes além disso/); // nota original preservada
    }
  });

  it("DIVERGENT contra o summary fica DIVERGENT (já pede atenção)", () => {
    assert.equal(downgradeSummaryOnlyClaim(claim({ verdict: "DIVERGENT" })).verdict, "DIVERGENT");
  });

  it("normalizeFactCheckResult rebaixa e recalcula o summary (nenhum SUSTAINED sobra)", () => {
    const raw = {
      claims: [
        claim(),
        claim({ text: "3 bancos", note: undefined, secondary_match: "true" as unknown as boolean }),
        claim({ destaque: 1, source_url: D1_URL, note: "fonte confirma o número" }),
      ],
    };
    const r = normalizeFactCheckResult(raw, "261026");
    const d2 = r.claims.filter((c) => c.destaque === 2);
    assert.deepEqual(d2.map((c) => c.verdict), ["SOURCE_UNREACHABLE", "SOURCE_UNREACHABLE"]);
    assert.ok(d2.every((c) => c.secondary_match === true));
    assert.equal(r.summary.sustained, 1);
    assert.equal(r.summary.source_unreachable, 2);
  });

  it("gate: manifest blocked + claim casando com o summary → D2 destacado, sem ✅ verde", () => {
    const r = normalizeFactCheckResult({ claims: [claim(), claim({ destaque: 1, source_url: D1_URL, note: "ok" })] }, "261026");
    const out = formatGateSummary(r, { primaryUrls: [D1_URL, AXIOS], manifest: BLOCKED_MANIFEST });
    assert.match(out, /Fonte principal não baixada no pré-download/);
    assert.match(out, /D2: blocked \(HTTP 403\) — https:\/\/www\.axios\.com/);
    assert.match(out, /1 claim\(s\) sem verificação na fonte/);
    assert.match(out, /D2 \[number\] "40% dos bancos" \[só casou com o resumo do approved\]/);
    assert.doesNotMatch(out, /✅ Todos os claims verificados/);
    assert.match(out, /não é verde pleno/);
  });

  it("SOURCE_UNREACHABLE sem manifest também aparece no gate (antes ficava invisível)", () => {
    const r = normalizeFactCheckResult({ claims: [claim({ verdict: "SOURCE_UNREACHABLE", note: "403" })] }, "261026");
    const out = formatGateSummary(r);
    assert.match(out, /Claims NÃO verificados na fonte/);
    assert.doesNotMatch(out, /✅ Todos os claims verificados/);
  });

  it("manifest todo ok e nenhum SOURCE_UNREACHABLE → nenhuma linha nova", () => {
    const okManifest = BLOCKED_MANIFEST.map((e) => ({ ...e, status: "ok" as const, erro: null }));
    assert.deepEqual(formatUnverifiedSources([claim({ note: "fonte confirma" })], okManifest), []);
  });

  it("CLI --input-json: grava o veredito rebaixado e lê o manifest de fact-check-sources/", () => {
    const base = mkdtempSync(join(tmpdir(), "fc-12540-"));
    const dir = join(base, "261026");
    try {
      const internal = join(dir, "_internal");
      mkdirSync(join(internal, "fact-check-sources"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 2\n\nSegundo a Axios, 40% dos bancos já...\n", "utf8");
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d2\n\nTexto.\n", "utf8");
      writeFileSync(
        join(internal, "01-approved.json"),
        JSON.stringify({ highlights: [{ rank: 1, url: D1_URL }, { rank: 2, url: AXIOS }], radar: [] }),
        "utf8",
      );
      writeFileSync(join(internal, "fact-check-sources", "manifest.json"), JSON.stringify(BLOCKED_MANIFEST), "utf8");
      const fcPath = join(internal, "fact-check.json");
      writeFileSync(fcPath, JSON.stringify({ edition: "261026", claims: [claim()] }), "utf8");

      const root = join(import.meta.dirname, "..");
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", join(root, "scripts", "run-fact-checker.ts"), "--edition-dir", dir, "--input-json", fcPath],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      const saved = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.equal(saved.claims[0].verdict, "SOURCE_UNREACHABLE");
      assert.equal(saved.claims[0].secondary_match, true);
      assert.equal(saved.summary.sustained, 0);
      assert.match(res.stdout, /D2: blocked \(HTTP 403\)/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
