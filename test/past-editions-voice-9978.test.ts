/**
 * test/past-editions-voice-9978.test.ts (#9978)
 *
 * Regressão: o #9955 subiu `dedupEditionCount` 14 → 35 pra cobrir ~30 dias de
 * dedup de URL, e `data/past-editions.md` vai a ~2750 linhas / ~60k tokens —
 * acima do teto do `Read` (2000 linhas / 25k tokens) dos writers, que liam o
 * arquivo inteiro pra calibrar voz. Fix: recorte `past-editions-recent.md`
 * (14 seções) pros agentes; o arquivo completo segue alimentando o dedup.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  VOICE_EDITION_COUNT,
  buildVoiceExcerpt,
  voicePathFor,
  writeVoiceExcerpt,
} from "../scripts/lib/past-editions-voice.ts";
import { renderMarkdown, type Post } from "../scripts/refresh-past-editions.ts";
import { extractPastUrlsWithinDays, DEDUP_URL_WINDOW_DAYS } from "../scripts/lib/past-editions-extract.ts";
import { dedup } from "../scripts/dedup.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";
import { refreshDedup, type RefreshConfig } from "../scripts/refresh-dedup.ts";

/** Teto do Read dos agentes. */
const READ_MAX_LINES = 2000;
const READ_MAX_TOKENS = 25_000;
/** Real (data/past-editions.md de 261009): 92.995 chars ≈ 24k tokens → ~3,9 chars/token. */
const estimateTokens = (s: string) => Math.ceil(s.length / 3.9);

const SOL = "https://openai.com/index/introducing-gpt-6-1-sol/"; // 8 edições atrás
const AUG = "https://example.com/noticia-de-setembro-cedo"; // 20 edições atrás, ~28 dias

/**
 * 35 edições em dias úteis a partir de 2026-10-08 pra trás, com densidade de
 * links igual à real (~1100 linhas / 93k chars por 14 edições ≈ 72 links de
 * ~85 chars cada).
 */
function buildPosts(): Post[] {
  const posts: Post[] = [];
  let d = Date.UTC(2026, 9, 8);
  while (posts.length < 35) {
    const dt = new Date(d);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const iso = dt.toISOString().slice(0, 10);
      const links = Array.from(
        { length: 72 },
        (_, i) => `https://www.exemplo-de-fonte-longa.com.br/noticias/${iso}/materia-sobre-ia-numero-${i}`,
      );
      if (posts.length === 7) links.push(SOL);
      if (posts.length === 19) links.push(AUG);
      posts.push({
        id: `post_${iso}`,
        title: `Edição ${iso}`,
        web_url: `https://diaria.beehiiv.com/p/${iso}`,
        published_at: `${iso}T09:00:00Z`,
        links,
      } as Post);
    }
    d -= 86400000;
  }
  return posts;
}

