/**
 * test/linkedin-weekly-video-section-12777.test.ts (#12777)
 *
 * Newsletter semanal do LinkedIn: o vídeo mais assistido da semana ganha seção
 * própria ("Vídeo da semana") logo depois da manchete que ele comenta, com o
 * link no TEXTO (o LinkedIn não linka imagem) e sem `<img>` no HTML colado. A
 * linha única antes do fecho (#12081) saiu. A CLI copia a imagem sem overlay
 * da edição do vídeo para o editor subir à mão. A auditoria pós-paste desconta
 * o auto-link do LinkedIn sobre "diar.ia.br" em texto puro (a frase da seção
 * tem uma menção), senão o Passo 8c pararia a skill toda semana com vídeo.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderLinkedinWeeklyHtml,
  videoSectionHeadlineIndex,
  LINKEDIN_WEEKLY_VIDEO_HEADING,
  LINKEDIN_WEEKLY_VIDEO_LINK_TEXT,
  LINKEDIN_WEEKLY_VIDEO_TAIL,
  type WeeklyLinkedinRenderInput,
} from "../scripts/lib/weekly-linkedin-render.ts";
import {
  auditLinkedinPaste,
  countUnlinkedWordmarkMentions,
  extractAnchorsFromHtml,
  isExpectedWordmarkAutoLink,
  stripHtmlToText,
} from "../scripts/lib/linkedin-paste-audit.ts";
import { main, VIDEO_IMAGE_FILENAME } from "../scripts/render-linkedin-weekly.ts";

const VIDEO_URL = "https://youtu.be/bbbbbbbbbbb";

function input(extra: Partial<WeeklyLinkedinRenderInput> = {}): WeeklyLinkedinRenderInput {
  return {
    cycle: "26w45",
    headlines: [
      { title: "Golpe da selfie", body: "Corpo 1.", why: "Porque 1.", editionDate: "261103" },
      { title: "Google paga para sair", body: "Corpo 2.", why: "Porque 2.", editionDate: "261104" },
      { title: "Multa no STF", body: "Corpo 3.", why: "Porque 3.", editionDate: "261105" },
    ],
    weeklyEditions: [
      { editionDate: "261103", url: "https://diar.ia.br/p/a", destaques: ["Golpe da selfie", "Outro A"] },
      { editionDate: "261104", url: "https://diar.ia.br/p/b", destaques: ["Google paga para sair", "Outro B"] },
      { editionDate: "261105", url: "https://diar.ia.br/p/c", destaques: ["Multa no STF", "Outro C"] },
    ],
    opening: "Desde o ano passado, escrevo a diar.ia.br, newsletter de IA.",
    closing: "Fecho.",
    ...extra,
  };
}

const SECTION_H2 = `<h2>${LINKEDIN_WEEKLY_VIDEO_HEADING}</h2>`;

describe("#12777 — seção Vídeo da semana no render", () => {
  it("logo depois da manchete 1 quando o vídeo comenta o D1 dela, com o link no texto e sem <img>", () => {
    const { html, warnings } = renderLinkedinWeeklyHtml(input({ video: { title: "T", url: VIDEO_URL, editionDate: "261103" } }));
    const sec = html.indexOf(SECTION_H2);
    assert.ok(sec > html.indexOf("<h2>Golpe da selfie</h2>"), "depois da manchete 1");
    assert.ok(sec < html.indexOf("<h2>Google paga para sair</h2>"), "antes da manchete 2");
    const after = html.slice(sec).split("\n");
    assert.equal(
      after[1],
      `<p><a href="${VIDEO_URL}?utm_source=linkedin&amp;utm_medium=newsletter&amp;utm_campaign=ln-26w45&amp;utm_content=video">${LINKEDIN_WEEKLY_VIDEO_LINK_TEXT}</a>${LINKEDIN_WEEKLY_VIDEO_TAIL}</p>`,
    );
    assert.equal(after[2], "<hr/>");
    assert.ok(!/<img/i.test(html), "sem <img> no HTML colado");
    assert.ok(!html.includes("Clique"), "sem convite a clicar na imagem");
    assert.equal(html.split(SECTION_H2).length - 1, 1, "uma seção só");
    assert.deepEqual(warnings, []);
  });

  it("regressão #12081: a linha antiga antes do fecho saiu", () => {
    const { html } = renderLinkedinWeeklyHtml(input({ video: { title: "Título do vídeo", url: VIDEO_URL, editionDate: "261103" } }));
    assert.ok(!html.includes("Vídeo mais assistido da semana no canal da diar.ia.br:"));
    assert.ok(!html.includes("Título do vídeo"), "título do vídeo não aparece mais como âncora");
    const fecho = html.indexOf("<p>Fecho.</p>");
    assert.ok(html.lastIndexOf("utm_content=video") < fecho);
  });

  it("vai depois da manchete que o vídeo comenta (ex.: manchete 3, depois do Use Melhor)", () => {
    const { html, warnings } = renderLinkedinWeeklyHtml(
      input({
        useMelhor: { title: "Use", url: "https://ex.com/u", description: "Desc.", editorComment: "" },
        video: { title: "T", url: VIDEO_URL, editionDate: "261105" },
      }),
    );
    const sec = html.indexOf(SECTION_H2);
    assert.ok(sec > html.indexOf("<h2>Multa no STF</h2>"));
    assert.ok(sec > html.indexOf("<h3>🛠️ Use melhor</h3>"));
    assert.ok(!warnings.some((w) => w.startsWith(LINKEDIN_WEEKLY_VIDEO_HEADING)));
  });

  it("vídeo que não comenta nenhuma manchete: depois da manchete 1, com warning", () => {
    const { html, warnings } = renderLinkedinWeeklyHtml(input({ video: { title: "T", url: VIDEO_URL, editionDate: "261106" } }));
    const sec = html.indexOf(SECTION_H2);
    assert.ok(sec > html.indexOf("<h2>Golpe da selfie</h2>") && sec < html.indexOf("<h2>Google paga para sair</h2>"));
    assert.ok(warnings.some((w) => w.startsWith(LINKEDIN_WEEKLY_VIDEO_HEADING) && w.includes("destaque acima")), warnings.join("\n"));
  });

  it("sem vídeo (ou campo vazio), sem seção", () => {
    assert.ok(!renderLinkedinWeeklyHtml(input()).html.includes(SECTION_H2));
    assert.ok(!renderLinkedinWeeklyHtml(input({ video: null })).html.includes(SECTION_H2));
    assert.ok(!renderLinkedinWeeklyHtml(input({ video: { title: " ", url: VIDEO_URL } })).html.includes(SECTION_H2));
  });

  it("sem manchetes: seção logo depois da abertura", () => {
    const { html } = renderLinkedinWeeklyHtml(input({ headlines: [], video: { title: "T", url: VIDEO_URL, editionDate: "261103" } }));
    assert.ok(html.indexOf(SECTION_H2) > html.indexOf("Assinar a edição diária grátis"));
    assert.ok(html.indexOf(SECTION_H2) < html.indexOf("<p>Fecho.</p>"));
  });

  it("videoSectionHeadlineIndex casa por título normalizado do D1 da edição do vídeo", () => {
    const h = input().headlines;
    const e = input().weeklyEditions;
    assert.deepEqual(videoSectionHeadlineIndex(h, e, "261104"), { index: 1, matched: true });
    assert.deepEqual(videoSectionHeadlineIndex(h, [{ ...e[1], destaques: ["  google PAGA  para sair "] }], "261104"), {
      index: 1,
      matched: true,
    });
    assert.deepEqual(videoSectionHeadlineIndex(h, e, undefined), { index: 0, matched: false });
    assert.deepEqual(videoSectionHeadlineIndex([], e, "261104"), { index: -1, matched: false });
  });
});

describe("#12777 — auditoria pós-paste com a menção da seção do vídeo", () => {
  const sourceHtml = renderLinkedinWeeklyHtml(input({ video: { title: "T", url: VIDEO_URL, editionDate: "261103" } })).html;
  const sourceAnchors = extractAnchorsFromHtml(sourceHtml);
  const textLen = stripHtmlToText(sourceHtml).length;

  it("conta só a menção em texto puro (a da abertura é âncora)", () => {
    assert.equal(countUnlinkedWordmarkMentions(sourceHtml), 1);
    assert.equal(countUnlinkedWordmarkMentions("<p>sem marca</p>"), 0);
    assert.equal(countUnlinkedWordmarkMentions("<p>veja https://diar.ia.br/p/x</p>"), 0, "URL colada não é menção");
  });

  it("auto-link do LinkedIn sobre a menção não reprova a contagem", () => {
    const pasted = [...sourceAnchors.map((a) => ({ href: a.href, text: a.text })), { href: "http://diar.ia.br/", text: "diar.ia.br" }];
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: textLen });
    assert.deepEqual(r.issues, []);
    assert.ok(r.ok);
  });

  it("âncora a mais que NÃO é o auto-link do wordmark continua reprovando", () => {
    const pasted = [...sourceAnchors.map((a) => ({ href: a.href, text: a.text })), { href: "https://ex.com/", text: "outra" }];
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: textLen });
    assert.ok(r.issues.some((i) => /Contagem de âncoras diverge/.test(i)));
  });

  it("dois auto-links com uma menção só: o segundo reprova", () => {
    const extra = { href: "http://diar.ia.br/", text: "diar.ia.br" };
    const pasted = [...sourceAnchors.map((a) => ({ href: a.href, text: a.text })), extra, extra];
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: textLen });
    assert.ok(r.issues.some((i) => /Contagem de âncoras diverge/.test(i)));
  });

  it("isExpectedWordmarkAutoLink: só texto = wordmark e href na home sem UTM", () => {
    assert.ok(isExpectedWordmarkAutoLink({ href: "http://diar.ia.br/", text: "diar.ia.br" }));
    assert.ok(isExpectedWordmarkAutoLink({ href: "https://www.diar.ia.br", text: " diar.ia.br " }));
    assert.ok(!isExpectedWordmarkAutoLink({ href: "https://diar.ia.br/?utm_content=cta-fim", text: "diar.ia.br" }));
    assert.ok(!isExpectedWordmarkAutoLink({ href: "https://diar.ia.br/p/x", text: "diar.ia.br" }));
    assert.ok(!isExpectedWordmarkAutoLink({ href: "https://diar.ia.br/", text: "Assine" }));
    assert.ok(!isExpectedWordmarkAutoLink({ href: "nao-e-url", text: "diar.ia.br" }));
  });
});

describe("#12777 — CLI copia a imagem do vídeo (fail-soft)", () => {
  let root = "";
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function setup(video: unknown, withImageFor: string[]): string {
    root = mkdtempSync(join(tmpdir(), "ln-video-12777-"));
    const sel = join(root, "data", "weekly", "26w45", "_internal");
    mkdirSync(sel, { recursive: true });
    const base = input();
    writeFileSync(
      join(sel, "ln-selection.json"),
      JSON.stringify({ cycle: "26w45", headlines: base.headlines, useMelhor: null, weeklyEditions: base.weeklyEditions, video }),
    );
    for (const d of withImageFor) {
      const dir = join(root, "data", "editions", d.slice(0, 4), d);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "04-d1-2x1.jpg"), `img-${d}`);
      writeFileSync(join(dir, "04-d1-2x1-play.jpg"), `play-${d}`);
    }
    process.argv = ["node", "render-linkedin-weekly.ts", "--cycle", "26w45"];
    return root;
  }

  it("copia a 04-d1-2x1.jpg (sem play) da edição do vídeo e grava videoImagePath", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261105" }, ["261103", "261105"]);
    main(r);
    const out = join(r, "data", "weekly", "26w45");
    assert.equal(readFileSync(join(out, VIDEO_IMAGE_FILENAME), "utf8"), "img-261105", "sem o overlay de play");
    assert.equal(readFileSync(join(out, "04-d1-2x1.jpg"), "utf8"), "img-261103", "capa segue da manchete 1");
    const meta = JSON.parse(readFileSync(join(out, "ln-26w45.json"), "utf8"));
    assert.equal(meta.videoImagePath, join(out, VIDEO_IMAGE_FILENAME));
    assert.ok(readFileSync(join(out, "ln-26w45.html"), "utf8").includes(SECTION_H2));
  });

  it("imagem ausente na edição do vídeo: warning, sem abortar", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261105" }, ["261103"]);
    main(r);
    const out = join(r, "data", "weekly", "26w45");
    assert.ok(!existsSync(join(out, VIDEO_IMAGE_FILENAME)));
    const meta = JSON.parse(readFileSync(join(out, "ln-26w45.json"), "utf8"));
    assert.equal(meta.videoImagePath, null);
    assert.ok(meta.warnings.some((w: string) => w.includes("#12777")));
  });

  it("sem vídeo: videoImagePath null, sem warning de imagem do vídeo", () => {
    const r = setup(null, ["261103"]);
    main(r);
    const meta = JSON.parse(readFileSync(join(r, "data", "weekly", "26w45", "ln-26w45.json"), "utf8"));
    assert.equal(meta.videoImagePath, null);
    assert.ok(!meta.warnings.some((w: string) => w.includes("#12777")));
  });
});
