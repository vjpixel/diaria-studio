/**
 * #13143 — dedup por TEMA, não só por URL, no pool secundário.
 *
 * Caso real (edição 261116): a 261113 publicou o destaque "Claude agora monta
 * planilhas e lousas com seu time" (blog da Anthropic, Claude Sheets) e a
 * 261116 trouxe no RADAR "Claude transformou planilha em uma conversa"
 * (StartSe), mesmo lançamento. O passe secundário de `check-highlight-themes.ts`
 * só comparava contra os buckets secundários do `01-approved.json` passado
 * (título da fonte, em inglês; destaque fora), escolhia o par pelo jaccard e
 * acabou casando "Introducing Claude Meetings" (só "Claude" em comum). E o
 * aviso secundário não subia ao editor em lugar nenhum.
 *
 * Premissa (issue deixa em aberto "mesmo fato" × "novo capítulo"): o sinal é
 * WARNING-ONLY — marca a possível repetição, nunca remove o item. Um
 * desdobramento legítimo do mesmo tema segue na edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkSecondaryThemes,
  publishedAsPastSecondary,
  type PastSecondaryItem,
  type SecondaryItem,
} from "../scripts/check-highlight-themes.ts";
import {
  sharedContentTerms,
  capitalizedTokens,
  formatSecondaryPossibleRepeatNotes,
  readPossibleRepeatWarnings,
} from "../scripts/lib/secondary-theme-repeat.ts";
import { tokenizeForJaccard } from "../scripts/lib/title-similarity.ts";
import { checkSecondaryThemePossibleRepeat, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = resolve(import.meta.dirname, "..");

const SHEETS_RADAR: SecondaryItem = {
  bucket: "radar",
  title: "Claude transformou planilha em uma conversa",
  url: "https://www.startse.com/artigos/claude-transformou-planilha-em-uma-conversa/",
};
const SHEETS_PUBLISHED_TITLE = "Claude agora monta planilhas e lousas com seu time";
const SHEETS_URL = "https://claude.com/resources/articles/more-ways-to-work-with-claude-sheets-whiteboards-and-interactive-connectors";

// Pool passado como o de 261113: o LANÇAMENTO que vencia pelo jaccard e o
// destaque publicado (título em português de 02-reviewed.md).
const PAST_261113: PastSecondaryItem[] = [
  { edition: "261113", title: "Introducing Claude Meetings", bucket: "lancamento" },
  { edition: "261113", title: "Working with Claude Sheets, Whiteboards, and Interactive Connectors", bucket: "lancamento" },
  { edition: "261113", title: SHEETS_PUBLISHED_TITLE, bucket: "destaque" },
];

describe("#13143: possível repetição de tema no pool secundário", () => {
  it("regressão 261116: RADAR da StartSe casa o destaque do Claude Sheets e sai como possível repetição", () => {
    const { secondary_warnings } = checkSecondaryThemes([SHEETS_RADAR], PAST_261113);
    assert.equal(secondary_warnings.length, 1);
    const w = secondary_warnings[0];
    assert.equal(w.matched_title, SHEETS_PUBLISHED_TITLE, "o par certo vence o 'Introducing Claude Meetings'");
    assert.equal(w.matched_bucket, "destaque");
    assert.equal(w.matched_edition, "261113");
    assert.equal(w.possible_repeat, true);
    assert.deepEqual(w.content_terms, ["planilha/planilhas"]);
    assert.deepEqual(w.shared_entities, ["claude"]);
  });

  it("sem o destaque publicado no pool, o par só de entidade não vira possível repetição", () => {
    const { secondary_warnings } = checkSecondaryThemes([SHEETS_RADAR], PAST_261113.slice(0, 2));
    assert.equal(secondary_warnings.length, 1);
    assert.equal(secondary_warnings[0].matched_title, "Introducing Claude Meetings");
    assert.equal(secondary_warnings[0].possible_repeat, false);
  });

  it("nome próprio nos dois títulos não conta como termo de conteúdo (Claude-maker × falso Claude)", () => {
    const { secondary_warnings } = checkSecondaryThemes(
      [{ bucket: "radar", title: "Is Claude-maker Anthropic going public just as the AI bubble bursts?", url: "https://dw.com/x" }],
      [{ edition: "261030", title: "Golpe do falso Claude usa site oficial da Anthropic para roubar senhas", bucket: "destaque" }],
    );
    assert.ok(secondary_warnings.every((w) => !w.possible_repeat), JSON.stringify(secondary_warnings));
  });

  it("entidade genérica de manchete ('Introducing') não basta para possível repetição", () => {
    const { secondary_warnings } = checkSecondaryThemes(
      [{ bucket: "lancamento", title: "Introducing Eleven Realtime voice agents", url: "https://elevenlabs.io/x" }],
      [{ edition: "261016", title: "Introducing Grok Voice 3.0", bucket: "lancamento" }],
    );
    assert.ok(secondary_warnings.every((w) => !w.possible_repeat), JSON.stringify(secondary_warnings));
  });

  it("palavra genérica do domínio não é termo de conteúdo", () => {
    const terms = sharedContentTerms(
      tokenizeForJaccard("Google lança nova ferramenta de inteligência artificial"),
      tokenizeForJaccard("Google demite equipe e troca por ferramenta de inteligência artificial"),
      new Set(["google"]),
    );
    assert.deepEqual(terms, []);
  });

  it("capitalizedTokens separa nome grudado por hífen", () => {
    assert.deepEqual([...capitalizedTokens("Is Claude-maker Anthropic going")].sort(), ["anthropic", "claude", "is", "maker"]);
  });

  it("publishedAsPastSecondary: destaque vira bucket 'destaque', item de seção leva a seção", () => {
    const out = publishedAsPastSecondary([
      { label: "D2", title: SHEETS_PUBLISHED_TITLE, url: SHEETS_URL, aammdd: "261113", highlight: true },
      { label: "RADAR", title: "Outro item", url: "https://x.com/a", aammdd: "261113", highlight: false },
      { label: "RADAR", title: "  ", url: "https://x.com/b", aammdd: "261113", highlight: false },
    ]);
    assert.deepEqual(out, [
      { edition: "261113", title: SHEETS_PUBLISHED_TITLE, bucket: "destaque" },
      { edition: "261113", title: "Outro item", bucket: "RADAR" },
    ]);
  });
});

/** Fixture de disco: 261113 publicada (02-reviewed.md com o destaque) e 261116 corrente. */
function diskFixture(): { root: string; editionsDir: string; categorized: string; currentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "sec-theme-13143-"));
  const editionsDir = join(root, "editions");
  const past = join(editionsDir, "2611", "261113");
  mkdirSync(join(past, "_internal"), { recursive: true });
  writeFileSync(
    join(past, "_internal", "01-approved.json"),
    JSON.stringify({
      highlights: [{ title: "Working with Claude Sheets, Whiteboards, and Interactive Connectors", url: SHEETS_URL }],
      lancamento: [{ title: "Introducing Claude Meetings", url: "https://claude.com/resources/articles/claude-meetings" }],
      radar: [],
    }),
  );
  writeFileSync(
    join(past, "02-reviewed.md"),
    [
      "**DESTAQUE 2 | PRODUTO**",
      "",
      `**[${SHEETS_PUBLISHED_TITLE}](${SHEETS_URL})**`,
      "",
      "A Anthropic lançou o Claude Sheets.",
      "",
      "---",
      "",
      "**🚀 LANÇAMENTOS**",
      "",
      "**[Introducing Claude Meetings](https://claude.com/resources/articles/claude-meetings)**",
      "Texto.",
      "",
    ].join("\n"),
  );
  const currentDir = join(editionsDir, "2611", "261116");
  mkdirSync(join(currentDir, "_internal"), { recursive: true });
  const categorized = join(currentDir, "_internal", "01-categorized.json");
  writeFileSync(categorized, JSON.stringify({ highlights: [], radar: [SHEETS_RADAR], lancamento: [] }));
  return { root, editionsDir, categorized, currentDir };
}

