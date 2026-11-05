/**
 * Regressões do gate de fact-check (#11701, #11685, #11703).
 *
 * - #11701: `context` truncado com `...` nunca casava com o MD, e um claim
 *   intacto (com `text` parafraseado) saía do bloqueio como "sumido".
 * - #11685 item 1: claim REESCRITO (número trocado, sem re-despachar o agente)
 *   caía em "sumido" e o `--check-blocking` saía 0.
 * - #11685 item 3: bloco DESTAQUE sem URL (placeholder do swap-destaques)
 *   deslocava os índices do `findDestaqueUrlDrift`.
 * - (#11685 item 4, registro do 1:1 derivado no reorder, saiu no #12226 junto
 *   com o 1:1 e o `square-source-marker.ts`.)
 * - #11703: Studio com leitura do MD falha zerava os claims bloqueantes.
 *
 * Nunca toca rede nem `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  claimStillPresent,
  computeContentHash,
  factCheckStaleness,
  partitionBlockingByContent,
} from "../scripts/lib/fact-check-staleness.ts";
import { findDestaqueUrlDrift } from "../scripts/run-fact-checker.ts";
import { extractDestaqueUrls, extractDestaqueUrlsByNumber } from "../scripts/match-prompts-to-destaques.ts";
import { buildGateSummary } from "../scripts/studio-ui/studio-gate.ts";

const SENTENCE = "A rodada captou R$ 500 milhões e inclui 2 fundos novos.";

function reviewedMd(body: string): string {
  return [
    "Intro.",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[Título do D1](https://example.com/d1)**",
    "",
    `Corpo do D1. ${body} Por que isso importa: relevância.`,
    "",
  ].join("\n");
}

function blockingFc(claim: { text: string; context: string }) {
  return {
    edition: "261031",
    checked_at: "2026-10-31T12:00:00Z",
    claims: [{ destaque: 1, claim_type: "number", ...claim, sources: ["newsletter"], verdict: "NOT_FOUND_IN_SOURCE" }],
    summary: { total: 1, sustained: 0, divergent: 0, not_found_in_source: 1, source_unreachable: 0, inferred: 0, attention_items: 1 },
  };
}

function setupEdition(md: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fc-gate-11701-")), "261031");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
  writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto social.\n", "utf8");
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [{ rank: 1, url: "https://example.com/d1" }], radar: [] }),
    "utf8",
  );
  return dir;
}

function runCheckBlocking(editionDir: string, fcPath: string) {
  const root = join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts", "run-fact-checker.ts"), "--edition-dir", editionDir, "--input-json", fcPath, "--check-blocking"],
    { cwd: root, encoding: "utf8" },
  );
}

const stale = factCheckStaleness(computeContentHash("x", "s"), computeContentHash("y", "s"));

describe("#11701 — context truncado com reticências", () => {
  it("cenário da issue: paráfrase em text + context com '...' + frase intacta segue bloqueando", () => {
    const claim = { text: "500 milhões de reais", context: "A rodada captou R$ 500 milhões e inclui..." };
    const r = partitionBlockingByContent([claim], stale, [SENTENCE]);
    assert.deepEqual(r.blocking, [claim]);
    assert.deepEqual(r.vanished, []);
  });

  it("reticência no início, no meio e o caractere '…'", () => {
    assert.equal(claimStillPresent("...captou R$ 500 milhões e inclui", [SENTENCE]), true);
    assert.equal(claimStillPresent("A rodada captou … 2 fundos novos.", [SENTENCE]), true);
    assert.equal(claimStillPresent("A rodada ... R$ 500 milhões ... fundos novos", [SENTENCE]), true);
    // Segmentos fora de ordem ou um deles ausente: não casa.
    assert.equal(claimStillPresent("2 fundos novos ... A rodada captou", [SENTENCE]), false);
    assert.equal(claimStillPresent("A rodada captou ... R$ 400 milhões", [SENTENCE]), false);
    // Só reticências conta como trecho vazio (conservador: presente).
    assert.equal(claimStillPresent("...", ["qualquer"]), true);
    // Segmentos precisam estar no MESMO texto.
    assert.equal(claimStillPresent("A rodada captou ... Texto social", [SENTENCE, "Texto social"]), false);
  });

  it("via CLI: outro trecho muda, claim com context truncado continua → exit 2", () => {
    const dir = setupEdition(reviewedMd(SENTENCE));
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(fcPath, JSON.stringify(blockingFc({ text: "500 milhões de reais", context: "A rodada captou R$ 500 milhões e inclui..." })));
      assert.equal(runCheckBlocking(dir, fcPath).status, 2);
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nOutro texto.\n", "utf8");
      const r = runCheckBlocking(dir, fcPath);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /GATE-BLOCKING/);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("#11685 item 1 — claim reescrito sem re-despachar o fact-checker", () => {
  it("trocar o número sai com exit 1 (indisponível), nunca 0", () => {
    const dir = setupEdition(reviewedMd(SENTENCE));
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(fcPath, JSON.stringify(blockingFc({ text: "R$ 500 milhões", context: SENTENCE })));
      assert.equal(runCheckBlocking(dir, fcPath).status, 2);
      // Orchestrator reescreve o número e roda só o --check-blocking de novo.
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd(SENTENCE.replace("500", "450")), "utf8");
      const r = runCheckBlocking(dir, fcPath);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /FACT-CHECK DEFASADO \(#11685\)/);
      assert.match(r.stderr, /Re-despachar o fact-checker/);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("fact-check fresco (re-despachado, sem carimbo antigo) com o texto novo sai 0", () => {
    const dir = setupEdition(reviewedMd(SENTENCE.replace("500", "450")));
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      const fresh = { ...blockingFc({ text: "R$ 450 milhões", context: "x" }), claims: [] };
      writeFileSync(fcPath, JSON.stringify(fresh));
      assert.equal(runCheckBlocking(dir, fcPath).status, 0);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("#11685 item 3 — findDestaqueUrlDrift por número do bloco", () => {
  const md = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[D1](https://example.com/d1)**",
    "",
    "Corpo.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | [RASCUNHO PENDENTE — swap-destaque]**",
    "",
    "Texto provisório sem link.",
    "",
    "---",
    "",
    "**DESTAQUE 3 | 📡 RADAR**",
    "",
    "**[D3](https://example.com/d3)**",
    "",
    "Corpo.",
    "",
  ].join("\n");

  it("placeholder sem URL não desloca o D3 para o índice do D2", () => {
    assert.deepEqual(extractDestaqueUrlsByNumber(md), ["https://example.com/d1", undefined, "https://example.com/d3"]);
    // O extrator antigo (compactado) segue como era para os outros consumidores.
    assert.deepEqual(extractDestaqueUrls(md), ["https://example.com/d1", "https://example.com/d3"]);
    const approved = {
      highlights: [{ url: "https://example.com/d1" }, { url: "https://example.com/d2-novo" }, { url: "https://example.com/d3" }],
    };
    assert.deepEqual(findDestaqueUrlDrift(md, approved), []);
  });

  it("drift real no D3 continua apontado como D3", () => {
    const approved = {
      highlights: [{ url: "https://example.com/d1" }, { url: "https://example.com/d2" }, { url: "https://example.com/d3-antigo" }],
    };
    assert.deepEqual(findDestaqueUrlDrift(md, approved), [
      { destaque: 3, reviewed_url: "https://example.com/d3", approved_url: "https://example.com/d3-antigo" },
    ]);
  });
});

describe("#11703 — Studio com leitura do MD falha", () => {
  function setupGate(): { root: string; ed: string } {
    const root = mkdtempSync(join(tmpdir(), "fc-11703-"));
    const ed = join(root, "data", "editions", "261031");
    mkdirSync(join(ed, "_internal"), { recursive: true });
    const md = reviewedMd(SENTENCE);
    const social = "# Social\n";
    writeFileSync(join(ed, "02-reviewed.md"), md, "utf8");
    writeFileSync(join(ed, "03-social.md"), social, "utf8");
    writeFileSync(
      join(ed, "_internal", "fact-check.json"),
      JSON.stringify({ ...blockingFc({ text: "R$ 500 milhões", context: SENTENCE }), content_hash: computeContentHash(md, social) }),
      "utf8",
    );
    return { root, ed };
  }

  it("controle: leitura ok, carimbo em dia → 1 bloqueante", () => {
    const { root } = setupGate();
    try {
      const s = buildGateSummary(root, "261031");
      assert.equal(s.factCheck.available, true);
      if (s.factCheck.available) assert.equal(s.factCheck.blockingCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md ilegível (EISDIR) → item indisponível e não-ok, nunca 0 bloqueantes", () => {
    const { root, ed } = setupGate();
    try {
      rmSync(join(ed, "02-reviewed.md"));
      mkdirSync(join(ed, "02-reviewed.md")); // readFileSync lança EISDIR
      const s = buildGateSummary(root, "261031");
      assert.equal(s.factCheck.available, false);
      if (!s.factCheck.available) assert.match(s.factCheck.note, /02-reviewed\.md: EISDIR/);
      const item = s.checklist.find((c) => c.id === "fact-check")!;
      assert.equal(item.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("03-social.md ausente com carimbo → item indisponível (não 'sumiu')", () => {
    const { root, ed } = setupGate();
    try {
      rmSync(join(ed, "03-social.md"));
      const s = buildGateSummary(root, "261031");
      assert.equal(s.factCheck.available, false);
      assert.equal(s.checklist.find((c) => c.id === "fact-check")!.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md vazio com carimbo → item indisponível", () => {
    const { root, ed } = setupGate();
    try {
      writeFileSync(join(ed, "02-reviewed.md"), "", "utf8");
      const s = buildGateSummary(root, "261031");
      assert.equal(s.factCheck.available, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
