/**
 * #14035 — fact-check incremental por unidade no gate da Etapa 4.
 *
 * O carimbo do #11671 era um hash por arquivo inteiro: qualquer ajuste em
 * `02-reviewed.md`/`03-social.md` re-despachava o fact-checker sobre os 3
 * destaques. Agora o re-run checa só as unidades (d{N}, pool) que mudaram e
 * junta com os claims das intactas. Estes testes travam o que NÃO pode
 * afrouxar: unidade alterada sempre rechecada (nenhum veredito velho dela
 * sobrevive ao merge), e o `--check-blocking` segue valendo sobre o conteúdo
 * final.
 *
 * Nunca toca rede real nem `data/` real: o plano é chamado direto
 * (`planScopeForEdition`, sem pré-download) e o merge pela CLI com
 * `--input-json`, que não baixa nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  computeUnitHashes,
  mergePartialClaims,
  partialCoverageProblems,
  partitionNewsletter,
  planFactCheckScope,
  splitNewsletterUnits,
  splitSocialUnits,
  type UnitSourceInputs,
} from "../scripts/lib/fact-check-units.ts";
import { computeContentHash } from "../scripts/lib/fact-check-staleness.ts";
import { planScopeForEdition } from "../scripts/run-fact-checker.ts";
import { hashContent } from "../scripts/lib/fact-check-staleness.ts";

const D1_URL = "https://example.com/d1";
const D2_URL = "https://example.com/d2";
const D3_URL = "https://example.com/d3";

function newsletter(o: { d1?: string; d2?: string; d3?: string; radar?: string } = {}): string {
  return [
    "TÍTULO",
    "",
    "Título da edição",
    "",
    "---",
    "Olá! Intro.",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🔬 PESQUISA**",
    "",
    `**[Título do D1](${D1_URL})**`,
    "",
    o.d1 ?? "Corpo do D1 com 58 empresas.",
    "",
    "Por que isso importa:",
    "",
    "Relevância 1.",
    "",
    "---",
    "",
    "**Box de livros entre D1 e D2.**",
    "",
    "---",
    "",
    "**DESTAQUE 2 | 🇧🇷 BRASIL**",
    "",
    `**[Título do D2](${D2_URL})**`,
    "",
    o.d2 ?? "Corpo do D2: só 7% deixariam pagar.",
    "",
    "---",
    "",
    "**DESTAQUE 3 | 🧠 CONCEITO**",
    "",
    `**[Título do D3](${D3_URL})**`,
    "",
    o.d3 ?? "Corpo do D3 com 4 níveis.",
    "",
    "---",
    "",
    "RADAR",
    "",
    o.radar ?? "**[Item do radar](https://example.com/r1)** grátis por 30 dias.",
    "",
  ].join("\n");
}

function social(o: { d1Cards?: string; curtoD2?: string; preamble?: string; um?: string } = {}): string {
  return [
    "# Social",
    "",
    o.preamble ?? "> Texto único (#3991).",
    "",
    "## d1",
    "",
    "Legenda do D1.",
    "",
    "## d1-cards",
    "",
    o.d1Cards ?? "Card do D1 com 58 empresas.",
    "",
    "## d2",
    "",
    "Legenda do D2.",
    "",
    "## d3",
    "",
    "Legenda do D3.",
    "",
    "## um",
    "",
    o.um ?? "Post do USE MELHOR.",
    "",
    "# Curto",
    "",
    "## d1",
    "",
    "Curto do D1.",
    "",
    "## d2",
    "",
    o.curtoD2 ?? "Curto do D2.",
    "",
  ].join("\n");
}

const SOURCES: UnitSourceInputs = {
  approvedUrls: [D1_URL, D2_URL, D3_URL],
  manifest: [
    { destaque: 1, url: D1_URL, status: "ok" },
    { destaque: 2, url: D2_URL, status: "ok" },
    { destaque: 3, url: D3_URL, status: "ok" },
  ],
  extras: [],
};

function changedUnits(a: ReturnType<typeof computeUnitHashes>, b: ReturnType<typeof computeUnitHashes>): string[] {
  return Object.keys(b.units).filter((k) => a.units[k] !== b.units[k]);
}

describe("#14035: partição em unidades", () => {
  it("newsletter: bloco do destaque vai até o `---`; box entre destaques e RADAR caem no pool; nenhuma linha se perde", () => {
    const md = newsletter();
    const u = splitNewsletterUnits(md);
    assert.deepEqual(Object.keys(u).sort(), ["d1", "d2", "d3", "pool"]);
    assert.match(u.d1, /58 empresas/);
    assert.doesNotMatch(u.d1, /Box de livros/);
    assert.match(u.pool, /Box de livros/);
    assert.match(u.pool, /Item do radar/);
    assert.doesNotMatch(u.d3, /RADAR/);
    const total = Object.values(u).reduce((n, s) => n + s.split("\n").length, 0);
    assert.equal(total, md.split("\n").length, "toda linha cai em exatamente uma unidade");
  });

  it("bloco do destaque fecha no header de seção conhecido mesmo sem `---` (RADAR, É IA?)", () => {
    const md = newsletter().replace("Corpo do D3 com 4 níveis.\n\n---\n", "Corpo do D3 com 4 níveis.\n");
    const p = partitionNewsletter(md);
    assert.equal(p.ambiguous, undefined);
    assert.doesNotMatch(p.units.d3, /RADAR|Item do radar/);
    assert.match(p.units.pool, /Item do radar/);
    const eia = partitionNewsletter(md.replace("RADAR", "**🛠️ USE MELHOR**").replace("**[Item", "**É IA?**\n\n**[Item"));
    assert.doesNotMatch(eia.units.d3, /USE MELHOR|É IA/);
  });

  it("partição ambígua (destaque até o fim do arquivo, header repetido) sai COMPLETO", () => {
    const eof = newsletter().replace(/\n---\n\nRADAR[\s\S]*$/, "\n");
    const pEof = partitionNewsletter(eof);
    assert.match(pEof.ambiguous ?? "", /d3 sem fim/);
    const base = computeUnitHashes(eof, social(), SOURCES);
    assert.equal(planFactCheckScope(base, base, { hasPreviousResult: true }).mode, "full");
    const dup = newsletter().replace("**DESTAQUE 3 |", "**DESTAQUE 2 |");
    assert.match(partitionNewsletter(dup).ambiguous ?? "", /repetido/);
  });

  it("social: d{N}, d{N}-cards e o d{N} do # Curto vão para d{N}; `um` para o pool; preâmbulo para global", () => {
    const s = splitSocialUnits(social());
    assert.match(s.units.d1, /Legenda do D1/);
    assert.match(s.units.d1, /Card do D1/);
    assert.match(s.units.d1, /Curto do D1/);
    assert.match(s.units.pool, /USE MELHOR/);
    assert.match(s.global, /Texto único/);
    assert.doesNotMatch(s.global, /Legenda/);
  });
});

describe("#14035: hash por unidade", () => {
  const base = computeUnitHashes(newsletter(), social(), SOURCES);

  it("ajuste no corpo do D2 marca só o d2", () => {
    const after = computeUnitHashes(newsletter({ d2: "Corpo do D2: só 9% deixariam pagar." }), social(), SOURCES);
    assert.deepEqual(changedUnits(base, after), ["d2"]);
    assert.equal(after.global, base.global);
  });

  it("ajuste no card do D1 (social) marca o d1, não só o social", () => {
    const after = computeUnitHashes(newsletter(), social({ d1Cards: "Card do D1 com 60 empresas." }), SOURCES);
    assert.deepEqual(changedUnits(base, after), ["d1"]);
  });

  it("ajuste no Curto do D2 marca o d2", () => {
    const after = computeUnitHashes(newsletter(), social({ curtoD2: "Curto novo do D2." }), SOURCES);
    assert.deepEqual(changedUnits(base, after), ["d2"]);
  });

  it("ajuste só no RADAR (ou no `## um`) marca só o pool", () => {
    assert.deepEqual(changedUnits(base, computeUnitHashes(newsletter({ radar: "grátis por 7 dias" }), social(), SOURCES)), ["pool"]);
    assert.deepEqual(changedUnits(base, computeUnitHashes(newsletter(), social({ um: "Outro post." }), SOURCES)), ["pool"]);
  });

  it("D3 sem `---` antes do RADAR: mudança no RADAR recheca o pool, não o d3", () => {
    const noSep = (radar?: string) =>
      newsletter({ radar }).replace("Corpo do D3 com 4 níveis.\n\n---\n", "Corpo do D3 com 4 níveis.\n");
    const before = computeUnitHashes(noSep(), social(), SOURCES);
    const after = computeUnitHashes(noSep("**[Item do radar](https://example.com/r1)** grátis por 7 dias."), social(), SOURCES);
    const scope = planFactCheckScope(before, after, { hasPreviousResult: true });
    assert.equal(scope.mode, "partial");
    assert.deepEqual(scope.units, ["pool"]);
  });

  it("troca de URL de um item do RADAR recheca o pool", () => {
    const after = computeUnitHashes(
      newsletter({ radar: "**[Item do radar](https://example.com/r2)** grátis por 30 dias." }),
      social(),
      SOURCES,
    );
    assert.deepEqual(changedUnits(base, after), ["pool"]);
  });

  it("fonte lida de um item do pool (pool-sources) que muda sem o texto mudar recheca o pool", () => {
    const withPool = (textHash: string | null, status = "ok"): UnitSourceInputs => ({
      ...SOURCES,
      poolSources: [{ url: "https://example.com/r1", status, textHash }],
    });
    const a = computeUnitHashes(newsletter(), social(), withPool("aaa"));
    assert.deepEqual(changedUnits(a, computeUnitHashes(newsletter(), social(), withPool("bbb"))), ["pool"]);
    assert.deepEqual(changedUnits(a, computeUnitHashes(newsletter(), social(), withPool("aaa", "error"))), ["pool"]);
    assert.deepEqual(changedUnits(base, a), ["pool"], "item que ganha fonte lida também muda o pool");
    // Fonte de URL que não aparece no pool não mexe em nada.
    const unrelated: UnitSourceInputs = {
      ...SOURCES,
      poolSources: [{ url: "https://example.com/fora-da-edicao", status: "ok", textHash: "zzz" }],
    };
    assert.deepEqual(changedUnits(base, computeUnitHashes(newsletter(), social(), unrelated)), []);
  });

  it("fonte adicional registrada para o D3 (add-destaque-source) marca o d3 sem mudar texto", () => {
    const withExtra: UnitSourceInputs = {
      ...SOURCES,
      extras: [{ destaque: 3, k: 1, url: "https://outra.com/x", status: "ok" }],
    };
    assert.deepEqual(changedUnits(base, computeUnitHashes(newsletter(), social(), withExtra)), ["d3"]);
  });

  it("fonte principal que passa de erro a ok marca o destaque; fetched_at novo não marca", () => {
    const failed: UnitSourceInputs = {
      ...SOURCES,
      manifest: SOURCES.manifest.map((e) => (e.destaque === 1 ? { ...e, status: "error" } : e)),
    };
    assert.deepEqual(changedUnits(computeUnitHashes(newsletter(), social(), failed), base), ["d1"]);
    const refetched: UnitSourceInputs = {
      ...SOURCES,
      manifest: SOURCES.manifest.map((e) => ({ ...e, fetched_at: "2026-11-26T10:00:00Z" }) as typeof e),
    };
    assert.deepEqual(changedUnits(base, computeUnitHashes(newsletter(), social(), refetched)), []);
  });

  it("texto baixado da fonte principal (d{N}.txt) ou da extra que muda sem o status mudar marca o destaque", () => {
    const withText = (d2Text: string, extraText: string): UnitSourceInputs => ({
      ...SOURCES,
      manifest: SOURCES.manifest.map((e) => (e.destaque === 2 ? { ...e, textHash: hashContent(d2Text) } : e)),
      extras: [{ destaque: 3, k: 1, url: "https://outra.com/x", status: "ok", textHash: hashContent(extraText) }],
    });
    const a = computeUnitHashes(newsletter(), social(), withText("fonte A", "extra A"));
    assert.deepEqual(changedUnits(a, computeUnitHashes(newsletter(), social(), withText("fonte B", "extra A"))), ["d2"]);
    assert.deepEqual(changedUnits(a, computeUnitHashes(newsletter(), social(), withText("fonte A", "extra B"))), ["d3"]);
    assert.deepEqual(changedUnits(a, computeUnitHashes(newsletter(), social(), withText("fonte A", "extra A"))), []);
  });

  it("preâmbulo do social muda o global (re-check completo)", () => {
    const after = computeUnitHashes(newsletter(), social({ preamble: "> outro aviso" }), SOURCES);
    assert.notEqual(after.global, base.global);
  });
});

describe("#14035: plano do re-run", () => {
  const base = computeUnitHashes(newsletter(), social(), SOURCES);

  it("sem fact-check anterior ou sem carimbo por unidade: completo", () => {
    assert.equal(planFactCheckScope(base, base, { hasPreviousResult: false }).mode, "full");
    assert.equal(planFactCheckScope(undefined, base, { hasPreviousResult: true }).mode, "full");
  });

  it("--full força completo mesmo sem mudança", () => {
    assert.equal(planFactCheckScope(base, base, { hasPreviousResult: true, forceFull: true }).mode, "full");
  });

  it("global mudou ou conjunto de destaques mudou: completo", () => {
    const g = computeUnitHashes(newsletter(), social({ preamble: "> x" }), SOURCES);
    assert.equal(planFactCheckScope(base, g, { hasPreviousResult: true }).mode, "full");
    const twoDestaques = { units: { d1: base.units.d1, d2: base.units.d2, pool: base.units.pool }, global: base.global };
    assert.equal(planFactCheckScope(twoDestaques, base, { hasPreviousResult: true }).mode, "full");
  });

  it("nada mudou: nenhum despacho; só o D2 mudou: parcial com d2", () => {
    assert.equal(planFactCheckScope(base, base, { hasPreviousResult: true }).mode, "none");
    const after = computeUnitHashes(newsletter({ d2: "Corpo novo." }), social(), SOURCES);
    const scope = planFactCheckScope(base, after, { hasPreviousResult: true });
    assert.equal(scope.mode, "partial");
    assert.deepEqual(scope.units, ["d2"]);
    assert.deepEqual(scope.reused, ["d1", "d3", "pool"]);
  });
});

describe("#14035: merge parcial", () => {
  const prev = [
    { destaque: 1 as const, text: "58 empresas", verdict: "SUSTAINED" },
    { destaque: 2 as const, text: "7%", verdict: "NOT_FOUND_IN_SOURCE" },
    { destaque: "secondary" as const, text: "30 dias", verdict: "SUSTAINED" },
  ];

  it("claim velho de unidade rechecada nunca sobrevive; fora do escopo vem do anterior", () => {
    const partial = [
      { destaque: 2 as const, text: "9%", verdict: "SUSTAINED" },
      { destaque: 1 as const, text: "58 empresas", verdict: "DIVERGENT" },
    ];
    const { claims, outOfScope } = mergePartialClaims(prev, partial, ["d2"]);
    assert.deepEqual(
      claims.map((c) => `${c.destaque}:${c.text}:${c.verdict}`),
      ["1:58 empresas:SUSTAINED", "2:9%:SUSTAINED", "secondary:30 dias:SUSTAINED"],
    );
    assert.equal(outOfScope.length, 1, "claim do D1 no parcial (fora do escopo) é descartado");
  });

  it("unidade rechecada sem claim no parcial fica sem claim (o veredito velho não volta)", () => {
    const { claims } = mergePartialClaims(prev, [], ["d2", "pool"]);
    assert.deepEqual(claims.map((c) => c.destaque), [1]);
  });
});

describe("#14035: cobertura do parcial antes do merge", () => {
  const h = (destaque: number | "secondary") => ({ destaque, claim_type: "headline" });
  const n = (destaque: number | "secondary") => ({ destaque, claim_type: "number" });

  it("parcial que ecoa o plano e tem o headline de cada d{N}: ok (pool sem claim é ok)", () => {
    assert.deepEqual(partialCoverageProblems(["d2", "pool"], ["pool", "d2"], [h(2), n(2)]), []);
    assert.deepEqual(partialCoverageProblems(["pool"], ["pool"], []), []);
  });

  it("sem `units` ecoado ou com lista diferente do plano: recusa", () => {
    assert.match(partialCoverageProblems(["d2"], undefined, [h(2)]).join(";"), /sem `units` ecoado/);
    assert.match(partialCoverageProblems(["d2"], ["d1"], [h(2)]).join(";"), /não bate com o plano/);
    assert.match(partialCoverageProblems(["d2"], "d2", [h(2)]).join(";"), /sem `units` ecoado/);
  });

  it("d{N} do plano sem claim headline (saída truncada, dispatch com lista velha): recusa", () => {
    assert.match(partialCoverageProblems(["d2"], ["d2"], []).join(";"), /headline.*d2/);
    assert.match(partialCoverageProblems(["d1", "d2"], ["d1", "d2"], [h(1), n(2)]).join(";"), /headline.*em d2$/);
  });

  it("claim fora do escopo: recusa em vez de descartar com log", () => {
    assert.match(partialCoverageProblems(["d2"], ["d2"], [h(2), n(1)]).join(";"), /1 claim\(s\) fora do escopo \(d1\)/);
  });
});

// ---------------------------------------------------------------------------
// Ponta a ponta: plano → parcial → merge pela CLI
// ---------------------------------------------------------------------------

function setupEdition(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fc-14035-")), "261126");
  mkdirSync(join(dir, "_internal", "fact-check-sources"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), newsletter(), "utf8");
  writeFileSync(join(dir, "03-social.md"), social(), "utf8");
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [{ url: D1_URL }, { url: D2_URL }, { url: D3_URL }] }),
    "utf8",
  );
  return dir;
}

function cleanup(dir: string) {
  rmSync(dirname(dir), { recursive: true, force: true });
}

function runCli(editionDir: string, extra: string[]) {
  const root = join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts", "run-fact-checker.ts"), "--edition-dir", editionDir, ...extra],
    { cwd: root, encoding: "utf8" },
  );
}

const claim = (destaque: number | "secondary", text: string, verdict: string, context: string) => ({
  destaque,
  claim_type: "number",
  text,
  context,
  sources: ["newsletter"],
  verdict,
});

/** Simula o 1º fact-check completo (agente grava, `--input-json` carimba). */
function firstFullCheck(dir: string) {
  const fcPath = join(dir, "_internal", "fact-check.json");
  writeFileSync(
    fcPath,
    JSON.stringify({
      edition: "261126",
      checked_at: "2026-11-26T10:00:00Z",
      claims: [
        claim(1, "58 empresas", "SUSTAINED", "Corpo do D1 com 58 empresas."),
        claim(2, "7%", "SUSTAINED", "só 7% deixariam pagar"),
        claim(3, "4 níveis", "SUSTAINED", "Corpo do D3 com 4 níveis."),
      ],
    }),
    "utf8",
  );
  const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
  assert.equal(r.status, 0, r.stderr);
  return fcPath;
}

