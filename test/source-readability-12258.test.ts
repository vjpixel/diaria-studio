/**
 * #12258: item cuja fonte não foi lida (403/vídeo/resumo de uma frase) leva
 * desconto de score no merge, é marcado em 01-approved.json, aparece no gate
 * do Stage 4 e gera aviso ao ser promovido.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessSourceReadability,
  sourceUnreadablePenalty,
  readSourceReadability,
  findUnreadItemsInEdition,
  checkSourceNotRead,
  promotedSourceUnreadWarning,
  SOURCE_UNREADABLE_PENALTY,
  SOURCE_UNREADABLE_BONUS_ENTRY,
} from "../scripts/lib/diaria/source-readability.ts";
import { mergeChunks } from "../scripts/merge-scored-chunks.ts";
import type { Categorized } from "../scripts/split-articles-for-scoring.ts";
import { finalizeStage1, type CategorizedBuckets, type ScoredOutput } from "../scripts/finalize-stage1.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

const LONG = "Um resumo de verdade, com o fato, quem fez, quanto e por que importa para o leitor.";
// Caso real da edição 261105 (axios.com, 403 no gate, resumo de 48 caracteres).
const AXIOS = {
  url: "https://www.axios.com/2026/11/03/ai-sovereign-agents-security-threat",
  title: "\"Weird alien minds\": A new report warns of AI agents hacking to survive on their own",
  flag: "newsletter_extracted",
  verify_verdict: "accessible",
  verify_note: "browser fallback",
  summary: "Rogue AI models are an emerging security threat.",
  category: "noticias",
};

describe("assessSourceReadability (#12258)", () => {
  it("caso 261105: resumo de uma frase com verify accessible → não lida", () => {
    const r = assessSourceReadability(AXIOS);
    assert.equal(r.readable, false);
    assert.match(r.reason!, /resumo de 48 caracteres/);
  });

  it("veredito de acesso que não traz texto → não lida, com a nota do verify", () => {
    const r = assessSourceReadability({ verify_verdict: "anti_bot", verify_note: "GET 403 (trusted publisher)", summary: LONG });
    assert.equal(r.readable, false);
    assert.equal(r.reason, "verify anti_bot (GET 403 (trusted publisher))");
    for (const v of ["paywall", "blocked", "uncertain", "error", "needs_reverify"]) {
      assert.equal(assessSourceReadability({ verify_verdict: v, summary: LONG }).readable, false, v);
    }
  });

  // #12320: verify dá `video` a toda URL de vídeo e o conta como OK; o veredito
  // sozinho não diz que a fonte não foi lida. Decide o resumo.
  it("vídeo com descrição longa → lida, sem desconto (#12320)", () => {
    const yt = { url: "https://www.youtube.com/watch?v=abc", verify_verdict: "video", summary: LONG };
    assert.deepEqual(assessSourceReadability(yt), { readable: true });
    assert.equal(sourceUnreadablePenalty(yt), 0);
  });

  it("vídeo sem texto continua não lido, pela regra do resumo (#12320)", () => {
    const semResumo = assessSourceReadability({ verify_verdict: "video", summary: "" });
    assert.deepEqual(semResumo, { readable: false, reason: "sem resumo da fonte" });
    const umaLinha = assessSourceReadability({ verify_verdict: "video", summary: "Veja o vídeo." });
    assert.equal(umaLinha.readable, false);
    assert.match(umaLinha.reason!, /resumo de 13 caracteres/);
    assert.equal(assessSourceReadability({ verify_verdict: "video" }).readable, false);
    assert.equal(sourceUnreadablePenalty({ verify_verdict: "video", summary: "Veja o vídeo." }), SOURCE_UNREADABLE_PENALTY);
  });

  it("verify accessible + resumo longo → lida", () => {
    assert.equal(assessSourceReadability({ verify_verdict: "accessible", summary: LONG }).readable, true);
  });

  it("verificado e sem campo summary → não lida", () => {
    const r = assessSourceReadability({ verify_verdict: "accessible" });
    assert.equal(r.readable, false);
    assert.equal(r.reason, "sem resumo da fonte");
  });

  it("sem veredito e sem summary (não passou pelo verify) → não julga", () => {
    assert.equal(assessSourceReadability({ url: "x" }).readable, true);
  });

  it("aceita item de highlight embrulhado em { article }", () => {
    assert.equal(assessSourceReadability({ rank: 1, article: AXIOS }).readable, false);
  });
});

describe("sourceUnreadablePenalty / readSourceReadability (#12258)", () => {
  it("desconto só para fonte não lida; item do editor fica isento", () => {
    assert.equal(sourceUnreadablePenalty(AXIOS), SOURCE_UNREADABLE_PENALTY);
    assert.equal(sourceUnreadablePenalty({ ...AXIOS, editor_submitted: true }), 0);
    assert.equal(sourceUnreadablePenalty({ verify_verdict: "accessible", summary: LONG }), 0);
  });

  it("campo gravado vence a regra; ausente cai na regra", () => {
    assert.equal(readSourceReadability({ source_readable: true, summary: "x", verify_verdict: "accessible" }).readable, true);
    const r = readSourceReadability({ source_readable: false, source_unreadable_reason: "verify video" });
    assert.deepEqual(r, { readable: false, reason: "verify video" });
    assert.equal(readSourceReadability(AXIOS).readable, false);
  });
});

describe("mergeChunks desconta fonte não lida (#12258)", () => {
  const read = { url: "read", title: "read", category: "noticias", verify_verdict: "accessible", summary: LONG };
  const CAT: Categorized = {
    lancamento: [],
    radar: [{ ...AXIOS, url: "unread", title: "unread" }, read],
    use_melhor: [],
    video: [],
  };
  const chunks = [{ all_scored: [{ url: "unread", score: 65 }, { url: "read", score: 60 }] }];

  it("-10 no score, entrada auditável, e o verificado passa à frente", () => {
    const r = mergeChunks(CAT, chunks, 1);
    const by = new Map(r.all_scored.map((s) => [s.url, s]));
    assert.equal(by.get("unread")?.score, 55);
    assert.equal(by.get("unread")?.score_base, 65);
    assert.deepEqual(by.get("unread")?.bonuses_applied, [SOURCE_UNREADABLE_BONUS_ENTRY]);
    assert.equal(by.get("read")?.score, 60);
    assert.equal(by.get("read")?.bonuses_applied, undefined);
    assert.equal(r.finalists[0].url, "read");
  });
});

describe("finalize-stage1 marca source_readable: false (#12258)", () => {
  it("item não lido sai marcado com o motivo; o lido sai sem o campo", () => {
    const categorized = {
      lancamento: [],
      radar: [AXIOS, { url: "https://b.com/2", title: "B", verify_verdict: "accessible", summary: LONG }],
    } as unknown as CategorizedBuckets;
    const scored = {
      highlights: [],
      runners_up: [],
      all_scored: [{ url: AXIOS.url, score: 65 }, { url: "https://b.com/2", score: 70 }],
    } as ScoredOutput;
    const { buckets } = finalizeStage1(categorized, scored);
    const byUrl = new Map((buckets.radar as Array<Record<string, unknown>>).map((a) => [a.url, a]));
    assert.equal(byUrl.get(AXIOS.url)?.source_readable, false);
    assert.match(String(byUrl.get(AXIOS.url)?.source_unreadable_reason), /resumo de 48/);
    assert.equal("source_readable" in (byUrl.get("https://b.com/2") ?? {}), false);
  });
});

describe("source-not-read no Stage 4 (#12258)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "src-read-12258-"));
    mkdirSync(join(dir, "_internal"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const approved = {
    highlights: [{ rank: 1, article: { url: "https://g1.globo.com/video/x", title: "Vídeo do g1", verify_verdict: "video", summary: "Assista ao vídeo." } }],
    radar: [AXIOS, { url: "https://cut.com/y", title: "Cortado", verify_verdict: "anti_bot", summary: LONG }],
    video: [{ url: "https://www.youtube.com/watch?v=ok", title: "Vídeo com descrição", verify_verdict: "video", summary: LONG }],
    lancamento: [{ url: "https://ok.com/z", title: "Ok", verify_verdict: "accessible", summary: LONG }],
  };
  const md = `**DESTAQUE 1 | X**\n\n[Vídeo](https://g1.globo.com/video/x)\n\n**RADAR**\n\n[A](${AXIOS.url})\n\n[Ok](https://ok.com/z)\n\n**VÍDEOS**\n\n[V](https://www.youtube.com/watch?v=ok)\n`;

  it("findUnreadItemsInEdition: só o que está no texto, destaque sinalizado", () => {
    const items = findUnreadItemsInEdition(approved, md);
    assert.deepEqual(items.map((i) => [i.url, i.highlight]), [
      ["https://g1.globo.com/video/x", true],
      [AXIOS.url, false],
    ]);
  });

  it("regra registrada no Stage 4 como warning, lista os itens", () => {
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
    writeFileSync(join(dir, "02-reviewed.md"), md);
    const rule = getRulesForStage(4).find((r) => r.id === "source-not-read");
    assert.ok(rule, "source-not-read deve estar no Stage 4");
    const v = rule.run(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /fonte não lida: 2 item/);
    assert.match(v[0].message, /\(403, vídeo sem texto ou resumo curto\): \[DESTAQUE\]/);
    assert.match(v[0].message, /\[DESTAQUE\] "Vídeo do g1"/);
    assert.match(v[0].message, /Weird alien minds/);
    assert.doesNotMatch(v[0].message, /Cortado/);
    assert.doesNotMatch(v[0].message, /Vídeo com descrição/, "vídeo com descrição longa não é fonte não lida (#12320)");
    assert.deepEqual(checkSourceNotRead(dir), v);
  });

  it("sem item não lido no texto, ou sem arquivos → nada", () => {
    assert.deepEqual(checkSourceNotRead(dir), []);
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
    writeFileSync(join(dir, "02-reviewed.md"), "[Ok](https://ok.com/z)\n");
    assert.deepEqual(checkSourceNotRead(dir), []);
  });
});

describe("promotedSourceUnreadWarning (#12258)", () => {
  it("aviso ao promover item não lido; nada para item lido", () => {
    const w = promotedSourceUnreadWarning(AXIOS, "Weird alien minds");
    assert.match(w!, /fonte do item promovido "Weird alien minds" não foi lida/);
    assert.equal(promotedSourceUnreadWarning({ verify_verdict: "accessible", summary: LONG }, "t"), null);
  });
});