describe("#13143: CLI, relatório do Stage 1 e gate 4", () => {
  it("check-highlight-themes.ts (CLI real) compara o secundário contra o destaque publicado", () => {
    const { root, editionsDir, categorized } = diskFixture();
    try {
      const r = spawnSync(
        process.execPath,
        [
          "--import", "tsx", join(ROOT, "scripts", "check-highlight-themes.ts"),
          "--categorized", categorized,
          "--past-editions", join(root, "nao-existe.md"),
          "--editions-dir", editionsDir,
          "--current-edition", "261116",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { secondary_warnings: Array<Record<string, unknown>> };
      const w = out.secondary_warnings.find((x) => x.item_url === SHEETS_RADAR.url);
      assert.ok(w, JSON.stringify(out.secondary_warnings));
      assert.equal(w.matched_title, SHEETS_PUBLISHED_TITLE);
      assert.equal(w.possible_repeat, true);
      assert.match(r.stderr, /possível repetição/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const THEME_CHECK = {
    same_fact_warnings: [],
    secondary_warnings: [
      {
        bucket: "radar", item_url: SHEETS_RADAR.url, item_title: SHEETS_RADAR.title,
        matched_edition: "261113", matched_title: SHEETS_PUBLISHED_TITLE, matched_bucket: "destaque",
        shared_entities: ["claude"], theme_evidence: "prefix:planil (planilha/planilhas)", jaccard: 0.13,
        content_terms: ["planilha/planilhas"], possible_repeat: true,
      },
      {
        bucket: "radar", item_url: "https://x.com/fraco", item_title: "Aviso fraco",
        matched_edition: "261113", matched_title: "Introducing Claude Meetings", matched_bucket: "lancamento",
        shared_entities: ["claude"], theme_evidence: "jaccard:0.17", jaccard: 0.17, content_terms: [], possible_repeat: false,
      },
    ],
  };

  it("nota do Stage 1 só para possível repetição que segue no 01-approved.json", () => {
    const approved = { highlights: [], radar: [{ url: SHEETS_RADAR.url, title: SHEETS_RADAR.title }, { url: "https://x.com/fraco" }] };
    const notes = formatSecondaryPossibleRepeatNotes(THEME_CHECK, approved);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Possível repetição de tema/);
    assert.match(notes[0], /planilha\/planilhas/);
    assert.deepEqual(formatSecondaryPossibleRepeatNotes(THEME_CHECK, { radar: [] }), []);
    assert.deepEqual(readPossibleRepeatWarnings({ secondary_warnings: "lixo" }), []);
  });

  it("desdobramento legítimo passa: possível repetição nunca remove o item (apply-same-fact-removal --auto)", () => {
    const root = mkdtempSync(join(tmpdir(), "sec-theme-13143-rm-"));
    try {
      const approvedPath = join(root, "01-approved.json");
      const themePath = join(root, "01-highlight-theme-check.json");
      const followUp = {
        url: "https://www.anthropic.com/news/claude-sheets-excel-import",
        title: "Claude Sheets passa a importar planilhas do Excel e ganha preço próprio",
      };
      const approved = { highlights: [], radar: [followUp, { url: SHEETS_RADAR.url, title: SHEETS_RADAR.title }], lancamento: [] };
      writeFileSync(approvedPath, JSON.stringify(approved));
      writeFileSync(themePath, JSON.stringify({
        ...THEME_CHECK,
        secondary_warnings: [
          ...THEME_CHECK.secondary_warnings,
          { ...THEME_CHECK.secondary_warnings[0], item_url: followUp.url, item_title: followUp.title },
        ],
      }));
      const r = spawnSync(
        process.execPath,
        [
          "--import", "tsx", join(ROOT, "scripts", "apply-same-fact-removal.ts"),
          "--approved", approvedPath, "--theme-check", themePath, "--out-log", join(root, "removed.json"),
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const after = JSON.parse(readFileSync(approvedPath, "utf8")) as { radar: Array<{ url: string }> };
      assert.deepEqual(after.radar.map((it) => it.url), [followUp.url, SHEETS_RADAR.url]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate 4: invariante secondary-theme-possible-repeat avisa o item que segue no 02-reviewed.md", () => {
    assert.ok(STAGE_4_RULES.some((r) => r.id === "secondary-theme-possible-repeat" && r.stage === 4));
    const root = mkdtempSync(join(tmpdir(), "sec-theme-13143-g4-"));
    try {
      mkdirSync(join(root, "_internal"), { recursive: true });
      writeFileSync(join(root, "_internal", "01-highlight-theme-check.json"), JSON.stringify(THEME_CHECK));
      writeFileSync(
        join(root, "02-reviewed.md"),
        `**📡 RADAR**\n\n**[${SHEETS_RADAR.title}](${SHEETS_RADAR.url})**\nTexto.\n\n**[Aviso fraco](https://x.com/fraco)**\nTexto.\n`,
      );
      const v = checkSecondaryThemePossibleRepeat(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "secondary-theme-possible-repeat");
      assert.match(v[0].message, /261113/);

      // Cortado no gate: some do aviso.
      writeFileSync(join(root, "02-reviewed.md"), "**📡 RADAR**\n\n**[Outro](https://x.com/outro)**\nTexto.\n");
      assert.deepEqual(checkSecondaryThemePossibleRepeat(root), []);

      // Já com MESMO FATO: um aviso por item, fica de fora.
      writeFileSync(join(root, "02-reviewed.md"), `**📡 RADAR**\n\n**[${SHEETS_RADAR.title}](${SHEETS_RADAR.url})**\nTexto.\n`);
      writeFileSync(
        join(root, "_internal", "01-highlight-theme-check.json"),
        JSON.stringify({ ...THEME_CHECK, same_fact_warnings: [{ item_url: SHEETS_RADAR.url }] }),
      );
      assert.deepEqual(checkSecondaryThemePossibleRepeat(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