const headline = (destaque: number, text: string) => ({ ...claim(destaque, text, "SUSTAINED", text), claim_type: "headline" });

/** Parcial como o agente grava: `units` ecoado (omitido com `units: null`). */
function writePartial(dir: string, claims: unknown[], units: string[] | null = ["d2"]): string {
  const p = join(dir, "_internal", "fact-check.partial.json");
  writeFileSync(
    p,
    JSON.stringify({ edition: "261126", checked_at: "2026-11-26T11:00:00Z", ...(units ? { units } : {}), claims }),
    "utf8",
  );
  // mtime estritamente depois do plano (o merge recusa parcial anterior ao plano).
  const later = new Date(Date.now() + 2000);
  utimesSync(p, later, later);
  return p;
}

describe("#14035: ponta a ponta pela CLI", () => {
  it("1º fact-check completo carimba por unidade; texto igual → plano NENHUMA", () => {
    const dir = setupEdition();
    try {
      const fcPath = firstFullCheck(dir);
      const fc = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.deepEqual(Object.keys(fc.unit_hashes.units).sort(), ["d1", "d2", "d3", "pool"]);
      assert.equal(planScopeForEdition(dir).mode, "none");
    } finally {
      cleanup(dir);
    }
  });

  it("ajuste no D2: plano PARCIAL d2; merge troca só os claims do D2 e o carimbo volta a bater", () => {
    const dir = setupEdition();
    try {
      const fcPath = firstFullCheck(dir);
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ d2: "Corpo do D2: só 9% deixariam pagar." }), "utf8");
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "partial");
      assert.deepEqual(scope.units, ["d2"]);

      const partial = writePartial(dir, [headline(2, "Título do D2"), claim(2, "9%", "SUSTAINED", "só 9% deixariam pagar")]);
      const r = runCli(dir, ["--input-json", partial, "--merge-partial", "--check-blocking"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /rechecado d2; reaproveitado d1, d3, pool/);
      assert.doesNotMatch(r.stdout, /DEFASADO/);

      const fc = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.deepEqual(
        fc.claims.map((c: { destaque: number; text: string }) => `${c.destaque}:${c.text}`),
        ["1:58 empresas", "2:Título do D2", "2:9%", "3:4 níveis"],
      );
      assert.deepEqual(fc.incremental.units, ["d2"]);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const so = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.deepEqual(fc.content_hash, computeContentHash(md, so));
      assert.equal(planScopeForEdition(dir).mode, "none", "depois do merge, nada a rechecar");
    } finally {
      cleanup(dir);
    }
  });

  it("texto lido de um item do RADAR (pool-sources em disco) muda: plano PARCIAL pool", () => {
    const dir = setupEdition();
    try {
      const poolDir = join(dir, "_internal", "pool-sources");
      mkdirSync(poolDir, { recursive: true });
      writeFileSync(
        join(poolDir, "manifest.json"),
        JSON.stringify([{ url: "https://example.com/r1", bucket: "radar", title: "Item", file: "r1.txt", status: "ok", erro: null, bytes: 10, fetched_at: "x" }]),
        "utf8",
      );
      writeFileSync(join(poolDir, "r1.txt"), "Grátis por 30 dias.", "utf8");
      firstFullCheck(dir);
      assert.equal(planScopeForEdition(dir).mode, "none");
      writeFileSync(join(poolDir, "r1.txt"), "Grátis por 7 dias.", "utf8");
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "partial");
      assert.deepEqual(scope.units, ["pool"]);
    } finally {
      cleanup(dir);
    }
  });

  it("--check-blocking segue valendo sobre o merge: NOT_FOUND na unidade rechecada sai exit 2", () => {
    const dir = setupEdition();
    try {
      firstFullCheck(dir);
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ d2: "Corpo do D2: só 9% deixariam pagar." }), "utf8");
      planScopeForEdition(dir);
      const partial = writePartial(dir, [
        headline(2, "Título do D2"),
        claim(2, "9%", "NOT_FOUND_IN_SOURCE", "só 9% deixariam pagar"),
      ]);
      const r = runCli(dir, ["--input-json", partial, "--merge-partial", "--check-blocking"]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /GATE-BLOCKING/);
    } finally {
      cleanup(dir);
    }
  });

  it("texto muda DEPOIS do plano: merge carimba com o plano e o resultado sai DEFASADO", () => {
    const dir = setupEdition();
    try {
      firstFullCheck(dir);
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ d2: "Corpo do D2: só 9% deixariam pagar." }), "utf8");
      planScopeForEdition(dir);
      // Editor mexe no D1 entre o plano e o merge.
      writeFileSync(
        join(dir, "02-reviewed.md"),
        newsletter({ d1: "Corpo do D1 com 60 empresas.", d2: "Corpo do D2: só 9% deixariam pagar." }),
        "utf8",
      );
      const partial = writePartial(dir, [headline(2, "Título do D2"), claim(2, "9%", "SUSTAINED", "só 9% deixariam pagar")]);
      const r = runCli(dir, ["--input-json", partial, "--merge-partial", "--check-blocking"]);
      assert.match(r.stdout, /DEFASADO/);
      const next = planScopeForEdition(dir);
      assert.equal(next.mode, "partial");
      assert.deepEqual(next.units, ["d1"], "o D1 mexido depois do plano entra no próximo re-run");
    } finally {
      cleanup(dir);
    }
  });

  it("merge sem plano parcial é recusado (exit 1), nunca reaproveita às cegas", () => {
    const dir = setupEdition();
    try {
      firstFullCheck(dir);
      planScopeForEdition(dir); // plano NENHUMA
      const partial = writePartial(dir, [claim(2, "7%", "SUSTAINED", "só 7%")]);
      const r = runCli(dir, ["--input-json", partial, "--merge-partial"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /merge-partial recusado/);
    } finally {
      cleanup(dir);
    }
  });

  it("fact-check.json anterior ao #14035 (só content_hash) não ganha carimbo por unidade: re-run sai completo", () => {
    const dir = setupEdition();
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(
        fcPath,
        JSON.stringify({
          edition: "261126",
          claims: [claim(1, "58 empresas", "SUSTAINED", "Corpo do D1 com 58 empresas.")],
          content_hash: computeContentHash("texto antigo", "social antigo"),
        }),
        "utf8",
      );
      runCli(dir, ["--input-json", fcPath]);
      assert.equal(JSON.parse(readFileSync(fcPath, "utf8")).unit_hashes, undefined);
      assert.equal(planScopeForEdition(dir).mode, "full");
    } finally {
      cleanup(dir);
    }
  });

  it("parcial que não cobre o plano (lista velha, sem eco, claim fora do escopo) é recusado e o fact-check.json fica intacto", () => {
    const dir = setupEdition();
    try {
      const fcPath = firstFullCheck(dir);
      const before = readFileSync(fcPath, "utf8");
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ d2: "Corpo do D2: só 9% deixariam pagar." }), "utf8");
      assert.deepEqual(planScopeForEdition(dir).units, ["d2"]);
      const cases: Array<[unknown[], string[] | null, RegExp]> = [
        // Dispatch com a lista velha: checou d1, nada de d2.
        [[headline(1, "Título do D1"), claim(1, "58 empresas", "SUSTAINED", "x")], ["d1"], /não bate com o plano/],
        // Saída truncada: ecoou d2, mas sem o headline do D2.
        [[claim(2, "9%", "SUSTAINED", "só 9%")], ["d2"], /headline/],
        // Sem eco de `units`.
        [[headline(2, "Título do D2")], null, /sem `units` ecoado/],
        // Claim fora do escopo.
        [[headline(2, "Título do D2"), claim(1, "58 empresas", "DIVERGENT", "x")], ["d2"], /fora do escopo/],
      ];
      for (const [claims, units, re] of cases) {
        const partial = writePartial(dir, claims, units);
        const r = runCli(dir, ["--input-json", partial, "--merge-partial", "--check-blocking"]);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, re);
        assert.match(r.stderr, /--full/);
        assert.equal(readFileSync(fcPath, "utf8"), before, "o claim velho do D2 e o carimbo seguem como estavam");
      }
    } finally {
      cleanup(dir);
    }
  });

  it("COMPLETO carimba com os hashes do plano: edição durante a rodada do agente sai DEFASADA", () => {
    const dir = setupEdition();
    try {
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "full");
      // Editor mexe no D1 pelo Studio enquanto o agente roda.
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ d1: "Corpo do D1 com 60 empresas." }), "utf8");
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(
        fcPath,
        JSON.stringify({ edition: "261126", claims: [claim(1, "58 empresas", "SUSTAINED", "Corpo do D1 com 58 empresas.")] }),
        "utf8",
      );
      const later = new Date(Date.now() + 2000);
      utimesSync(fcPath, later, later);
      const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.match(r.stdout, /DEFASADO/);
      const fc = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.deepEqual(fc.content_hash, scope.content_hash);
      assert.deepEqual(fc.unit_hashes, scope.unit_hashes);
      const next = planScopeForEdition(dir);
      assert.equal(next.mode, "partial");
      assert.deepEqual(next.units, ["d1"], "o D1 mexido durante a rodada entra no próximo re-run");
    } finally {
      cleanup(dir);
    }
  });

  it("texto baixado da fonte do D2 (d2.txt em disco) muda sem o manifest mudar: plano PARCIAL d2", () => {
    const dir = setupEdition();
    try {
      const sourcesDir = join(dir, "_internal", "fact-check-sources");
      writeFileSync(
        join(sourcesDir, "manifest.json"),
        JSON.stringify(
          [1, 2, 3].map((d) => ({ destaque: d, url: `https://example.com/d${d}`, status: "ok", erro: null, bytes: 10, fetched_at: "x" })),
        ),
        "utf8",
      );
      for (const d of [1, 2, 3]) writeFileSync(join(sourcesDir, `d${d}.txt`), `Fonte do D${d}.`, "utf8");
      firstFullCheck(dir);
      assert.equal(planScopeForEdition(dir).mode, "none");
      writeFileSync(join(sourcesDir, "d2.txt"), "Fonte do D2, versão nova.", "utf8");
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "partial");
      assert.deepEqual(scope.units, ["d2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("autofix de DIVERGENT recarimba também por unidade (a correção vem do próprio fact-check)", () => {
    const dir = setupEdition();
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(
        fcPath,
        JSON.stringify({
          edition: "261126",
          checked_at: "2026-11-26T10:00:00Z",
          claims: [{ ...claim(1, "58 empresas", "DIVERGENT", "Corpo do D1 com 58 empresas."), suggested_fix: "60 empresas" }],
        }),
        "utf8",
      );
      assert.equal(runCli(dir, ["--input-json", fcPath]).status, 0);
      const root = join(import.meta.dirname, "..");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(root, "scripts", "apply-factcheck-autofix.ts"), "--edition-dir", dir],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(join(dir, "02-reviewed.md"), "utf8"), /60 empresas/);
      assert.equal(planScopeForEdition(dir).mode, "none", "autofix não força re-run do D1");
    } finally {
      cleanup(dir);
    }
  });
});
