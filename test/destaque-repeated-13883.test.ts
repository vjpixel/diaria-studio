/**
 * test/destaque-repeated-13883.test.ts (#13883)
 *
 * Caso real 261124: o D2 "Gemini agora clica e digita sozinho no seu Mac"
 * (blog.google, computer-use-mac) era o mesmo link do RADAR de 261123. O
 * upgrade do #12193 o liberou (`dedup_destaque_only`), o scorer deu 97, o
 * scorer-select o escolheu como D2 e nada apareceu no gate 4: o invariante
 * `no-duplicate-urls-vs-past-editions` isentava o upgrade em silêncio, o
 * gate 1 não mostrava o marcador e o writer-destaque não sabia da repetição.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachDestaqueOnlyOrigins,
  findApprovedSectionOf,
  findRepeatedDestaques,
  formatPastPublications,
  readDestaqueOnlyOrigin,
  DESTAQUE_ONLY_FIELD,
  DESTAQUE_ONLY_ORIGIN_FIELD,
  UNKNOWN_SECTION,
} from "../scripts/lib/destaque-upgrade.ts";
import { extractPastPublicationsWithinDays } from "../scripts/lib/past-editions-extract.ts";
import {
  checkDestaqueRepeatedPastEdition,
  formatRepeatedDestaqueMessage,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { destaqueOnlyMarker, renderLine } from "../scripts/render-categorized-md.ts";
import { parseSections } from "../scripts/apply-gate-edits.ts";
import { dedupUrlKey } from "../scripts/lib/url-utils.ts";

const GEMINI = "https://blog.google/innovation-and-ai/products/gemini-app/computer-use-mac";
const GEMINI_TITLE = "Gemini agora clica e digita sozinho no seu Mac";
const NOTE = "url já publicada em seção não-destaque na janela de dedup — só pode voltar como destaque (#12193)";
const D1_PAST = "https://example.com/d1-261123";

const PAST_MD = [
  "# Past editions",
  "",
  '## 2026-11-23 — "Edição de domingo"',
  "",
  "Links usados:",
  `- ${D1_PAST} — Destaque de 261123`,
  // barra final: a chave de dedup é a mesma (o achado da #13882 era errado)
  `- ${GEMINI}/ — Let Gemini tackle repetitive chores on your Mac`,
  "",
].join("\n");

function setupEditions(root: string): string {
  const editions = join(root, "editions");
  mkdirSync(join(editions, "2611", "261123", "_internal"), { recursive: true });
  writeFileSync(
    join(editions, "2611", "261123", "_internal", "01-approved.json"),
    JSON.stringify({
      highlights: [{ rank: 1, url: D1_PAST }],
      radar: [{ url: `${GEMINI}/` }],
      lancamento: [],
      use_melhor: [],
      video: [],
    }),
  );
  return editions;
}

describe("#13883 origem do link repetido (edição + seção)", () => {
  let root: string;
  let editions: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "repeat-13883-"));
    editions = setupEditions(root);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("findApprovedSectionOf: RADAR, DESTAQUE e ausente", () => {
    const approved = { highlights: [{ article: { url: D1_PAST } }], radar: [{ url: GEMINI }], runners_up: [{ url: "https://x.com" }] };
    assert.equal(findApprovedSectionOf(approved, `${GEMINI}/`), "RADAR");
    assert.equal(findApprovedSectionOf(approved, D1_PAST), "DESTAQUE");
    assert.equal(findApprovedSectionOf(approved, "https://x.com"), undefined); // runners_up não é seção
    assert.equal(findApprovedSectionOf(null, GEMINI), undefined);
  });

  it("extractPastPublicationsWithinDays acha 261123 / RADAR pela pasta local", () => {
    const pubs = extractPastPublicationsWithinDays([GEMINI], PAST_MD, editions, 30, "261124", dedupUrlKey);
    assert.deepEqual(pubs.get(dedupUrlKey(GEMINI)), [{ date: "2026-11-23", section: "RADAR" }]);
  });

  it("sem pasta local a seção fica não identificada, a data não se perde", () => {
    const pubs = extractPastPublicationsWithinDays([GEMINI], PAST_MD, join(root, "nada"), 30, "261124", dedupUrlKey);
    assert.deepEqual(pubs.get(dedupUrlKey(GEMINI)), [{ date: "2026-11-23", section: UNKNOWN_SECTION }]);
  });

  it("attachDestaqueOnlyOrigins grava o campo só no item marcado pelo dedup", () => {
    const pubs = extractPastPublicationsWithinDays([GEMINI], PAST_MD, editions, 30, "261124", dedupUrlKey);
    const marked = { url: GEMINI, [DESTAQUE_ONLY_FIELD]: NOTE };
    const plain = { url: GEMINI };
    assert.equal(attachDestaqueOnlyOrigins([marked, plain], pubs, dedupUrlKey), 1);
    assert.deepEqual(readDestaqueOnlyOrigin(marked), [{ date: "2026-11-23", section: "RADAR" }]);
    assert.equal(plain[DESTAQUE_ONLY_ORIGIN_FIELD as keyof typeof plain], undefined);
  });
});

describe("#13883 gate 1 mostra o upgrade", () => {
  it("o marcador 🔁 cita edição e seção e não quebra o parser do gate", () => {
    const art = {
      url: GEMINI,
      title: GEMINI_TITLE,
      score: 97,
      date: "2026-11-19",
      [DESTAQUE_ONLY_FIELD]: NOTE,
      [DESTAQUE_ONLY_ORIGIN_FIELD]: [{ date: "2026-11-23", section: "RADAR" }],
    };
    assert.match(destaqueOnlyMarker(art) ?? "", /🔁 \(já saiu em 2026-11-23 \(RADAR\)/);
    const line = renderLine(art, true, false, 2);
    assert.match(line, /🔁/);
    const parsed = parseSections(`## Destaques\n\n${line}\n`);
    const urls = JSON.stringify(parsed);
    assert.ok(urls.includes(`"${GEMINI}"`), `parser perdeu a URL: ${urls}`);
  });

  it("sem o campo de origem o marcador ainda aparece; sem marcador do dedup, nada", () => {
    assert.match(destaqueOnlyMarker({ url: GEMINI, [DESTAQUE_ONLY_FIELD]: NOTE }) ?? "", /fora dos destaques/);
    assert.equal(destaqueOnlyMarker({ url: GEMINI }), null);
  });
});

describe("#13883 gate 4: destaque-repeated-past-edition", () => {
  const origins = [{ date: "2026-11-23", section: "RADAR" }];
  const pubs = new Map([[dedupUrlKey(GEMINI), origins]]);

  it("findRepeatedDestaques: upgrade marcado, sem fonte nova", () => {
    const hl = [
      { rank: 1, url: "https://example.com/novo", article: { url: "https://example.com/novo" } },
      { rank: 2, url: GEMINI, article: { url: GEMINI, title: GEMINI_TITLE, [DESTAQUE_ONLY_FIELD]: NOTE } },
    ];
    const out = findRepeatedDestaques(hl, pubs, dedupUrlKey);
    assert.equal(out.length, 1);
    assert.equal(out[0].position, 2);
    assert.equal(out[0].marked, true);
    assert.equal(out[0].newerSources, 0);
    const msg = formatRepeatedDestaqueMessage(out[0]);
    assert.match(msg, /^⚠️ D2 “Gemini agora clica/);
    assert.match(msg, /2026-11-23 \(RADAR\)/);
    assert.match(msg, /Nenhuma fonte nova no cluster/);
  });

  it("conta só fonte do cluster posterior à edição anterior", () => {
    const hl = [{
      url: GEMINI,
      article: {
        url: GEMINI,
        [DESTAQUE_ONLY_FIELD]: NOTE,
        cluster_sources: [
          { url: "https://a.com/velha", published_at: "2026-11-20" },
          { url: "https://b.com/nova", published_at: "2026-11-24" },
          { url: `${GEMINI}/`, published_at: "2026-11-24" }, // o próprio link não conta
        ],
      },
    }];
    const [r] = findRepeatedDestaques(hl, pubs, dedupUrlKey);
    assert.equal(r.newerSources, 1);
    assert.match(formatRepeatedDestaqueMessage(r), /1 fonte\(s\) do cluster com data posterior/);
  });

  it("repetição sem o marcador do dedup sai como 🚨", () => {
    const [r] = findRepeatedDestaques([{ url: GEMINI, article: { url: GEMINI } }], pubs, dedupUrlKey);
    assert.equal(r.marked, false);
    assert.match(formatRepeatedDestaqueMessage(r), /^🚨 D1 repete link/);
  });

  it("registrado no Stage 4 como warning", () => {
    const rule = getRulesForStage(4).find((r) => r.id === "destaque-repeated-past-edition");
    assert.ok(rule, "regra registrada");
    assert.equal(rule?.source_issue, "#13883");
  });

  describe("fixture da edição 261124", () => {
    let root: string;
    let editions: string;
    let pastPath: string;
    let editionDir: string;
    before(() => {
      root = mkdtempSync(join(tmpdir(), "repeat-13883-gate4-"));
      editions = setupEditions(root);
      pastPath = join(root, "past-editions.md");
      writeFileSync(pastPath, PAST_MD);
      editionDir = join(root, "run", "261124");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [
            { rank: 1, url: "https://www.scientificamerican.com/article/riemann", article: { url: "https://www.scientificamerican.com/article/riemann" } },
            { rank: 2, url: GEMINI, article: { url: GEMINI, title: GEMINI_TITLE, [DESTAQUE_ONLY_FIELD]: NOTE } },
          ],
          radar: [],
        }),
      );
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    it("o D2 repetido do RADAR de 261123 vira ⚠️ com edição e seção (antes: silêncio)", () => {
      const v = checkDestaqueRepeatedPastEdition(editionDir, { pastEditionsPath: pastPath, editionsDir: editions });
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "destaque-repeated-past-edition");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /D2 “Gemini agora clica e digita sozinho no seu Mac” repete link já publicado em 2026-11-23 \(RADAR\)/);
    });

    it("sem past-editions.md (bootstrap) não acusa nada", () => {
      const v = checkDestaqueRepeatedPastEdition(editionDir, { pastEditionsPath: join(root, "ausente.md"), editionsDir: editions });
      assert.deepEqual(v, []);
    });

    it("formatPastPublications junta várias edições", () => {
      assert.equal(
        formatPastPublications([{ date: "2026-11-23", section: "RADAR" }, { date: "2026-11-10", section: "USE MELHOR" }]),
        "2026-11-23 (RADAR); 2026-11-10 (USE MELHOR)",
      );
    });
  });
});
