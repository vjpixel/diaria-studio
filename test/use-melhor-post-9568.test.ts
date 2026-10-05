/**
 * test/use-melhor-post-9568.test.ts (#9568)
 *
 * 4º post social diário (item de maior score do USE MELHOR). Cobre:
 *   - a feature é INERTE enquanto `publishing.social.use_melhor_time` não
 *     estiver definido — inclusive no `platform.config.json` do repo;
 *   - com ela desligada, o fluxo de D1/D2/D3 é idêntico (gen-carousel-cards
 *     não ganha campo novo nem chama render extra; invariante de overflow não
 *     muda; preview sem aviso continua byte-a-byte igual);
 *   - seleção (maior score, só renderizados, item colado à mão inelegível);
 *   - carrossel de N slides variável + tudo-ou-nada;
 *   - fail-soft (sem item / sem `## um` / overflow → skipped, nunca lança).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  USE_MELHOR_DISABLED_LABEL,
  USE_MELHOR_POST_ID,
  computeStage2UseMelhorPostState,
  describeUseMelhorPostStatus,
  loadUseMelhorPostConfigState,
  normalizeUseMelhorUrl,
  renderedUseMelhorUrls,
  selectUseMelhorItem,
  useMelhorCandidatesFromApproved,
  useMelhorPostConfigState,
  useMelhorPostStatePath,
  withUseMelhorUtm,
  writeUseMelhorPostState,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import {
  USE_MELHOR_MAX_PARAGRAPH_SLIDES,
  buildUseMelhorSlides,
  findOverflowingUseMelhorSlides,
  lintUseMelhorPostText,
  removeStaleUseMelhorSlides,
  resolveUseMelhorCarouselImageUrls,
  useMelhorSlideFilename,
} from "../scripts/lib/use-melhor-carousel.ts";
import { gatherUseMelhorStatusInput } from "../scripts/lib/use-melhor-status.ts";
import { genCarouselCards } from "../scripts/gen-carousel-cards.ts";
import { checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";
import { runSelection } from "../scripts/select-use-melhor-post.ts";
import { parsePlatforms, buildSocialHtml, groupByDestaque } from "../scripts/render-social-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ON: UseMelhorPostConfigState = { enabled: true, time: "19:00" };
const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: USE_MELHOR_DISABLED_LABEL };

const P = (s: string) => `${s} **Trecho curto em negrito.** Fim do parágrafo.`;
const TEXTO_D = [P("Primeiro parágrafo do destaque."), P("Segundo parágrafo."), P("Terceiro parágrafo."), "#InteligenciaArtificial"].join("\n\n");
const TEXTO_UM = [P("Um guia prático para planilhas."), P("Como pedir fórmulas."), "#InteligenciaArtificial #Planilhas"].join("\n\n");

const APPROVED = {
  highlights: [{}, {}, {}],
  use_melhor: [
    { url: "https://exame.com/a/", title: "Guia A", summary: "Resumo A", score: 70 },
    { url: "https://www.fast.com/b?utm_source=x", title: "Guia B", summary: "Resumo B", score: 83 },
    { url: "https://c.com/c", title: "Guia C", summary: "Resumo C", score: 60 },
    { url: "https://sem-score.com/d", title: "Sem score", summary: "" },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEdition(opts: { um?: boolean; curtoUm?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-9568-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED));
  const social = [
    "# Social",
    "",
    "## d1",
    "",
    TEXTO_D,
    "",
    "## d2",
    "",
    TEXTO_D,
    "",
    "## d3",
    "",
    TEXTO_D,
    ...(opts.um ? ["", "## um", "", TEXTO_UM] : []),
    "",
    "## post_pixel",
    "",
    "Post pessoal.",
    "",
    "# Curto",
    "",
    "## d1",
    "",
    "Curto 1 {edition_url} #A",
    ...(opts.curtoUm ? ["", "## um", "", "Curto um {edition_url} #B"] : []),
    "",
  ].join("\n");
  writeFileSync(join(dir, "03-social.md"), social, "utf8");
  return dir;
}

describe("config: use_melhor_time (#9568)", () => {
  it("ausente / null / vazio → desligado com o rótulo do gate", () => {
    for (const v of [undefined, null, ""]) {
      const s = useMelhorPostConfigState({ publishing: { social: { use_melhor_time: v } } });
      assert.equal(s.enabled, false);
      assert.equal(s.reason, USE_MELHOR_DISABLED_LABEL);
    }
    assert.equal(useMelhorPostConfigState({}).enabled, false);
    assert.equal(useMelhorPostConfigState(null).enabled, false);
  });

  it("platform.config.json do repo: feature LIGADA às 07:45 BRT (decisão do editor, 05/10/2026)", () => {
    const s = loadUseMelhorPostConfigState(ROOT);
    assert.deepEqual(s, { enabled: true, time: "07:45" });
  });

  it("formato inválido → desligado (fail-soft, nunca lança)", () => {
    for (const v of ["7pm", "25:00", "9:00", 1900]) {
      const s = useMelhorPostConfigState({ publishing: { social: { use_melhor_time: v } } });
      assert.equal(s.enabled, false, String(v));
      assert.match(s.reason!, /inválido/);
    }
  });

  it("colisão com slot de destaque → desligado", () => {
    const s = useMelhorPostConfigState({
      publishing: { social: { use_melhor_time: "12:30", fallback_schedule: { d1_time: "10:00", d2_time: "12:30" } } },
    });
    assert.equal(s.enabled, false);
    assert.match(s.reason!, /colide com fallback_schedule\.d2_time/);
  });

  it("HH:MM válido fora dos slots → ligado", () => {
    assert.deepEqual(useMelhorPostConfigState({ publishing: { social: { use_melhor_time: "19:00" } } }), {
      enabled: true,
      time: "19:00",
    });
  });
});

describe("seleção do item (#9568)", () => {
  const cands = useMelhorCandidatesFromApproved(APPROVED);

  it("item sem score não é candidato", () => {
    assert.deepEqual(
      cands.map((c) => c.title),
      ["Guia A", "Guia B", "Guia C"],
    );
  });

  it("Stage 2 (sem 02-reviewed.md): maior score do JSON aprovado", () => {
    const s = selectUseMelhorItem(cands, null);
    assert.equal(s.item?.title, "Guia B");
    assert.equal(s.selected_from, "approved");
  });

  it("edição final: só os renderizados contam (editor removeu o de maior score)", () => {
    const s = selectUseMelhorItem(cands, ["https://exame.com/a", "https://c.com/c"]);
    assert.equal(s.item?.title, "Guia A");
    assert.equal(s.selected_from, "reviewed");
  });

  it("casa URL com www/utm/barra final", () => {
    const s = selectUseMelhorItem(cands, ["https://fast.com/b/"]);
    assert.equal(s.item?.title, "Guia B");
    assert.equal(normalizeUseMelhorUrl("https://WWW.Fast.com/b/?utm_source=x#y"), "fast.com/b");
  });

  it("item colado à mão (sem score no JSON) → nenhum elegível, com motivo", () => {
    const s = selectUseMelhorItem(cands, ["https://outro.com/manual"]);
    assert.equal(s.item, null);
    assert.match(s.reason!, /colados à mão/);
  });

  it("sem seção USE MELHOR renderizada → item null (fail-soft)", () => {
    const s = selectUseMelhorItem(cands, []);
    assert.equal(s.item, null);
    assert.match(s.reason!, /sem seção USE MELHOR/);
  });

  it("empate de score: vence o que aparece primeiro", () => {
    const tie = [
      { url: "https://x.com/1", title: "1", summary: "", score: 50 },
      { url: "https://x.com/2", title: "2", summary: "", score: 50 },
    ];
    assert.equal(selectUseMelhorItem(tie, ["https://x.com/2", "https://x.com/1"]).item?.title, "2");
  });

  it("renderedUseMelhorUrls lê a seção do 02-reviewed.md", () => {
    const md = [
      "**🛠️ USE MELHOR**",
      "",
      "**[Guia A](https://exame.com/a/)**",
      "Descrição A (10 min)",
      "",
      "---",
      "",
      "**📡 RADAR**",
      "",
      "**[R](https://r.com/)**",
      "Descrição R",
    ].join("\n");
    assert.deepEqual(renderedUseMelhorUrls(md), ["https://exame.com/a/"]);
    assert.deepEqual(renderedUseMelhorUrls("sem nada"), []);
  });

  it("withUseMelhorUtm aplica utm_content=usemelhor", () => {
    assert.equal(withUseMelhorUtm("https://diar.ia.br/p/x?utm_content=d1"), "https://diar.ia.br/p/x?utm_content=usemelhor");
  });
});

describe("Stage 2: seleção grava estado só quando ligado (#9568)", () => {
  it("desligado → NÃO grava _internal/use-melhor-post.json", () => {
    const dir = makeEdition();
    const { state, written } = runSelection(dir, OFF, { discontinuationTopics: [] });
    assert.equal(state.enabled, false);
    assert.equal(written, null);
    assert.equal(existsSync(useMelhorPostStatePath(dir)), false);
  });

  it("ligado → grava o item de maior score", () => {
    const dir = makeEdition();
    const { state, written } = runSelection(dir, ON, { discontinuationTopics: [] });
    assert.equal(state.item?.title, "Guia B");
    assert.equal(written, useMelhorPostStatePath(dir));
    assert.equal(JSON.parse(readFileSync(written!, "utf8")).item.url, "https://www.fast.com/b?utm_source=x");
  });

  it("ligado sem JSON aprovado → item null com motivo (não lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-9568-"));
    dirs.push(dir);
    const s = computeStage2UseMelhorPostState(dir, ON);
    assert.equal(s.item, null);
    assert.match(s.reason!, /ausente/);
  });
});

describe("carrossel de N slides (#9568)", () => {
  it("capa + N parágrafos + CTA, N = parágrafos do texto", () => {
    assert.deepEqual(
      buildUseMelhorSlides(TEXTO_UM, "Guia B").map((s) => s.slot),
      ["cover", "p1", "p2", "cta"],
    );
    const cinco = [1, 2, 3, 4, 5].map((i) => P(`Parágrafo ${i}.`)).join("\n\n");
    assert.deepEqual(
      buildUseMelhorSlides(cinco, "T").map((s) => s.slot),
      ["cover", "p1", "p2", "p3", "p4", "p5", "cta"],
    );
  });

  it("teto de parágrafos: excedente é fundido no último slide, nunca descartado", () => {
    const muitos = Array.from({ length: 12 }, (_, i) => `Frase ${i + 1}.`).join("\n\n");
    const slides = buildUseMelhorSlides(muitos, "T");
    assert.equal(slides.length, USE_MELHOR_MAX_PARAGRAPH_SLIDES + 2);
    assert.match(slides[slides.length - 2].text.title, /Frase 12\./);
  });

  it("capa usa o título do item; corpo vazio → nenhum slide", () => {
    const slides = buildUseMelhorSlides(TEXTO_UM, "Guia B");
    assert.equal(slides[0].text.kicker, "USE MELHOR");
    assert.equal(slides[0].text.title, "Guia B");
    assert.deepEqual(buildUseMelhorSlides("#SoHashtag", "T"), []);
  });

  it("overflow detectado por slide", () => {
    assert.deepEqual(findOverflowingUseMelhorSlides(TEXTO_UM, "Guia B"), []);
    const enorme = "palavra ".repeat(200).trim() + ".";
    const ov = findOverflowingUseMelhorSlides(`${enorme}\n\n${P("ok")}`, "Guia B");
    assert.deepEqual(ov.map((o) => o.slot), ["p1"]);
  });

  it("URLs públicas: tudo-ou-nada", () => {
    const slots = ["cover", "p1", "p2", "cta"];
    const images = Object.fromEntries(slots.map((s) => [`um_carousel_${s}`, { url: `https://k/${s}` }]));
    assert.deepEqual(resolveUseMelhorCarouselImageUrls(images, slots), slots.map((s) => `https://k/${s}`));
    const { um_carousel_p2: _omit, ...faltando } = images;
    assert.equal(resolveUseMelhorCarouselImageUrls(faltando, slots), null);
    assert.equal(resolveUseMelhorCarouselImageUrls(images, ["cover", "cta"]), null);
  });
});

describe("Stage 3: gen-carousel-cards (#9568)", () => {
  const fakeRender = async (_t: string, outPaths: Record<string, string>) => {
    for (const p of Object.values(outPaths)) writeFileSync(p, "x");
    return outPaths as never;
  };

  it("REGRESSÃO: desligado → resultado sem `use_melhor`, nenhum render extra, nenhum arquivo do 4º post", async () => {
    const dir = makeEdition({ um: true });
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: { url: "u", title: "Guia B", summary: "", score: 83 }, generated_at: "x" });
    let umCalls = 0;
    const result = await genCarouselCards(dir, {
      render: fakeRender,
      useMelhorConfig: OFF,
      renderUseMelhor: async () => {
        umCalls++;
        return [];
      },
    });
    assert.equal("use_melhor" in result, false);
    assert.equal(umCalls, 0);
    assert.equal(result.generated.length, 12, "d1/d2/d3 × 4 slides, como sempre");
    assert.equal(existsSync(join(dir, useMelhorSlideFilename("cover"))), false);
  });

  it("ligado + item + `## um` → gera capa + N + CTA", async () => {
    const dir = makeEdition({ um: true });
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: { url: "u", title: "Guia B", summary: "", score: 83 }, generated_at: "x" });
    let rendered: string[] = [];
    const result = await genCarouselCards(dir, {
      render: fakeRender,
      useMelhorConfig: ON,
      renderUseMelhor: async (d, slides) => {
        rendered = slides.map((s) => s.slot);
        return slides.map((s) => {
          const p = join(d, useMelhorSlideFilename(s.slot));
          writeFileSync(p, "x");
          return p;
        });
      },
    });
    assert.deepEqual(rendered, ["cover", "p1", "p2", "cta"]);
    assert.equal(result.use_melhor?.status, "generated");
    assert.equal(result.generated.length, 12 + 4);
    // 2ª passada sem mudança de texto → unchanged (idempotência por conteúdo)
    const again = await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON, renderUseMelhor: async () => { throw new Error("não deveria renderizar"); } });
    assert.equal(again.use_melhor?.status, "unchanged");
  });

  it("ligado sem `## um` → skipped com motivo, sem lançar", async () => {
    const dir = makeEdition({ um: false });
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: { url: "u", title: "Guia B", summary: "", score: 83 }, generated_at: "x" });
    const result = await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON });
    assert.equal(result.use_melhor?.status, "skipped");
    assert.match(result.use_melhor!.reason!, /## um/);
  });

  it("ligado sem estado do Stage 2 → skipped", async () => {
    const dir = makeEdition({ um: true });
    const result = await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON });
    assert.equal(result.use_melhor?.status, "skipped");
  });

  it("overflow no `## um` → skipped (fail-soft), nunca o throw bloqueante dos destaques", async () => {
    const dir = makeEdition();
    const social = readFileSync(join(dir, "03-social.md"), "utf8").replace(
      "## post_pixel",
      `## um\n\n${"palavra ".repeat(200).trim()}.\n\n## post_pixel`,
    );
    writeFileSync(join(dir, "03-social.md"), social);
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: { url: "u", title: "Guia B", summary: "", score: 83 }, generated_at: "x" });
    const result = await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON });
    assert.equal(result.use_melhor?.status, "skipped");
    assert.match(result.use_melhor!.reason!, /não cabem/);
  });
});

describe("invariante carousel-text-overflow cobre o `## um` só quando ligado (#9568)", () => {
  function overflowingEdition(): string {
    const dir = makeEdition();
    const social = readFileSync(join(dir, "03-social.md"), "utf8").replace(
      "## post_pixel",
      `## um\n\n${"palavra ".repeat(200).trim()}.\n\n## post_pixel`,
    );
    writeFileSync(join(dir, "03-social.md"), social);
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: { url: "u", title: "Guia B", summary: "", score: 83 }, generated_at: "x" });
    return dir;
  }

  it("desligado → nenhuma violação nova", () => {
    assert.deepEqual(checkCarouselTextOverflow(overflowingEdition(), OFF), []);
  });

  it("default (config do repo, ligado às 08:00 desde a #9568 Stage 5) → mesmo resultado que ligado", () => {
    const viaRepo = checkCarouselTextOverflow(overflowingEdition()).map((v) => v.rule).sort();
    const viaOn = checkCarouselTextOverflow(overflowingEdition(), ON).map((v) => v.rule).sort();
    assert.deepEqual(viaRepo, viaOn);
    assert.ok(viaRepo.includes("carousel-text-overflow"));
  });

  it("ligado → warning (nunca error)", () => {
    // O texto de overflow tem 1 parágrafo só → também cai no `use-melhor-um-shape` (warning).
    const all = checkCarouselTextOverflow(overflowingEdition(), ON);
    assert.ok(all.every((x) => x.severity === "warning"));
    const v = all.filter((x) => x.rule === "carousel-text-overflow");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.equal(v[0].source_issue, "#9568");
  });
});

describe("Stage 4: status do gate (#9568)", () => {
  it("desligado → exatamente a linha '4º post desligado'", () => {
    const st = describeUseMelhorPostStatus({
      config: OFF,
      state: null,
      reviewedMd: null,
      approved: null,
      hasSocialSection: false,
      hasCurtoSection: false,
      carouselSlots: null,
    });
    assert.equal(st.level, "off");
    assert.deepEqual(st.lines, ["4º post desligado (use_melhor_time não definido)"]);
  });

  it("ligado, sem item elegível → warn com motivo (não bloqueia)", () => {
    const st = describeUseMelhorPostStatus({
      config: ON,
      state: { enabled: true, time: "19:00", item: null, reason: "edição sem item USE MELHOR com score", generated_at: "x" },
      reviewedMd: null,
      approved: null,
      hasSocialSection: false,
      hasCurtoSection: false,
      carouselSlots: null,
    });
    assert.equal(st.level, "warn");
    assert.match(st.lines[0], /PULADO: edição sem item/);
  });

  it("ligado, editor tirou o item no gate → warn: 4º post será pulado (#9592)", () => {
    const reviewed = "**🛠️ USE MELHOR**\n\n**[Guia A](https://exame.com/a/)**\nDescrição (5 min)\n";
    const st = describeUseMelhorPostStatus({
      config: ON,
      state: {
        enabled: true,
        time: "19:00",
        item: { url: "https://www.fast.com/b", title: "Guia B", summary: "", score: 83 },
        generated_at: "x",
      },
      reviewedMd: reviewed,
      approved: APPROVED,
      hasSocialSection: true,
      hasCurtoSection: true,
      carouselSlots: ["cover", "p1", "cta"],
    });
    assert.equal(st.level, "warn");
    assert.ok(st.lines.some((l) => l.includes("não está mais no USE MELHOR") && l.includes("será pulado")), st.lines.join("\n"));
  });

  it("ligado e consistente → ok + carrossel listado", () => {
    const st = describeUseMelhorPostStatus({
      config: ON,
      state: { enabled: true, time: "19:00", item: { url: "https://exame.com/a", title: "Guia A", summary: "", score: 70 }, generated_at: "x" },
      reviewedMd: "**🛠️ USE MELHOR**\n\n**[Guia A](https://exame.com/a/)**\nDescrição (5 min)\n",
      approved: APPROVED,
      hasSocialSection: true,
      hasCurtoSection: true,
      carouselSlots: ["cover", "p1", "p2", "cta"],
    });
    assert.equal(st.level, "ok");
    assert.match(st.lines[0], /às 19:00 BRT: "Guia A" \(score 70\)/);
    assert.ok(st.lines.some((l) => l.includes("4 slides")));
  });
});

describe("preview social (#9568)", () => {
  const md = [
    "# Social",
    "",
    "## d1",
    "",
    "Texto d1.",
    "",
    `## ${USE_MELHOR_POST_ID}`,
    "",
    "Texto um.",
    "",
    "## post_pixel",
    "",
    "Pessoal.",
    "",
  ].join("\n");

  it("REGRESSÃO: sem aviso → HTML idêntico ao da assinatura antiga (sem bloco novo)", () => {
    const platforms = parsePlatforms("# Social\n\n## d1\n\nTexto d1.\n");
    const antigo = buildSocialHtml(platforms, {}, "1");
    const novo = buildSocialHtml(parsePlatforms("# Social\n\n## d1\n\nTexto d1.\n"), {}, "1", undefined, undefined);
    assert.equal(novo, antigo);
    assert.equal(antigo.includes("use-melhor-notice"), false);
  });

  it("aviso '4º post desligado' aparece no topo quando passado", () => {
    const html = buildSocialHtml(parsePlatforms(md), {}, "1", undefined, [USE_MELHOR_DISABLED_LABEL]);
    assert.ok(html.includes("4º post desligado (use_melhor_time não definido)"));
  });

  it("`## um` vira grupo próprio entre os destaques e o post_pixel, com carrossel N slides", () => {
    const images = Object.fromEntries(
      ["cover", "p1", "p2", "cta"].map((s) => [`um_carousel_${s}`, { url: `https://k/${s}.jpg` }]),
    );
    const groups = groupByDestaque(parsePlatforms(md), images);
    assert.deepEqual(groups.map((g) => g.key), ["d1", "um", "post_pixel"]);
    const um = groups[1];
    assert.equal(um.label, "4º POST — USE MELHOR");
    assert.equal(um.imageUrl, "https://k/cover.jpg");
    assert.deepEqual(um.carouselImages?.map((s) => s.label), ["1/4 · Capa", "2/4", "3/4", "4/4 · CTA"]);
  });
});

describe("self-review #9572 — follow-ups do 4º post", () => {
  const fakeRender = async (_t: string, outPaths: Record<string, string>) => {
    for (const p of Object.values(outPaths)) writeFileSync(p, "x");
    return outPaths as never;
  };
  const writingRenderUm = async (d: string, slides: { slot: string }[]) =>
    slides.map((s) => {
      const p = join(d, useMelhorSlideFilename(s.slot));
      writeFileSync(p, "x");
      return p;
    });
  const STATE_ITEM = { url: "u", title: "Guia B", summary: "", score: 83 };

  function setUm(dir: string, text: string): void {
    const social = readFileSync(join(dir, "03-social.md"), "utf8");
    const next = social.replace(/## um\n\n[\s\S]*?\n\n## post_pixel/, `## um\n\n${text}\n\n## post_pixel`);
    assert.notEqual(next, social, "fixture: bloco `## um` deveria existir");
    writeFileSync(join(dir, "03-social.md"), next);
  }

  it("finding 1: `## um` editado depois do Stage 3 → status avisa carrossel DEFASADO", async () => {
    const dir = makeEdition({ um: true, curtoUm: true });
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: STATE_ITEM, generated_at: "x" });
    await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON, renderUseMelhor: writingRenderUm });
    const fresh = gatherUseMelhorStatusInput(dir, ON);
    assert.equal(fresh.carouselStale, false);
    assert.ok(!describeUseMelhorPostStatus(fresh).lines.some((l) => l.includes("DEFASADO")));

    setUm(dir, [P("Texto reescrito no painel."), P("Segundo novo.")].join("\n\n"));
    const stale = gatherUseMelhorStatusInput(dir, ON);
    assert.equal(stale.carouselStale, true);
    const st = describeUseMelhorPostStatus(stale);
    assert.equal(st.level, "warn");
    assert.ok(st.lines.some((l) => l.includes("DEFASADO")));
  });

  it("finding 1: desligado → carouselStale nunca calculado (inerte)", () => {
    const dir = makeEdition({ um: true });
    assert.equal(gatherUseMelhorStatusInput(dir, OFF).carouselStale, false);
  });

  it("findings 2/3: `## um` encolhe → gen apaga o p{k} excedente do render anterior", async () => {
    const dir = makeEdition({ um: true });
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: STATE_ITEM, generated_at: "x" });
    setUm(dir, [P("Um."), P("Dois."), P("Três."), "#Tag"].join("\n\n"));
    await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON, renderUseMelhor: writingRenderUm });
    assert.ok(existsSync(join(dir, useMelhorSlideFilename("p3"))));

    setUm(dir, [P("Um."), P("Dois."), "#Tag"].join("\n\n"));
    const r = await genCarouselCards(dir, { render: fakeRender, useMelhorConfig: ON, renderUseMelhor: writingRenderUm });
    assert.deepEqual(r.use_melhor?.slots, ["cover", "p1", "p2", "cta"]);
    assert.equal(existsSync(join(dir, useMelhorSlideFilename("p3"))), false, "slide fantasma removido");
    assert.ok(existsSync(join(dir, useMelhorSlideFilename("p2"))));
  });

  it("findings 2/3: removeStaleUseMelhorSlides só toca arquivos do 4º post fora dos slots", () => {
    const dir = makeEdition();
    for (const f of [useMelhorSlideFilename("p4"), useMelhorSlideFilename("p1"), "04-d1-carousel-p1-4x5.jpg"]) {
      writeFileSync(join(dir, f), "x");
    }
    const removed = removeStaleUseMelhorSlides(dir, ["cover", "p1", "cta"]);
    assert.deepEqual(removed, [useMelhorSlideFilename("p4")]);
    assert.ok(existsSync(join(dir, "04-d1-carousel-p1-4x5.jpg")));
  });

  it("finding 4: override de teste do CTA (#8681) chega ao slide CTA do 4º post", () => {
    const slides = buildUseMelhorSlides(TEXTO_UM, "Guia", { kicker: "TESTE", title: "CTA de teste" });
    const cta = slides[slides.length - 1];
    assert.equal(cta.slot, "cta");
    assert.equal(cta.text.title, "CTA de teste");
    assert.notEqual(buildUseMelhorSlides(TEXTO_UM, "Guia").at(-1)!.text.title, "CTA de teste");
  });

  it("finding 6: lint de forma do `## um` (nº de parágrafos, channel-neutral, pergunta no fim)", () => {
    assert.deepEqual(lintUseMelhorPostText(TEXTO_UM), []);
    assert.match(lintUseMelhorPostText(P("Só um parágrafo."))[0], /1 parágrafo/);
    const sete = Array.from({ length: 7 }, (_, i) => P(`Parágrafo ${i}.`)).join("\n\n");
    assert.match(lintUseMelhorPostText(sete).join(" "), /7 parágrafo/);
    assert.match(lintUseMelhorPostText([P("Veja em https://x.com."), P("Dois.")].join("\n\n")).join(" "), /URL/);
    assert.match(lintUseMelhorPostText([P("Assine a diar.ia.br."), P("Dois.")].join("\n\n")).join(" "), /CTA de canal/);
    assert.match(lintUseMelhorPostText([P("Um."), "E você, já testou?"].join("\n\n")).join(" "), /pergunta/);
  });

  it("finding 6: invariante emite `use-melhor-um-shape` (warning) só quando ligado", () => {
    const dir = makeEdition({ um: true });
    setUm(dir, P("Só um parágrafo."));
    writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item: STATE_ITEM, generated_at: "x" });
    assert.deepEqual(checkCarouselTextOverflow(dir, OFF), []);
    const v = checkCarouselTextOverflow(dir, ON).filter((x) => x.rule === "use-melhor-um-shape");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
  });
});
