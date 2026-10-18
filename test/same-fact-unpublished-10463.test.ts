/**
 * #10463 — regressão do caso real 261019 × 261016.
 *
 * O D3 candidato de 261019 ("NVIDIA Expands Nemotron Family With ... Super VL")
 * gerou 🚨 MESMO FATO contra "NVIDIA Nemotron 3.5 Super VL Powers Specialized
 * Agents..." de 261016 — mas esse item era um LANÇAMENTO aprovado no gate 1
 * de 261016 que caiu no cap do Stage 2 (`apply-stage2-caps.ts`) e NUNCA saiu
 * (ausente de `02-reviewed.md`). Dois defeitos:
 *   1. o MESMO FATO lia o pool secundário passado de `01-approved.json`
 *      (inclui o que foi cortado depois) — falso positivo; em `--no-gates` o
 *      mesmo caminho remove o item corrente (`removeSameFactSecondary`);
 *   2. a nota do relatório dizia "repete o destaque" para um item de bucket
 *      secundário — a 1ª sessão registrou que o rebaixamento (1u-quater)
 *      "não disparou", quando ele só age contra D1–D3 passados (#9100).
 *
 * Fixtures com títulos/URLs/resumos reais de data/editions/2610/{261016,261019}
 * (copiados — `data/` não existe no CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPastApprovedSecondary, DEFAULT_SECONDARY_BUCKETS } from "../scripts/check-highlight-themes.ts";
import { findSameFactMatches, formatHighlightSameFactNotes } from "../scripts/lib/same-fact-check.ts";

const NEMOTRON_261016 = {
  url: "https://developer.nvidia.com/blog/nvidia-nemotron-3-5-super-vl-powers-specialized-agents-with-multimodal-reasoning",
  title: "NVIDIA Nemotron 3.5 Super VL Powers Specialized Agents with Multimodal Reasoning",
  summary: "Always-on agents are taking on longer, more complex enterprise workflows.",
};
const GROK_261016 = { url: "https://x.ai/news/grok-voice-3", title: "Introducing Grok Voice 3.0" };
const MUSE_261016 = {
  url: "https://huggingface.co/blog/meta-muse-spark-open",
  title: "Welcome Muse Spark Open: open-weight frontier multimodal mixture-of-experts model from Meta",
};

// Trecho real do 02-reviewed.md de 261016 (LANÇAMENTOS saiu só com Muse + Grok).
const REVIEWED_261016 = `**🚀 LANÇAMENTOS**

**[Welcome Muse Spark Open: open-weight frontier multimodal mixture-of-experts model from Meta](https://huggingface.co/blog/meta-muse-spark-open)**
A Meta diz querer avançar e democratizar a inteligência artificial por meio de código aberto e ciência aberta.

**[Introducing Grook Voice 3.0](https://x.ai/news/grok-voice-3)**
Segundo a xAI, o modelo de voz ficou em 1º no Speech-to-Speech Index da Artificial Analysis.
`;

const D3_261019 = {
  kind: "highlight",
  rank: 3,
  url: "https://blogs.nvidia.com/blog/nemotron-3-5-super-vl/",
  title: "Open From Data Center to Desktop: NVIDIA Expands Nemotron Family With Highest Efficiency Super VL and Bolt Models",
  summary:
    "NVIDIA today released Nemotron 3.5 Super VL, an open 120-billion-parameter model that delivers the fastest task completion and highest accuracy for specialized always-on agents.",
};
const GROK_RADAR_261019 = {
  kind: "radar",
  url: "https://docs.x.ai/developers/models/grok-voice-3.0",
  title: "xAI Introduces Grok Voice 3.0 Speech-to-Speech Model for Voice Agents",
  summary: "xAI announced Grok Voice 3.0 on October 14, 2026, making the speech-to-speech model available in its Voice Agent API at $0.08 per minute.",
};

function fixture(withReviewed: boolean): { root: string; editionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "same-fact-10463-"));
  const editionsDir = join(root, "editions");
  const dir = join(editionsDir, "2610", "261016");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [], lancamento: [MUSE_261016, GROK_261016, NEMOTRON_261016], radar: [] }),
  );
  if (withReviewed) writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261016);
  return { root, editionsDir };
}

function pastSecondary(editionsDir: string, publishedOnly: boolean) {
  return readPastApprovedSecondary(editionsDir, 3, "261019", DEFAULT_SECONDARY_BUCKETS, { publishedOnly })
    .map((p) => ({ title: p.title, aammdd: p.edition, bucket: p.bucket }));
}

describe("#10463: MESMO FATO só contra o que de fato saiu", () => {
  it("item cortado depois do gate 1 (fora do 02-reviewed.md) não gera MESMO FATO; o publicado segue gerando", () => {
    const { root, editionsDir } = fixture(true);
    try {
      const past = pastSecondary(editionsDir, true);
      assert.deepEqual(past.map((p) => p.title).sort(), [GROK_261016.title, MUSE_261016.title].sort());
      const w = findSameFactMatches([D3_261019, GROK_RADAR_261019], past);
      assert.ok(!w.some((x) => x.item_url === D3_261019.url), "Nemotron cortado em 261016 não é repetição");
      // Grok Voice 3.0 saiu em 261016 → o aviso (verdadeiro positivo) continua.
      assert.ok(w.some((x) => x.item_url === GROK_RADAR_261019.url && x.matched_edition === "261016"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reproduz o bug sem o filtro: o approved cru casa o D3 contra o LANÇAMENTO nunca publicado", () => {
    const { root, editionsDir } = fixture(true);
    try {
      const w = findSameFactMatches([D3_261019], pastSecondary(editionsDir, false));
      assert.equal(w.length, 1);
      assert.equal(w[0].matched_bucket, "lancamento");
      assert.deepEqual(w[0].shared_products, ["nemotron 3.5"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem 02-reviewed.md a edição entra inteira (fail-soft conservador)", () => {
    const { root, editionsDir } = fixture(false);
    try {
      assert.equal(pastSecondary(editionsDir, true).length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10463: nota do relatório nomeia o bucket do item passado", () => {
  const warning = {
    kind: "highlight",
    rank: 3,
    item_title: D3_261019.title,
    item_url: D3_261019.url,
    matched_edition: "261016",
    matched_title: NEMOTRON_261016.title,
    shared_products: ["nemotron 3.5"],
    matched_bucket: "lancamento",
    evidence: "summary",
  };
  const approved = { highlights: [{}, {}, { article: { url: D3_261019.url, title: D3_261019.title } }] };

  it("match contra LANÇAMENTO não diz 'repete o destaque' e explica por que não houve rebaixamento", () => {
    const [note] = formatHighlightSameFactNotes({ same_fact_warnings: [warning] }, approved);
    assert.ok(note, "nota emitida");
    assert.match(note, /MESMO FATO — D3 /);
    assert.doesNotMatch(note, /repete o destaque/);
    assert.match(note, /item \[lancamento\]/);
    assert.match(note, /não D1–D3/);
  });

  it("match contra destaque passado mantém 'repete o destaque'", () => {
    const [note] = formatHighlightSameFactNotes(
      { same_fact_warnings: [{ ...warning, matched_bucket: "highlight" }] },
      approved,
    );
    assert.match(note, /repete o destaque de 261016/);
  });
});
