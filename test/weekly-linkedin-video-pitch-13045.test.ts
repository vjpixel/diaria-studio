/**
 * test/weekly-linkedin-video-pitch-13045.test.ts (#13045, #13049)
 *
 * #13045: a seção "Vídeo da semana" do artigo semanal do LinkedIn abre com a
 * frase fixa "Eu comento o destaque acima no YouTube da diar.ia.br." (link em
 * "YouTube da diar.ia.br") e, quando o ciclo tem `video.pitch` em
 * `ln-selection.json`, fecha com a frase da semana. Sem o campo, só a frase
 * fixa. A frase da semana é validada contra a legenda do vídeo.
 *
 * #13049: a menção da abertura aponta para a página da diar.ia.br no LinkedIn
 * (sem UTM), e a auditoria do paste reconhece a divisão da âncora do vídeo que
 * termina em "diar.ia.br" (achado ao vivo do 26w46).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderLinkedinWeeklyHtml,
  LINKEDIN_WEEKLY_WORDMARK_URL,
  type WeeklyLinkedinRenderInput,
} from "../scripts/lib/weekly-linkedin-render.ts";
import {
  auditLinkedinPaste,
  endsWithWordmarkAnchorText,
  extractAnchorsFromHtml,
  stripHtmlToText,
  TRAILING_WORDMARK_SPLIT_HINT,
  WORDMARK_HREF_REWRITE_HINT,
} from "../scripts/lib/linkedin-paste-audit.ts";
import { srtSpokenText, weeklyVideoPitchProblems } from "../scripts/lib/weekly-video-pitch.ts";
import { applyVideoPitch, main } from "../scripts/render-linkedin-weekly.ts";

const VIDEO_URL = "https://youtu.be/bbbbbbbbbbb";
const PITCH = "No vídeo, explico em três etapas como a IA aprende com o time e passa a dispensá-lo, e por que as vagas de entrada são as mais afetadas.";

function input(video: WeeklyLinkedinRenderInput["video"]): WeeklyLinkedinRenderInput {
  return {
    cycle: "26w46",
    headlines: [
      { title: "IA dispensa o time", body: "Corpo 1.", why: "Porque 1.", editionDate: "261111" },
      { title: "Outra", body: "Corpo 2.", why: "", editionDate: "261112" },
    ],
    weeklyEditions: [
      { editionDate: "261111", url: "https://diar.ia.br/p/a", destaques: ["IA dispensa o time"] },
      { editionDate: "261112", url: "https://diar.ia.br/p/b", destaques: ["Outra"] },
    ],
    opening: "Desde o ano passado, escrevo a diar.ia.br, newsletter de IA.",
    closing: "Fecho.",
    video,
  };
}

function videoParagraph(html: string): string {
  const lines = html.split("\n");
  return lines[lines.indexOf("<h2>Vídeo da semana</h2>") + 1];
}

describe("#13045 — frase do vídeo no artigo", () => {
  it("com pitch: frase fixa (link em 'YouTube da diar.ia.br') + frase da semana, num parágrafo", () => {
    const { html } = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch: PITCH }));
    const p = videoParagraph(html);
    assert.match(p, /^<p>Eu comento o destaque acima no <a href="https:\/\/youtu\.be\/bbbbbbbbbbb\?[^"]*utm_content=video">YouTube da diar\.ia\.br<\/a>\. No vídeo, explico/);
    assert.equal(stripHtmlToText(p), `Eu comento o destaque acima no YouTube da diar.ia.br. ${PITCH}`);
  });

  it("sem pitch (ou vazio): só a frase fixa", () => {
    for (const pitch of [undefined, "", "   "]) {
      const { html } = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch }));
      assert.equal(stripHtmlToText(videoParagraph(html)), "Eu comento o destaque acima no YouTube da diar.ia.br.");
    }
  });

  it("regressão: o trecho fixo da #13023 não volta", () => {
    const { html } = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111" }));
    assert.ok(!stripHtmlToText(html).includes("principal vídeo da semana"));
    assert.ok(!stripHtmlToText(html).includes("no canal da diar.ia.br eu comento"));
  });

  it("pitch com HTML é escapado", () => {
    const { html } = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch: "Mostro <b>tudo</b>." }));
    assert.ok(videoParagraph(html).includes("Mostro &lt;b&gt;tudo&lt;/b&gt;."));
  });
});

describe("#13045 — validação da frase da semana", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:04,480\nSão três etapas.\n\n2\n00:00:05,000 --> 00:00:09,120\nUm corte de 40% nas vagas de entrada.\n";

  it("srtSpokenText tira número de bloco e linha de tempo", () => {
    assert.equal(srtSpokenText(SRT), "São três etapas.\nUm corte de 40% nas vagas de entrada.");
  });

  it("frase limpa passa; número só se estiver na fala", () => {
    const fala = srtSpokenText(SRT);
    assert.deepEqual(weeklyVideoPitchProblems(PITCH, fala), []);
    assert.deepEqual(weeklyVideoPitchProblems("Mostro o corte de 40% nas vagas de entrada.", fala), []);
    assert.match(weeklyVideoPitchProblems("Mostro o corte de 30% nas vagas.", fala).join("\n"), /fala do vídeo \(30\)/);
    // número de timestamp (480, 00) não conta como fala
    assert.match(weeklyVideoPitchProblems("Em 480 segundos explico tudo.", fala).join("\n"), /480/);
  });

  it("sem legenda, números não são conferidos", () => {
    assert.deepEqual(weeklyVideoPitchProblems("Mostro o corte de 30% nas vagas.", null), []);
  });

  it("recusa audiência, marca em texto puro, URL, seta e vazio", () => {
    assert.match(weeklyVideoPitchProblems("É o vídeo mais assistido da semana.", null).join("\n"), /#13023/);
    assert.match(weeklyVideoPitchProblems("Explico tudo no canal da diar.ia.br.", null).join("\n"), /#13049/);
    assert.match(weeklyVideoPitchProblems("Veja em https://youtu.be/x.", null).join("\n"), /URL/);
    assert.match(weeklyVideoPitchProblems("Explico tudo → aqui.", null).join("\n"), /seta/);
    assert.deepEqual(weeklyVideoPitchProblems("  ", null), ["vazio"]);
  });
});

describe("#13045 — CLI grava video.pitch em ln-selection.json", () => {
  let root = "";
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function setup(video: unknown, srt?: string): string {
    root = mkdtempSync(join(tmpdir(), "ln-pitch-13045-"));
    const sel = join(root, "data", "weekly", "26w46", "_internal");
    mkdirSync(sel, { recursive: true });
    const base = input(null);
    writeFileSync(
      join(sel, "ln-selection.json"),
      JSON.stringify({ cycle: "26w46", headlines: base.headlines, useMelhor: null, weeklyEditions: base.weeklyEditions, video }),
    );
    if (srt !== undefined) {
      const dir = join(root, "data", "editions", "2611", "261111");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "diaria-comentada-261111.srt"), srt);
    }
    return root;
  }
  const selection = (r: string) => JSON.parse(readFileSync(join(r, "data", "weekly", "26w46", "_internal", "ln-selection.json"), "utf8"));

  it("frase válida: grava e o render usa", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261111" }, "1\n00:00:01,000 --> 00:00:02,000\nTrês etapas.\n");
    const res = applyVideoPitch(r, "26w46", `  ${PITCH}  `);
    assert.deepEqual(res, { ok: true, problems: [], warnings: [] });
    assert.equal(selection(r).video.pitch, PITCH);
    process.argv = ["node", "render-linkedin-weekly.ts", "--cycle", "26w46"];
    main(r);
    const html = readFileSync(join(r, "data", "weekly", "26w46", "ln-26w46.html"), "utf8");
    assert.ok(stripHtmlToText(html).includes(`YouTube da diar.ia.br. ${PITCH}`));
  });

  it("frase inválida: recusa e não grava nada", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261111" }, "1\n00:00:01,000 --> 00:00:02,000\nTrês etapas.\n");
    const res = applyVideoPitch(r, "26w46", "O mais visto da semana tem 7 passos.");
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => /#13023/.test(p)));
    assert.ok(res.problems.some((p) => /\(7\)/.test(p)));
    assert.equal(selection(r).video.pitch, undefined);
  });

  it("sem vídeo na seleção: recusa", () => {
    const r = setup(null);
    assert.equal(applyVideoPitch(r, "26w46", PITCH).ok, false);
  });

  it("sem legenda: grava com aviso", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261111" });
    const res = applyVideoPitch(r, "26w46", PITCH);
    assert.equal(res.ok, true);
    assert.match(res.warnings.join("\n"), /não foram conferidos/);
  });

  it("pitch editado à mão no JSON com problema vira warning no render", () => {
    const r = setup({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch: "O vídeo mais assistido." });
    process.argv = ["node", "render-linkedin-weekly.ts", "--cycle", "26w46"];
    main(r);
    const meta = JSON.parse(readFileSync(join(r, "data", "weekly", "26w46", "ln-26w46.json"), "utf8"));
    assert.ok(meta.warnings.some((w: string) => w.includes("#13045") && w.includes("mais assistido")), meta.warnings.join("\n"));
  });
});

describe("#13049 — marca aponta para a página do LinkedIn", () => {
  it("a menção da abertura vai para linkedin.com/company/diar.ia.br, sem UTM", () => {
    const { html } = renderLinkedinWeeklyHtml(input(null));
    assert.equal(LINKEDIN_WEEKLY_WORDMARK_URL, "https://www.linkedin.com/company/diar.ia.br/");
    assert.ok(html.includes(`<a href="https://www.linkedin.com/company/diar.ia.br/">diar.ia.br</a>, newsletter de IA.`));
    assert.ok(!html.includes("mencao-abertura"), "UTM mencao-abertura não sai mais");
  });

  it("auditoria: menção reescrita pelo LinkedIn para http://diar.ia.br é acusada com o hint", () => {
    const sourceHtml = renderLinkedinWeeklyHtml(input(null)).html;
    const pasted = extractAnchorsFromHtml(sourceHtml).map((a) => (a.text === "diar.ia.br" ? { href: "http://diar.ia.br/", text: a.text } : a));
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.equal(r.ok, false);
    assert.equal(r.issues.length, 1, r.issues.join("\n"));
    assert.ok(r.issues[0].includes(WORDMARK_HREF_REWRITE_HINT));
  });

  it("auditoria: menção corrigida para o perfil passa", () => {
    const sourceHtml = renderLinkedinWeeklyHtml(input(null)).html;
    const pasted = extractAnchorsFromHtml(sourceHtml);
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.deepEqual(r.issues, []);
  });
});

describe("#13049 item 3 — âncora do vídeo dividida no paste", () => {
  it("endsWithWordmarkAnchorText", () => {
    assert.ok(endsWithWordmarkAnchorText("YouTube da diar.ia.br"));
    assert.ok(endsWithWordmarkAnchorText(" YouTube  da diar.ia.br "));
    assert.ok(!endsWithWordmarkAnchorText("diar.ia.br"));
    assert.ok(!endsWithWordmarkAnchorText("Assine grátis, é rapidinho"));
  });

  it("cenário real do 26w46: 'YouTube da' (vídeo) + 'diar.ia.br' (home) é acusado com o hint e a contagem", () => {
    const sourceHtml = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch: PITCH })).html;
    const src = extractAnchorsFromHtml(sourceHtml);
    const video = src.find((a) => a.text === "YouTube da diar.ia.br");
    assert.ok(video);
    const pasted = src.flatMap((a) =>
      a === video ? [{ href: a.href, text: "YouTube da" }, { href: "http://diar.ia.br/", text: "diar.ia.br" }] : [{ href: a.href, text: a.text }],
    );
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: pasted, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes("YouTube da diar.ia.br") && i.includes(TRAILING_WORDMARK_SPLIT_HINT)), r.issues.join("\n"));
    assert.ok(r.issues.some((i) => /Contagem de âncoras diverge/.test(i)), r.issues.join("\n"));
  });

  it("depois da correção (1 âncora com a UTM), passa", () => {
    const sourceHtml = renderLinkedinWeeklyHtml(input({ title: "T", url: VIDEO_URL, editionDate: "261111", pitch: PITCH })).html;
    const r = auditLinkedinPaste({ sourceHtml, pastedAnchors: extractAnchorsFromHtml(sourceHtml), pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.deepEqual(r.issues, []);
  });
});