describe("#9978 — recorte de voz de past-editions.md", () => {
  let sandbox: string;
  let fullMd: string;
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "voice-9978-"));
    fullMd = renderMarkdown(buildPosts(), sandbox);
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it("documenta o bug: o arquivo completo de 35 edições estoura o Read", () => {
    const lines = fullMd.split("\n").length;
    assert.ok(
      lines > READ_MAX_LINES || estimateTokens(fullMd) > READ_MAX_TOKENS,
      `fixture deveria estourar o Read (linhas=${lines}, tokens≈${estimateTokens(fullMd)})`,
    );
  });

  it("o recorte que os writers leem cabe no orçamento do Read", () => {
    const excerpt = buildVoiceExcerpt(fullMd);
    const lines = excerpt.split("\n").length;
    assert.ok(lines <= READ_MAX_LINES, `recorte com ${lines} linhas`);
    assert.ok(estimateTokens(excerpt) <= READ_MAX_TOKENS, `recorte com ~${estimateTokens(excerpt)} tokens`);
    assert.equal((excerpt.match(/^## \d{4}-\d{2}-\d{2}/gm) ?? []).length, VOICE_EDITION_COUNT);
  });

  it("o recorte pega as mais RECENTES por data, inclusive seção pending appendada no fim", () => {
    const pending =
      fullMd +
      `\n## 2026-10-09 — (pending_publish — edição 261009 aprovada mas não publicada no Beehiiv)\n\nLinks usados:\n- https://example.com/pending\n\n---\n`;
    const excerpt = buildVoiceExcerpt(pending, 3);
    const dates = [...excerpt.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
    assert.deepEqual(dates, ["2026-10-09", "2026-10-08", "2026-10-07"]);
    assert.ok(excerpt.includes("https://example.com/pending"));
  });

  it("dedup de URL segue lendo o arquivo completo: URL de 8 e de 20 edições atrás reprovam", () => {
    const pastUrls = extractPastUrlsWithinDays(fullMd, DEDUP_URL_WINDOW_DAYS, "261009");
    assert.ok(pastUrls.has(canonicalize(SOL)));
    assert.ok(pastUrls.has(canonicalize(AUG)), "edição de 20 dias úteis atrás (~28 dias) fora do recorte mas dentro do dedup");
    const { removed } = dedup(
      [
        { url: SOL, title: "GPT-6.1 Sol encosta no Astra" },
        { url: AUG, title: "Notícia do começo de setembro" },
      ],
      pastUrls,
      0.85,
    );
    assert.deepEqual(
      removed.map((r: { url: string }) => r.url).sort(),
      [AUG, SOL].sort(),
    );
    // E o recorte de voz NÃO cobre a de 20 edições — prova de que o dedup não pode lê-lo.
    assert.ok(!buildVoiceExcerpt(fullMd).includes(AUG));
  });

  it("writeVoiceExcerpt grava irmão de mdPath e é fail-soft sem o MD", () => {
    const mdPath = join(sandbox, "past.md");
    assert.equal(writeVoiceExcerpt(mdPath), null);
    writeFileSync(mdPath, fullMd);
    const out = writeVoiceExcerpt(mdPath);
    assert.equal(out, voicePathFor(mdPath));
    assert.equal(out, join(sandbox, "past-editions-recent.md"));
    assert.equal(readFileSync(out!, "utf8"), buildVoiceExcerpt(fullMd));
  });

  it("refresh-dedup regenera o recorte junto com o MD completo", async () => {
    const dir = mkdtempSync(join(sandbox, "rd-"));
    const rawPath = join(dir, "raw.json");
    const mdPath = join(dir, "past-editions.md");
    writeFileSync(rawPath, JSON.stringify(buildPosts()));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [], page: 1, total_results: 0, total_pages: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    try {
      const cfg: RefreshConfig = {
        readConfig: { backend: "beehiiv", config: { apiKey: "k", publicationId: "pub_test" } },
        dedupEditionCount: 35,
      };
      await refreshDedup({
        dryRun: false,
        resolveTracking: false,
        rawPath,
        mdPath,
        configOverride: cfg,
        editionsRoot: join(dir, "data", "editions"),
        noAutoStamp: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const full = readFileSync(mdPath, "utf8");
    assert.equal((full.match(/^## \d{4}/gm) ?? []).length, 35);
    const voicePath = join(dir, "past-editions-recent.md");
    assert.ok(existsSync(voicePath));
    const voice = readFileSync(voicePath, "utf8");
    assert.equal((voice.match(/^## \d{4}/gm) ?? []).length, VOICE_EDITION_COUNT);
    assert.ok(voice.split("\n").length <= READ_MAX_LINES);
  });

  it("os prompts dos agentes leem o recorte, não o arquivo completo", () => {
    const root = resolve(import.meta.dirname, "..");
    const files = [
      ".claude/agents/writer.md",
      ".claude/agents/writer-destaque.md",
      ".claude/agents/writer-monthly.md",
      ".claude/agents/research-reviewer.md",
      ".claude/agents/orchestrator-stage-2.md",
      ".claude/agents/orchestrator-stage-3.md",
      ".claude/skills/diaria-mensal/SKILL.md",
    ];
    for (const f of files) {
      const s = readFileSync(join(root, f), "utf8");
      assert.ok(s.includes("data/past-editions-recent.md"), `${f} deveria citar o recorte`);
      // Instruções de leitura/calibração não podem apontar pro arquivo completo.
      assert.ok(
        !/(Ler|calibrando (a )?voz com) `?data\/past-editions\.md/.test(s),
        `${f} ainda manda ler data/past-editions.md completo`,
      );
      assert.ok(!/^- `data\/past-editions\.md` —/m.test(s), `${f} lista o arquivo completo como contexto obrigatório`);
    }
  });
});
