/**
 * Regressão #11671 (edição 261030, Stage 4).
 *
 * 1. Trocar o link de um destaque no gate deixava `fact-check-sources/`
 *    (manifest + d{N}.txt) com o texto da URL antiga. `swap-destaque-link.ts`
 *    agora re-baixa a fonte; troca feita à mão em `02-reviewed.md` é acusada
 *    por `findDestaqueUrlDrift` no pré-download do `run-fact-checker.ts`.
 * 2. `fact-check.json` não era invalidado quando o texto mudava: depois de o
 *    editor remover a frase, `--check-blocking` seguia bloqueando por ela.
 *    Agora o resultado leva o carimbo `content_hash`; defasado = aviso, e só
 *    bloqueia o claim cujo trecho ainda aparece no texto atual.
 *
 * Nunca toca rede real nem `data/` real: fetch e verify são injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runSwapLink } from "../scripts/swap-destaque-link.ts";
import { refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import { findDestaqueUrlDrift } from "../scripts/run-fact-checker.ts";
import {
  claimStillPresent,
  computeContentHash,
  factCheckStaleness,
  partitionBlockingByContent,
} from "../scripts/lib/fact-check-staleness.ts";
import { buildGateSummary } from "../scripts/studio-ui/studio-gate.ts";

const OLD_URL = "https://g1.globo.com/tecnologia/noticia-antiga";
const NEW_URL = "https://thenextweb.com/news/artigo-novo";
const D2_URL = "https://example.com/d2";

const REMOVED_SENTENCE = "A empresa investiu R$ 500 milhões no projeto.";

function reviewedMd(d1Url: string, withSentence = true): string {
  return [
    "Intro.",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    `**[Título do D1](${d1Url})**`,
    "",
    `Corpo do D1.${withSentence ? ` ${REMOVED_SENTENCE}` : ""} Por que isso importa: relevância.`,
    "",
    "---",
    "",
    "**DESTAQUE 2 | 📡 RADAR**",
    "",
    `**[Título do D2](${D2_URL})**`,
    "",
    "Corpo do D2. Por que isso importa: relevância 2.",
    "",
  ].join("\n");
}

function setupEdition(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fc-11671-")), "261030");
  mkdirSync(join(dir, "_internal", "fact-check-sources"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewedMd(OLD_URL), "utf8");
  writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto social do D1.\n", "utf8");
  const approved = {
    highlights: [
      { rank: 1, url: OLD_URL, title_options: ["Título do D1"] },
      { rank: 2, url: D2_URL, title_options: ["Título do D2"] },
    ],
    radar: [],
  };
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved, null, 2), "utf8");
  return dir;
}

function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    return new Response(`<p>TEXTO DE ${u}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

const okVerify = (async () => ({ verdict: "accessible" })) as unknown as Parameters<typeof runSwapLink>[1];

const cleanup = (dir: string) => rmSync(join(dir, ".."), { recursive: true, force: true });

describe("#11671 item 1 — swap-destaque-link re-baixa a fonte do fact-check", () => {
  it("depois da troca, manifest e d1.txt apontam para a URL nova (não para o g1)", async () => {
    const dir = setupEdition();
    try {
      // Estado anterior à troca: fontes baixadas para a URL antiga.
      await refreshDestaqueSources(dir, { fetchImpl: fakeFetch([]) });
      assert.match(readFileSync(join(dir, "_internal", "fact-check-sources", "d1.txt"), "utf8"), /noticia-antiga/);

      const calls: string[] = [];
      const result = await runSwapLink(
        { edition: "261030", editionDir: dir, destaque: "d1", url: NEW_URL, dryRun: false },
        okVerify,
        (d) => refreshDestaqueSources(d, { fetchImpl: fakeFetch(calls) }),
      );

      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      assert.equal(approved.highlights[0].url, NEW_URL);
      const manifest = JSON.parse(
        readFileSync(join(dir, "_internal", "fact-check-sources", "manifest.json"), "utf8"),
      ) as Array<{ destaque: number; url: string }>;
      assert.equal(manifest.find((m) => m.destaque === 1)?.url, NEW_URL);
      const d1 = readFileSync(join(dir, "_internal", "fact-check-sources", "d1.txt"), "utf8");
      assert.match(d1, /artigo-novo/);
      assert.doesNotMatch(d1, /noticia-antiga/);
      assert.ok(calls.includes(NEW_URL));
      assert.ok(result.fact_check_sources && !("error" in result.fact_check_sources));
      if (result.fact_check_sources && !("error" in result.fact_check_sources)) {
        assert.equal(result.fact_check_sources.refetched, true);
        assert.match(result.fact_check_sources.source_path ?? "", /d1\.txt$/);
      }
    } finally {
      cleanup(dir);
    }
  });

  it("falha no refresh não desfaz a troca — vira fact_check_sources.error", async () => {
    const dir = setupEdition();
    try {
      const result = await runSwapLink(
        { edition: "261030", editionDir: dir, destaque: "d1", url: NEW_URL, dryRun: false },
        okVerify,
        async () => {
          throw new Error("rede fora");
        },
      );
      assert.deepEqual(result.fact_check_sources, { error: "rede fora" });
      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      assert.equal(approved.highlights[0].url, NEW_URL);
    } finally {
      cleanup(dir);
    }
  });

  it("findDestaqueUrlDrift acusa link trocado à mão em 02-reviewed.md", () => {
    const approved = { highlights: [{ url: OLD_URL }, { url: D2_URL }] };
    assert.deepEqual(findDestaqueUrlDrift(reviewedMd(OLD_URL), approved), []);
    assert.deepEqual(findDestaqueUrlDrift(reviewedMd(NEW_URL), approved), [
      { destaque: 1, reviewed_url: NEW_URL, approved_url: OLD_URL },
    ]);
  });

  it("run-fact-checker (pré-condições) imprime o aviso de drift com o comando de correção", async () => {
    const dir = setupEdition();
    try {
      // Fontes já baixadas para a URL do approved: o pré-download reusa o cache, sem rede.
      await refreshDestaqueSources(dir, { fetchImpl: fakeFetch([]) });
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd(NEW_URL), "utf8");
      const r = runCli(dir, []);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Link de destaque trocado à mão \(#11671\)/);
      assert.match(r.stdout, /swap-destaque-link\.ts --edition 261030 .*--destaque d1 --url https:\/\/thenextweb\.com/);
    } finally {
      cleanup(dir);
    }
  });
});

function runCli(editionDir: string, extra: string[]) {
  const root = join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts", "run-fact-checker.ts"), "--edition-dir", editionDir, ...extra],
    { cwd: root, encoding: "utf8" },
  );
}

const BLOCKING_FC = {
  edition: "261030",
  checked_at: "2026-10-30T12:00:00Z",
  claims: [
    {
      destaque: 1,
      claim_type: "number",
      text: "R$ 500 milhões",
      context: REMOVED_SENTENCE,
      sources: ["newsletter"],
      verdict: "NOT_FOUND_IN_SOURCE",
    },
  ],
};

describe("#11671 item 2 — fact-check.json carimbado com o hash do conteúdo", () => {
  it("frase removida depois da checagem: --check-blocking deixa de bloquear e avisa defasagem", () => {
    const dir = setupEdition();
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(fcPath, JSON.stringify(BLOCKING_FC), "utf8");

      const first = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.equal(first.status, 2, first.stderr);
      const stamped = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.equal(typeof stamped.content_hash?.newsletter, "string");

      // Editor remove a frase no gate; o fact-check.json NÃO é refeito.
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd(OLD_URL, false), "utf8");
      const second = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Fact-check DEFASADO \(#11671\)/);
      assert.match(second.stderr, /trecho removido/);
      // Carimbo preservado (não recarimba com o texto novo).
      assert.deepEqual(JSON.parse(readFileSync(fcPath, "utf8")).content_hash, stamped.content_hash);
    } finally {
      cleanup(dir);
    }
  });

  it("texto mudou em outro ponto mas o claim continua lá: segue bloqueando", () => {
    const dir = setupEdition();
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      writeFileSync(fcPath, JSON.stringify(BLOCKING_FC), "utf8");
      assert.equal(runCli(dir, ["--input-json", fcPath, "--check-blocking"]).status, 2);
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nOutro texto social.\n", "utf8");
      const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stdout, /Fact-check DEFASADO/);
    } finally {
      cleanup(dir);
    }
  });

  it("Studio gate usa o mesmo critério (frase removida → 0 bloqueantes, stale=true)", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-11671-gate-"));
    try {
      const ed = join(root, "data", "editions", "261030");
      mkdirSync(join(ed, "_internal"), { recursive: true });
      const md = reviewedMd(OLD_URL);
      const social = "# Social\n";
      writeFileSync(join(ed, "02-reviewed.md"), reviewedMd(OLD_URL, false), "utf8");
      writeFileSync(join(ed, "03-social.md"), social, "utf8");
      writeFileSync(
        join(ed, "_internal", "fact-check.json"),
        JSON.stringify({
          ...BLOCKING_FC,
          summary: { total: 1, sustained: 0, divergent: 0, not_found_in_source: 1, source_unreachable: 0, inferred: 0, attention_items: 1 },
          content_hash: computeContentHash(md, social),
        }),
        "utf8",
      );
      const summary = buildGateSummary(root, "261030");
      assert.equal(summary.factCheck.available, true);
      if (summary.factCheck.available) {
        assert.equal(summary.factCheck.blockingCount, 0);
        assert.equal(summary.factCheck.stale, true);
      }
      const item = summary.checklist.find((c) => c.id === "fact-check")!;
      assert.match(item.detail, /defasado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("autofix recarimba o fact-check em dia (a correção vem dele mesmo, não deixa o gate defasado)", () => {
    const dir = setupEdition();
    try {
      const fcPath = join(dir, "_internal", "fact-check.json");
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const social = readFileSync(join(dir, "03-social.md"), "utf8");
      writeFileSync(
        fcPath,
        JSON.stringify({
          ...BLOCKING_FC,
          claims: [{ ...BLOCKING_FC.claims[0], verdict: "DIVERGENT", suggested_fix: "R$ 400 milhões" }],
          content_hash: computeContentHash(md, social),
        }),
        "utf8",
      );
      const root = join(import.meta.dirname, "..");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(root, "scripts", "apply-factcheck-autofix.ts"), "--edition-dir", dir],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const mdAfter = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(mdAfter, /R\$ 400 milhões/);
      const fc = JSON.parse(readFileSync(fcPath, "utf8"));
      assert.deepEqual(fc.content_hash, computeContentHash(mdAfter, social));
    } finally {
      cleanup(dir);
    }
  });

  it("helpers puros: sem carimbo nunca é defasado; normalização de markdown no match", () => {
    const cur = computeContentHash("a", "b");
    assert.equal(factCheckStaleness(undefined, cur).stale, false);
    assert.deepEqual(factCheckStaleness(computeContentHash("a\r\n", "b"), computeContentHash("a\n", "b")).changed, []);
    assert.deepEqual(factCheckStaleness(computeContentHash("x", "b"), cur).changed, ["02-reviewed.md"]);
    assert.equal(claimStillPresent("R$ 500 milhões", ["investiu **R$  500 milhões** no"]), true);
    assert.equal(claimStillPresent("R$ 500 milhões", ["investiu R$ 400 milhões"]), false);
    assert.equal(claimStillPresent("", ["qualquer"]), true);
    const stale = factCheckStaleness(computeContentHash("x", "b"), cur);
    const part = partitionBlockingByContent([{ text: "foo" }, { text: "bar" }], stale, ["tem foo aqui"]);
    assert.deepEqual(part.blocking.map((c) => c.text), ["foo"]);
    assert.deepEqual(part.vanished.map((c) => c.text), ["bar"]);
    const fresh = partitionBlockingByContent([{ text: "bar" }], factCheckStaleness(cur, cur), ["nada"]);
    assert.deepEqual(fresh.blocking.map((c) => c.text), ["bar"], "sem defasagem, tudo segue bloqueando");
  });
});
