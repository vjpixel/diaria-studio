/**
 * #13846: o Pass-1c (e o sinal same-event) comparava contra TODO título de
 * `01-approved.json` das edições anteriores — inclusive candidato aprovado na
 * pesquisa e nunca publicado. Caso real 261119 → 261123: "Introducing Gemini 4
 * Neon" estava no approved da 261119 mas não saiu; a história mais citada da
 * semana foi removida como "similar a edição anterior".
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readApprovedTitles,
  extractPastUrlsByEdition,
  extractPastEditionArticleTitlesWithEdition,
} from "../scripts/lib/past-editions-extract.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

const NEON_OLD = "https://blog.google/products/gemini/gemini-4-neon/";
const PUBLISHED = "https://example.com/gemini-4-argon-publicado";
const NEON_NEW = "https://deepmind.google/blog/introducing-gemini-4-neon/";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dedup-13846-"));
  const ed = join(root, "editions", "261119", "_internal");
  mkdirSync(ed, { recursive: true });
  writeFileSync(
    join(ed, "01-approved.json"),
    JSON.stringify({
      highlights: [{ url: PUBLISHED, title: "Gemini 4 Argon chega ao Workspace" }],
      lancamento: [{ url: NEON_OLD, title: "Introducing Gemini 4 Neon" }],
    }),
  );
  const past = join(root, "past.md");
  writeFileSync(past, `# Past editions\n\n## 2026-11-19 — "Argon"\n\n- ${PUBLISHED}\n`);
  const articles = join(root, "articles.json");
  writeFileSync(
    articles,
    JSON.stringify([{ url: NEON_NEW, title: "Introducing Gemini 4 Neon" }]),
  );
  return { root, past, articles };
}

it("#13846: readApprovedTitles com publishedUrls ignora candidato não publicado", () => {
  const { root, past } = fixture();
  try {
    const path = join(root, "editions", "261119", "_internal", "01-approved.json");
    assert.deepEqual(readApprovedTitles(path).sort(), ["Gemini 4 Argon chega ao Workspace", "Introducing Gemini 4 Neon"]);
    assert.deepEqual(readApprovedTitles(path, new Set([PUBLISHED])), ["Gemini 4 Argon chega ao Workspace"]);
    void past;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("#13846: dedup mantém o item aprovado-e-não-publicado em edição anterior", () => {
  const { root, past, articles } = fixture();
  try {
    const out = join(root, "out.json");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/dedup.ts"), "--articles", articles, "--past-editions", past,
        "--editions-dir", join(root, "editions"), "--log-root-dir", root, "--current-edition", "261123", "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(result.kept.map((a: { url: string }) => a.url), [NEON_NEW]);
    assert.equal(result.removed.length, 0, JSON.stringify(result.removed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #13866: o filtro de URLs publicadas era GLOBAL. Edição presente no disco e
 * ausente do past-editions.md (merge-local-pending falhou no Stage 0, edição
 * agendada ainda não enviada) perdia TODOS os títulos do approved, e a
 * pesquisa seguinte podia repetir a história com outra URL.
 */
const OPUS_OLD = "https://www.anthropic.com/news/claude-6-opus";
const OPUS_NEW = "https://techcrunch.com/2026/11/21/anthropic-claude-6-opus/";
const OPUS_TITLE = "Anthropic lança o Claude 6 Opus com contexto de 5 milhões de tokens";

function fixtureAusente() {
  const base = fixture();
  const ed = join(base.root, "editions", "261120", "_internal");
  mkdirSync(ed, { recursive: true });
  writeFileSync(join(ed, "01-approved.json"), JSON.stringify({ highlights: [{ url: OPUS_OLD, title: OPUS_TITLE }] }));
  writeFileSync(base.articles, JSON.stringify([{ url: OPUS_NEW, title: OPUS_TITLE }]));
  return base;
}

it("#13866: extractPastUrlsByEdition agrupa por AAMMDD da seção", () => {
  const map = extractPastUrlsByEdition(`# Past\n\n## 2026-11-19 — "A"\n\n- ${PUBLISHED}\n\n## 2026-11-18 — "B"\n\n- ${NEON_OLD}\n`);
  assert.deepEqual([...map.keys()].sort(), ["261118", "261119"]);
  assert.equal(map.get("261119")?.size, 1);
  assert.ok(map.get("261118")?.has(canonicalize(NEON_OLD)));
});

it("#13866: edição ausente do past-editions.md mantém o approved inteiro; a presente segue filtrada", () => {
  const { root, past } = fixtureAusente();
  try {
    const byEdition = extractPastUrlsByEdition(readFileSync(past, "utf8"));
    const titles = extractPastEditionArticleTitlesWithEdition(join(root, "editions"), 5, "261123", byEdition);
    assert.deepEqual(
      titles.map((t) => `${t.aammdd}:${t.title}`).sort(),
      [`261119:Gemini 4 Argon chega ao Workspace`, `261120:${OPUS_TITLE}`],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("#13866: dedup remove a mesma história com outra URL quando a edição anterior não está no past-editions.md", () => {
  const { root, past, articles } = fixtureAusente();
  try {
    const out = join(root, "out.json");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/dedup.ts"), "--articles", articles, "--past-editions", past,
        "--editions-dir", join(root, "editions"), "--log-root-dir", root, "--current-edition", "261123", "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(result.kept.length, 0, JSON.stringify(result.kept));
    assert.deepEqual(result.removed.map((a: { url: string }) => a.url), [OPUS_NEW]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
