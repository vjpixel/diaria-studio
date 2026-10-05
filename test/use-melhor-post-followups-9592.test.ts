/**
 * test/use-melhor-post-followups-9592.test.ts (#9592, #9599, #9600)
 *
 * Achados da 1ª edição real do 4º post social (USE MELHOR), 261005:
 *   - #9592: o editor trocou o item à mão (passo a passo de score 60 no lugar
 *     do de 62) e os 5 canais pularam o 4º post, porque a re-seleção por score
 *     no Stage 5 apontava o outro. Agora vale o item ESCOLHIDO enquanto ele
 *     seguir no USE MELHOR final; o Stage 4 acusa antes do gate quando ele sai.
 *   - #9599: tutorial de recurso em descontinuação (custom GPTs) escolhido
 *     apesar de a 260929 ter noticiado o fim do recurso.
 *   - #9600: capa do carrossel com o título da fonte, em inglês.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  checkUseMelhorItemInFinal,
  describeUseMelhorPostStatus,
  resolveUseMelhorCoverTitle,
  selectUseMelhorItem,
  useMelhorCandidatesFromApproved,
  writeUseMelhorPostState,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import {
  freshUseMelhorCarouselSlots,
  planUseMelhorDispatch,
  planUseMelhorDispatchFrom,
} from "../scripts/lib/use-melhor-dispatch.ts";
import {
  buildUseMelhorSlides,
  hashUseMelhorSlides,
  isUseMelhorCarouselStale,
  readUseMelhorCarouselStamp,
} from "../scripts/lib/use-melhor-carousel.ts";
import { gatherUseMelhorStatusInput } from "../scripts/lib/use-melhor-status.ts";
import { checkUseMelhorPostItemRendered, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import {
  DISCONTINUED_TOPIC_MATCH,
  annotateDiscontinuedUseMelhor,
  extractDiscontinuationTopics,
  findDiscontinuedTopic,
} from "../scripts/lib/use-melhor-discontinued.ts";
import { runSelection } from "../scripts/select-use-melhor-post.ts";
import { genCarouselCards } from "../scripts/gen-carousel-cards.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ON: UseMelhorPostConfigState = { enabled: true, time: "08:00" };
const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };
const CONFIG_ON = { publishing: { social: { use_melhor_time: "08:00" } } };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-9592-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

// ── Forma real da 261005 ─────────────────────────────────────────────────────
const MODS = {
  url: "https://canaltech.com.br/inteligencia-artificial/claude-code-ganha-suporte-a-mods-veja-como-personalizar-terminal-e-mais/",
  title: "Claude Code ganha suporte a mods",
  summary: "",
  score: 62,
};
const INSTA_SOURCE_TITLE = "Prompt para foto de perfil do Instagram: 10 ideias para usar no ChatGPT";
const INSTA_URL =
  "https://www.techtudo.com.br/listas/2026/10/prompt-para-foto-de-perfil-do-instagram-10-ideias-para-usar-no-chatgpt-edsoftwares.ghtml";
const APPROVED_261005 = {
  use_melhor: [
    { url: "https://www.geeky-gadgets.com/chatgpt-tutorial-for-beginners/", title: "ChatGPT Tutorial for Beginners", summary: "", score: 43 },
    MODS,
    { url: INSTA_URL, title: INSTA_SOURCE_TITLE, summary: "", score: 60 },
  ],
};
const REVIEWED_261005 = [
  "**🛠️ USE MELHOR**",
  "",
  "**[ChatGPT Tutorial for Beginners](https://www.geeky-gadgets.com/chatgpt-tutorial-for-beginners/)**",
  "Instruções personalizadas. (15 min)",
  "",
  `**[${MODS.title}](${MODS.url})**`,
  "Mods são extensões. (4 min)",
  "",
  `**[${INSTA_SOURCE_TITLE}](${INSTA_URL})**`,
  "O passo a passo cria uma foto de perfil. (15 min)",
  "",
].join("\n");
/** Estado gravado à mão pelo editor na 261005 (título editado, selected_from próprio). */
const EDITOR_ITEM = { url: INSTA_URL, title: "Foto de perfil do Instagram com o ChatGPT", summary: "", score: 60 };
const EDITOR_STATE = {
  enabled: true,
  time: "08:00",
  item: EDITOR_ITEM,
  selected_from: "editor-override-passo-a-passo",
  generated_at: "2026-10-05T00:02:06.154Z",
};
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo.`;
const UM_TEXT = [P("Foto de perfil em três passos."), P("Envie uma foto base."), "#Instagram"].join("\n\n");

describe("#9592 — a escolha gravada vale enquanto o item estiver na edição", () => {
  it("REGRESSÃO 261005: item trocado pelo editor (score 60 < 62) segue renderizado → plano ready", () => {
    const slides = buildUseMelhorSlides(UM_TEXT, EDITOR_ITEM.title);
    const plan = planUseMelhorDispatchFrom({
      config: CONFIG_ON,
      state: EDITOR_STATE,
      reviewedMd: REVIEWED_261005,
      approved: APPROVED_261005,
      socialUm: UM_TEXT,
      stamp: { hash: hashUseMelhorSlides(slides), slots: slides.map((s) => s.slot) },
      ctaOverride: null,
    });
    assert.equal(plan.status, "ready", JSON.stringify(plan));
    if (plan.status !== "ready") return;
    assert.equal(plan.item.url, INSTA_URL);
    assert.ok(plan.slots, "carimbo gerado com o título editado continua em dia");
    assert.equal(plan.imageWarning, undefined);
  });

  it("item escolhido removido da edição → skip com o motivo", () => {
    const reviewed = REVIEWED_261005.split("\n").filter((l) => !l.includes(INSTA_URL)).join("\n");
    const plan = planUseMelhorDispatchFrom({
      config: CONFIG_ON,
      state: EDITOR_STATE,
      reviewedMd: reviewed,
      approved: APPROVED_261005,
      socialUm: UM_TEXT,
      stamp: null,
      ctaOverride: null,
    });
    assert.equal(plan.status, "skip");
    assert.match(plan.status === "skip" ? plan.reason : "", /não está mais no USE MELHOR/);
  });

  it("checkUseMelhorItemInFinal: casa por URL normalizada (www/utm/barra)", () => {
    const r = checkUseMelhorItemInFinal(
      { ...EDITOR_ITEM, url: INSTA_URL.replace("www.", "") + "?utm_source=x" },
      REVIEWED_261005,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(checkUseMelhorItemInFinal(EDITOR_ITEM, "**RADAR**\n\n[x](https://y.com)\nz\n"), {
      ok: false,
      reason: "edição sem seção USE MELHOR renderizada",
    });
  });

  it("status do gate: ok + nota ℹ️ sobre o item de score maior (não warn)", () => {
    const st = describeUseMelhorPostStatus({
      config: ON,
      state: EDITOR_STATE,
      reviewedMd: REVIEWED_261005,
      approved: APPROVED_261005,
      hasSocialSection: true,
      hasCurtoSection: true,
      carouselSlots: ["cover", "p1", "p2", "cta"],
    });
    assert.equal(st.level, "ok", st.lines.join("\n"));
    assert.ok(st.lines.some((l) => l.startsWith("   ℹ️") && l.includes(MODS.title) && l.includes("segue com o")));
  });

  it("invariante Stage 4: item fora da edição → 1 warning; dentro → nada; desligado → nada", () => {
    const dir = tmpEdition();
    writeUseMelhorPostState(dir, EDITOR_STATE);
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261005);
    assert.deepEqual(checkUseMelhorPostItemRendered(dir, ON), []);

    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261005.split("\n").filter((l) => !l.includes(INSTA_URL)).join("\n"));
    const v = checkUseMelhorPostItemRendered(dir, ON);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "use-melhor-post-item-rendered");
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /PULADO nos 5 canais/);
    assert.match(v[0].message, /select-use-melhor-post\.ts --edition-dir .* --reviewed/);
    assert.deepEqual(checkUseMelhorPostItemRendered(dir, OFF), []);
  });

  it("invariante registrada no Stage 4", () => {
    assert.ok(STAGE_4_RULES.some((r) => r.id === "use-melhor-post-item-rendered" && r.stage === 4));
  });
});

describe("#9610 — `--reviewed` não desfaz a troca manual do editor", () => {
  function edition261005(): string {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED_261005));
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261005);
    writeUseMelhorPostState(dir, EDITOR_STATE);
    return dir;
  }
  const statePath = (dir: string) => join(dir, "_internal", "use-melhor-post.json");

  it("REGRESSÃO: item escolhido (score 60) segue no USE MELHOR → preservado, arquivo intocado", () => {
    const dir = edition261005();
    const before = readFileSync(statePath(dir), "utf8");
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.preserved, true);
    assert.equal(r.written, null);
    assert.equal(r.state.item?.url, INSTA_URL);
    assert.equal(r.state.item?.title, EDITOR_ITEM.title);
    assert.equal(r.state.selected_from, "editor-override-passo-a-passo");
    assert.equal(readFileSync(statePath(dir), "utf8"), before);
  });

  it("item escolhido saiu da edição → re-seleciona pelo maior score renderizado", () => {
    const dir = edition261005();
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261005.split("\n").filter((l) => !l.includes(INSTA_URL)).join("\n"));
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.notEqual(r.preserved, true);
    assert.equal(r.state.item?.url, MODS.url);
    assert.equal(r.state.selected_from, "reviewed");
    assert.ok(r.written);
  });

  it("forceReselect: re-seleciona por score mesmo com o item escolhido na edição", () => {
    const dir = edition261005();
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.notEqual(r.preserved, true);
    assert.equal(r.state.item?.url, MODS.url);
  });
});

// ── #9599 ────────────────────────────────────────────────────────────────────
const CANALTECH_FIM_GPTS =
  "https://canaltech.com.br/inteligencia-artificial/fim-dos-gpts-personalizados-openai-vai-matar-recurso-no-chatgpt-saiba-como-salvar-o-seu/";
const PAST_EDITIONS = [
  "# Últimas edições publicadas — para dedup",
  "",
  '## 2026-09-29 — "Edição"',
  "URL: https://diariabr.kit.com/posts/x",
  "",
  "Links usados:",
  `- ${CANALTECH_FIM_GPTS}`,
  "- https://www.cnnbrasil.com.br/economia/money/inteligencia-artificial/ex-google-reforca-alerta-de-que-a-ia-pode-matar-todos-os-humanos/",
  "- https://exame.com/inteligencia-artificial/copilot-no-excel-10-tarefas-que-a-ia-consegue-fazer-por-voce/",
  "",
].join("\n");
const JOTFORM = { url: "https://www.jotform.com/ai/what-is-a-custom-gpt/", title: "What is a custom GPT? From GPT Builder to plug-ins in 2026" };

describe("#9599 — tutorial de recurso em descontinuação", () => {
  const topics = extractDiscontinuationTopics(PAST_EDITIONS);

  it("só a notícia com sinal de descontinuação vira tópico ('IA pode matar humanos' não)", () => {
    assert.deepEqual(topics.map((t) => t.url), [CANALTECH_FIM_GPTS]);
    assert.equal(topics[0].edition_date, "2026-09-29");
    assert.deepEqual([...topics[0].tokens].sort(), ["custom", "gpt"]);
  });

  it("REGRESSÃO 261005: 'What is a custom GPT?' casa o 'fim dos GPTs personalizados' (PT↔EN)", () => {
    const m = findDiscontinuedTopic(JOTFORM, topics);
    assert.ok(m);
    assert.deepEqual([...m!.shared].sort(), ["custom", "gpt"]);
  });

  it("sem falso positivo em tutorial que só compartilha marca/1 token", () => {
    for (const item of [
      { url: "https://www.geeky-gadgets.com/chatgpt-tutorial-for-beginners/", title: "ChatGPT Tutorial for Beginners to Master Prompting" },
      { url: "https://x.com/custom-instructions", title: "Como usar instruções personalizadas no ChatGPT" },
      { url: "https://y.com/gpt-5-guia", title: "Guia do GPT-5 para iniciantes" },
    ]) {
      assert.equal(findDiscontinuedTopic(item, topics), null, item.title);
    }
  });

  it("annotateDiscontinuedUseMelhor: marca só use_melhor, idempotente", () => {
    const categorized = {
      use_melhor: [{ ...JOTFORM }, { url: "https://a.com/planilhas", title: "Planilhas com IA" }] as Array<Record<string, unknown>>,
      radar: [{ ...JOTFORM }] as Array<Record<string, unknown>>,
    };
    assert.equal(annotateDiscontinuedUseMelhor(categorized as never, topics), 1);
    assert.equal(annotateDiscontinuedUseMelhor(categorized as never, topics), 0);
    const aff = categorized.use_melhor[0].audience_affinity as { matched: string[] };
    assert.deepEqual(aff.matched, [DISCONTINUED_TOPIC_MATCH]);
    assert.equal(categorized.use_melhor[1].audience_affinity, undefined);
    assert.equal(categorized.radar[0].audience_affinity, undefined);
  });

  it("seleção do 4º post pula o tutorial descontinuado e registra o motivo", () => {
    const dir = tmpEdition();
    writeFileSync(
      join(dir, "_internal", "01-approved-capped.json"),
      JSON.stringify({
        use_melhor: [
          { ...JOTFORM, summary: "", score: 70 },
          { url: "https://exame.com/planilhas", title: "Planilhas com IA", summary: "", score: 50 },
        ],
      }),
    );
    const { state } = runSelection(dir, ON, { discontinuationTopics: topics });
    assert.equal(state.item?.url, "https://exame.com/planilhas");
    assert.equal(state.excluded?.length, 1);
    assert.match(state.excluded![0].reason, /descontinuação.*2026-09-29/);
  });

  it("todos excluídos → item null com motivo (fail-soft)", () => {
    const sel = selectUseMelhorItem(
      useMelhorCandidatesFromApproved({ use_melhor: [{ ...JOTFORM, summary: "", score: 70 }] }),
      null,
      { exclude: () => "x" },
    );
    assert.equal(sel.item, null);
    assert.match(sel.reason ?? "", /excluídos/);
  });

  it("scorer.md e scorer-chunk.md aplicam a penalidade da marca", () => {
    for (const f of [".claude/agents/scorer.md", ".claude/agents/scorer-chunk.md"]) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      assert.ok(src.includes(`"${DISCONTINUED_TOPIC_MATCH}"`), f);
      assert.match(src, /−25 pontos/, f);
    }
  });
});

// ── #9600 ────────────────────────────────────────────────────────────────────
describe("#9600 — título da capa do carrossel do 4º post", () => {
  const JOT_ITEM = { url: JOTFORM.url, title: JOTFORM.title, summary: "", score: 45 };
  const APPROVED_JOT = { use_melhor: [JOT_ITEM] };
  const REVIEWED_PT = `**USE MELHOR**\n\n**[O que é um GPT personalizado](${JOTFORM.url})**\nDescrição. (5 min)\n`;

  it("usa o título do item no 02-reviewed.md (o que o leitor vê), não o da fonte", () => {
    assert.equal(
      resolveUseMelhorCoverTitle(JOT_ITEM, { reviewedMd: REVIEWED_PT, approved: APPROVED_JOT }),
      "O que é um GPT personalizado",
    );
  });

  it("cover_title manual vence tudo", () => {
    assert.equal(
      resolveUseMelhorCoverTitle({ ...JOT_ITEM, cover_title: "  Seu GPT, sem mistério " }, { reviewedMd: REVIEWED_PT, approved: APPROVED_JOT }),
      "Seu GPT, sem mistério",
    );
  });

  it("título editado à mão no estado (contorno da 261005) vence o do 02-reviewed", () => {
    assert.equal(
      resolveUseMelhorCoverTitle(EDITOR_ITEM, { reviewedMd: REVIEWED_261005, approved: APPROVED_261005 }),
      EDITOR_ITEM.title,
    );
  });

  it("sem 02-reviewed / item fora dele → título do item", () => {
    assert.equal(resolveUseMelhorCoverTitle(JOT_ITEM, { reviewedMd: null, approved: null }), JOTFORM.title);
    assert.equal(resolveUseMelhorCoverTitle(JOT_ITEM, { reviewedMd: REVIEWED_261005, approved: APPROVED_JOT }), JOTFORM.title);
  });

  it("Stage 3 renderiza a capa com o título resolvido (não o da fonte em inglês)", async () => {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED_JOT));
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_PT);
    writeUseMelhorPostState(dir, { enabled: true, time: "08:00", item: JOT_ITEM, generated_at: "x" });
    const D = [P("Primeiro."), P("Segundo."), P("Terceiro."), "#IA"].join("\n\n");
    writeFileSync(
      join(dir, "03-social.md"),
      ["# Social", "", "## d1", "", D, "", "## d2", "", D, "", "## d3", "", D, "", "## um", "", UM_TEXT, "", "# Curto", "", "## d1", "", "x", ""].join("\n"),
    );
    let coverTitle = "";
    await genCarouselCards(dir, {
      render: (async (_t: string, outPaths: Record<string, string>) => {
        for (const p of Object.values(outPaths)) writeFileSync(p, "x");
        return outPaths;
      }) as never,
      useMelhorConfig: ON,
      renderUseMelhor: async (_d, slides) => {
        coverTitle = String(slides.find((s) => s.slot === "cover")?.text.title ?? "");
        return [];
      },
    });
    assert.equal(coverTitle, "O que é um GPT personalizado");
  });
});

// ── #9630 ────────────────────────────────────────────────────────────────────
describe("#9630 — título editado no gate 4 não invalida o carimbo do 4º post", () => {
  const JOT_ITEM = { url: JOTFORM.url, title: JOTFORM.title, summary: "", score: 45 };
  const APPROVED_JOT = { use_melhor: [JOT_ITEM] };
  const reviewedWith = (t: string) => `**USE MELHOR**\n\n**[${t}](${JOTFORM.url})**\nDescrição. (5 min)\n`;
  const D = [P("Primeiro."), P("Segundo."), P("Terceiro."), "#IA"].join("\n\n");
  const socialWith = (um: string) =>
    ["# Social", "", "## d1", "", D, "", "## d2", "", D, "", "## d3", "", D, "", "## um", "", um, "", "# Curto", "", "## d1", "", "x", "", "## um", "", "curto", ""].join("\n");

  async function stage3(dir: string): Promise<void> {
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED_JOT));
    writeFileSync(join(dir, "02-reviewed.md"), reviewedWith("O que é um GPT personalizado"));
    writeUseMelhorPostState(dir, { enabled: true, time: "08:00", item: JOT_ITEM, generated_at: "x" });
    writeFileSync(join(dir, "03-social.md"), socialWith(UM_TEXT));
    await genCarouselCards(dir, {
      render: (async (_t: string, outPaths: Record<string, string>) => {
        for (const p of Object.values(outPaths)) writeFileSync(p, "x");
        return outPaths;
      }) as never,
      useMelhorConfig: ON,
      renderUseMelhor: async (d, slides) => {
        for (const s of slides) writeFileSync(join(d, `04-um-carousel-${s.slot}-4x5.jpg`), "x");
        return [];
      },
    });
  }

  it("Stage 3 grava no carimbo o título da capa usado no render", async () => {
    const dir = tmpEdition();
    await stage3(dir);
    assert.equal(readUseMelhorCarouselStamp(dir)?.cover_title, "O que é um GPT personalizado");
  });

  it("REGRESSÃO: título editado em 02-reviewed.md depois do Stage 3 → carrossel segue valendo (Stages 4/5)", async () => {
    const dir = tmpEdition();
    await stage3(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewedWith("Como criar um GPT personalizado"));
    const plan = planUseMelhorDispatch(dir, CONFIG_ON);
    assert.equal(plan.status, "ready", JSON.stringify(plan));
    if (plan.status !== "ready") return;
    assert.equal(plan.imageWarning, undefined);
    assert.deepEqual(plan.slots, readUseMelhorCarouselStamp(dir)?.slots);
    assert.ok(freshUseMelhorCarouselSlots(dir).length > 0, "upload ainda sobe os slides");
    assert.equal(gatherUseMelhorStatusInput(dir, ON).carouselStale, false);
  });

  it("`## um` editado depois do Stage 3 → continua defasado", async () => {
    const dir = tmpEdition();
    await stage3(dir);
    writeFileSync(join(dir, "03-social.md"), socialWith(UM_TEXT.replace("três passos", "quatro passos")));
    const plan = planUseMelhorDispatch(dir, CONFIG_ON);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    assert.equal(plan.slots, null);
    assert.match(plan.imageWarning ?? "", /DEFASADO/);
    assert.deepEqual(freshUseMelhorCarouselSlots(dir), []);
    assert.equal(gatherUseMelhorStatusInput(dir, ON).carouselStale, true);
  });

  it("compat: carimbo antigo sem cover_title → título recalculado (comportamento anterior)", () => {
    const slides = buildUseMelhorSlides(UM_TEXT, "Título antigo");
    const legacy = { hash: hashUseMelhorSlides(slides), slots: slides.map((s) => s.slot) };
    assert.equal(isUseMelhorCarouselStale(legacy, UM_TEXT, "Título antigo"), false);
    assert.equal(isUseMelhorCarouselStale(legacy, UM_TEXT, "Título novo"), true);
    assert.equal(isUseMelhorCarouselStale({ ...legacy, cover_title: "Título antigo" }, UM_TEXT, "Título novo"), false);
  });

  it("re-rodar o Stage 3 sem mudança completa o cover_title de carimbo antigo sem re-renderizar", async () => {
    const dir = tmpEdition();
    await stage3(dir);
    const { cover_title: _omit, ...legacy } = readUseMelhorCarouselStamp(dir)!;
    writeFileSync(join(dir, "_internal", ".use-melhor-carousel-hash.json"), JSON.stringify(legacy));
    let rendered = false;
    await genCarouselCards(dir, {
      render: (async (_t: string, o: Record<string, string>) => o) as never,
      useMelhorConfig: ON,
      renderUseMelhor: async () => {
        rendered = true;
        return [];
      },
    });
    assert.equal(rendered, false);
    assert.equal(readUseMelhorCarouselStamp(dir)?.cover_title, "O que é um GPT personalizado");
  });
});
