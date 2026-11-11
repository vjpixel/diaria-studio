/**
 * #12537 (decisão do editor, briefing 261111): o detector de prévia de paywall
 * ligado ao gate do fact-check. O PR #12648 gravou `completeness` no manifest
 * e pôs o contrato no prompt do `fact-checker` ("prévia + claim fora do texto
 * = SOURCE_UNREACHABLE, nunca NOT_FOUND_IN_SOURCE"). Faltava:
 *   1. o normalizador garantir esse contrato em TS — sem isso, um
 *      NOT_FOUND_IN_SOURCE do agente contra a prévia faz o `--check-blocking`
 *      sair exit 2 por um fato que pode estar no trecho cortado;
 *   2. `extras.json` registrar a prévia também nas fontes adicionais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getBlockingClaims,
  normalizeFactCheckResult,
  previewDestaques,
  recastPreviewNotFound,
  type FactClaim,
  type ManifestEntry,
} from "../scripts/run-fact-checker.ts";
import { addEditorExtraSource } from "../scripts/lib/fact-check-extra-sources.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(" ");
const PREVIEW_HTML = `<html><head>
<meta property="article:content_tier" content="metered">
<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>
</head><body><article><p>${words(250)}</p></article></body></html>`;
const FREE_HTML = `<html><body><article><p>${words(600)}</p></article></body></html>`;

const T = "2026-11-11T00:00:00Z";
const manifest: ManifestEntry[] = [
  { destaque: 1, url: "https://www.bloomberg.com/x", status: "ok", erro: null, bytes: 1500, fetched_at: T, completeness: "preview", paywall_signals: ["meta:content_tier=metered"], words: 250 },
  { destaque: 2, url: "https://b.test/y", status: "ok", erro: null, bytes: 4000, fetched_at: T, completeness: "full", paywall_signals: [], words: 900 },
  // manifest anterior ao #12537: sem completeness
  { destaque: 3, url: "https://c.test/z", status: "ok", erro: null, bytes: 4000, fetched_at: T },
];

function claim(over: Partial<FactClaim> = {}): FactClaim {
  return {
    destaque: 1,
    claim_type: "number",
    text: "US$ 10 bilhões",
    context: "a empresa levantou US$ 10 bilhões",
    sources: ["newsletter"],
    verdict: "NOT_FOUND_IN_SOURCE",
    source_url: "https://www.bloomberg.com/x",
    ...over,
  } as FactClaim;
}

describe("#12537 — NOT_FOUND contra prévia de paywall vira SOURCE_UNREACHABLE", () => {
  it("previewDestaques só pega ok + preview", () => {
    assert.deepEqual([...previewDestaques(manifest)], [1]);
    assert.equal(previewDestaques(null).size, 0);
    assert.equal(previewDestaques([{ ...manifest[0], status: "blocked" }]).size, 0);
  });

  it("recastPreviewNotFound rebaixa só NOT_FOUND do destaque em prévia", () => {
    const p = previewDestaques(manifest);
    const r = recastPreviewNotFound(claim({ note: "não achei" }), p);
    assert.equal(r.verdict, "SOURCE_UNREACHABLE");
    assert.match(r.note!, /^\[rebaixado de NOT_FOUND_IN_SOURCE: fonte principal só em prévia de paywall \(#12537\)\] não achei$/);
    assert.equal(recastPreviewNotFound(claim({ destaque: 2 }), p).verdict, "NOT_FOUND_IN_SOURCE");
    assert.equal(recastPreviewNotFound(claim({ destaque: 3 }), p).verdict, "NOT_FOUND_IN_SOURCE");
    assert.equal(recastPreviewNotFound(claim({ verdict: "DIVERGENT" }), p).verdict, "DIVERGENT");
    assert.equal(recastPreviewNotFound(claim({ destaque: "secondary" as unknown as number }), p).verdict, "NOT_FOUND_IN_SOURCE");
  });

  it("normalizeFactCheckResult com manifest: claim sai do --check-blocking e o summary recalcula", () => {
    const raw = { claims: [claim(), claim({ destaque: 2, source_url: "https://b.test/y" })] };
    const before = normalizeFactCheckResult(raw, "261111");
    assert.equal(getBlockingClaims(before.claims).length, 2, "sem manifest, comportamento antigo");

    const r = normalizeFactCheckResult(raw, "261111", { manifest });
    assert.equal(r.claims[0].verdict, "SOURCE_UNREACHABLE");
    assert.equal(r.claims[1].verdict, "NOT_FOUND_IN_SOURCE");
    assert.equal(r.summary.not_found_in_source, 1);
    assert.equal(r.summary.source_unreachable, 1);
    const blocking = getBlockingClaims(r.claims);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].destaque, 2);
  });
});

describe("#12537 — extras.json registra a prévia", () => {
  it("addEditorExtraSource grava completeness/paywall_signals/words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-extra-12537-"));
    try {
      const f = (async (u: string) =>
        new Response(String(u).includes("bbg") ? PREVIEW_HTML : FREE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch;
      const prev = await addEditorExtraSource(["https://p.test/a"], dir, 1, "https://x.test/bbg", f);
      assert.equal(prev.status, "ok");
      assert.equal(prev.completeness, "preview");
      assert.ok(prev.paywall_signals!.includes("meta:content_tier=metered"));
      assert.equal(prev.words, 250);
      const full = await addEditorExtraSource(["https://p.test/a"], dir, 1, "https://x.test/free", f);
      assert.equal(full.completeness, "full");
      assert.deepEqual(full.paywall_signals, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
