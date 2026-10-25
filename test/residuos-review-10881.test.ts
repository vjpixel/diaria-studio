/**
 * test/residuos-review-10881.test.ts — resíduos P3 do review noturno 261022.
 *
 * Item 1 — `move-pool-item.ts`: tempo "N min" no meio da linha sem parênteses
 *   era reportado como trocado sem o texto mudar; `--dry-run` gravava o corpo
 *   baixado no cache forense.
 * Item 2 — `link-video-d1.ts` ignorava `audit_blocked` do registro do upload;
 *   a mensagem sugeria agendar (não resolve sem auditoria, #10866); depois de
 *   `--upload --force` o link do vídeo substituído não era trocado pelo novo
 *   (desde #10960, também troca quando o novo é privado).
 * Item 3 — hotmart sync: em `hotmart-sync-ltv-10876-10881-10734.test.ts`.
 * Item 4 — título de stub de redirect: palavra solta sem código HTTP não é
 *   placeholder; variantes em português são.
 * Item 5 — o `02-reviewed.md` cita a ferramenta do config; o HTML que chega ao
 *   leitor reaplica a do sidecar (fallback).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { measureTempoForMove, moveItemInReviewedMd, replaceInlineTempo } from "../scripts/move-pool-item.ts";
import { gateVideoLink, readYouTubeRecordSummary, videoLinkRemedy } from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { writeD1VideoUrlAfterUpload } from "../scripts/publish-youtube.ts";
import { isPlaceholderHighlightTitle, isRedirectStubTitle } from "../scripts/lib/placeholder-title-guard.ts";
import { buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { writeImageGeneratorSidecar } from "../scripts/lib/shared/image-generator-sidecar.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Item 1
// ---------------------------------------------------------------------------

describe("#10881 item 1: move-pool-item troca o tempo no meio da linha em qualquer forma", () => {
  const md = (desc: string) =>
    ["**📰 RADAR**", "", "**[Item](https://a.com/item)**  ", desc, "", "---", "", "**🛠️ USE MELHOR**", "", "**[Outro](https://a.com/outro)**  ", "desc (5 min)"].join(
      "\n",
    );

  for (const [desc, esperado] of [
    ["Guia rápido – 3 min de leitura, com exemplos.", "Guia rápido – 10 min de leitura, com exemplos."],
    ["Guia rápido ~3 min, com exemplos.", "Guia rápido 10 min, com exemplos."],
    ["Guia (3 min) com exemplos.", "Guia (10 min) com exemplos."],
  ] as const) {
    it(`"${desc}" → "${esperado}"`, () => {
      const r = moveItemInReviewedMd(md(desc), "https://a.com/item", "use_melhor", { tempo: 10, replaceTempo: true });
      assert.ok(r.md.includes(esperado), r.md);
      assert.equal(r.tempo_added, "(10 min)");
    });
  }

  it("replaceInlineTempo preserva a forma e não toca linha sem tempo", () => {
    assert.equal(replaceInlineTempo("a — 4 min b", 7), "a — 7 min b");
    assert.equal(replaceInlineTempo("sem tempo", 7), "sem tempo");
  });

  it("--dry-run: mede sem gravar o corpo baixado no cache forense", async () => {
    const d = tmp("mpi-10881-");
    try {
      writeFileSync(join(d, "02-reviewed.md"), md("Descrição"), "utf8");
      const chamadas: boolean[] = [];
      const body = `<html lang="pt"><body><p>${new Array(2000).fill("palavra").join(" ")}</p></body></html>`;
      const r = await measureTempoForMove(d, "https://a.com/item", {
        dryRun: true,
        fetchBody: async (_dir, _url, persist = true) => {
          chamadas.push(persist);
          return body;
        },
      });
      assert.equal(r.tempo, 10);
      assert.deepEqual(chamadas, [false]);
      assert.ok(!existsSync(join(d, "_internal", "_forensic")));
      await measureTempoForMove(d, "https://a.com/item", {
        fetchBody: async (_dir, _url, persist = true) => {
          chamadas.push(persist);
          return body;
        },
      });
      assert.deepEqual(chamadas, [false, true]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Item 2
// ---------------------------------------------------------------------------

const VIDEO_ID = "abc123XYZ_9";
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;
const PUBLISH_AT = "2026-10-22T09:00:00.000Z";
const D1_SLOT = new Date("2026-10-22T12:45:00Z");

function gravarRegistro(dir: string, rec: Record<string, unknown>): void {
  const p = join(dir, YOUTUBE_PUBLISHED_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(rec));
}

describe("#10881 item 2: link do vídeo segue a premissa de auditoria do upload", () => {
  it("registro com audit_blocked=false libera o agendado antes do D1; true recusa", () => {
    const d = tmp("yt-10881-");
    try {
      const base = { aammdd: "261022", videoId: VIDEO_ID, url: VIDEO_URL, state: "scheduled", rereadStatus: { publishAt: PUBLISH_AT } };
      gravarRegistro(d, { ...base, audit_blocked: false });
      assert.equal(readYouTubeRecordSummary(d)!.auditBlocked, false);
      assert.equal(gateVideoLink({ videoUrl: VIDEO_URL, record: readYouTubeRecordSummary(d), d1SlotAt: D1_SLOT }).ok, true);
      gravarRegistro(d, { ...base, audit_blocked: true });
      const g = gateVideoLink({ videoUrl: VIDEO_URL, record: readYouTubeRecordSummary(d), d1SlotAt: D1_SLOT });
      assert.equal(g.ok, false);
      assert.match(g.reason, /auditoria/);
      gravarRegistro(d, base);
      assert.equal(readYouTubeRecordSummary(d)!.auditBlocked, null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("sem auditoria a instrução não sugere agendar", () => {
    assert.doesNotMatch(videoLinkRemedy(false), /agende antes/);
    assert.match(videoLinkRemedy(false), /#10866/);
    assert.match(videoLinkRemedy(true), /agende antes do post do D1/);
    const d = tmp("yt-10881-msg-");
    try {
      const logs: string[] = [];
      const rec = { aammdd: "261022", url: VIDEO_URL, state: "scheduled" as const, rereadStatus: { privacyStatus: "private", publishAt: PUBLISH_AT } };
      writeD1VideoUrlAfterUpload(d, rec, D1_SLOT, (l) => logs.push(l), false);
      assert.doesNotMatch(logs.join("\n"), /agendar antes|agende antes/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("após --upload --force: link do vídeo substituído é trocado pelo novo, inclusive privado (#10960)", () => {
    const d = tmp("yt-10881-force-");
    const urlFile = join(d, D1_VIDEO_URL_FILE);
    const VELHO = "https://youtu.be/velhoVIDEO1";
    try {
      const anterior = [{ aammdd: "261022", url: VELHO, videoId: "velhoVIDEO1" }] as never;
      mkdirSync(dirname(urlFile), { recursive: true });
      writeFileSync(urlFile, `${VELHO}\n`);
      const ok = writeD1VideoUrlAfterUpload(
        d,
        { aammdd: "261022", url: VIDEO_URL, state: "published", rereadStatus: { privacyStatus: "public" }, previous_uploads: anterior },
        null,
        () => {},
      );
      assert.equal(ok, true);
      assert.equal(readFileSync(urlFile, "utf8").trim(), VIDEO_URL);

      writeFileSync(urlFile, `${VELHO}\n`);
      const logs: string[] = [];
      const naoPassa = writeD1VideoUrlAfterUpload(
        d,
        { aammdd: "261022", url: VIDEO_URL, state: "draft", rereadStatus: { privacyStatus: "private" }, previous_uploads: anterior },
        D1_SLOT,
        (l) => logs.push(l),
      );
      assert.equal(naoPassa, true);
      assert.equal(readFileSync(urlFile, "utf8").trim(), VIDEO_URL);
      assert.match(logs.join("\n"), /aviso.*10960/s);

      // URL que não veio de upload nosso continua intocada.
      writeFileSync(urlFile, "https://youtu.be/manualVIDEO\n");
      writeD1VideoUrlAfterUpload(
        d,
        { aammdd: "261022", url: VIDEO_URL, state: "published", rereadStatus: null, previous_uploads: anterior },
        null,
        () => {},
      );
      assert.equal(readFileSync(urlFile, "utf8").trim(), "https://youtu.be/manualVIDEO");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Item 4
// ---------------------------------------------------------------------------

describe("#10881 item 4: título de stub de redirect", () => {
  for (const t of ["Found", "Moved", "Redirect", "Encontrado", "Movido"]) {
    it(`"${t}" sozinho é título real (sem código HTTP)`, () => {
      assert.equal(isRedirectStubTitle(t), false);
      assert.equal(isPlaceholderHighlightTitle(t), false);
    });
  }
  for (const t of [
    "302 Found",
    "301 Moved",
    "302 Redirect",
    "Documento movido",
    "Objeto movido",
    "301 Movido permanentemente",
    "Movido temporariamente",
    "Redirecionando...",
    "Redirecionando para https://a.com/x",
    "302 Encontrado",
    "307 Redirecionamento temporário",
  ]) {
    it(`"${t}" é stub`, () => {
      assert.equal(isRedirectStubTitle(t), true);
      assert.equal(isPlaceholderHighlightTitle(t), true);
    });
  }
  it("título real em português que começa com a palavra continua real", () => {
    assert.equal(isRedirectStubTitle("Redirecionando o investimento em IA para o Brasil"), false);
    assert.equal(isRedirectStubTitle("Movido a IA: o novo chip da Nvidia"), false);
  });
});

// ---------------------------------------------------------------------------
// Item 5
// ---------------------------------------------------------------------------

const TOOLS =
  "Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz.";

describe("#10881 item 5: o HTML ao leitor cita a ferramenta do sidecar, não a do 02-reviewed.md", () => {
  it("stitch gravou ChatGPT (config codex); fallback Gemini nos 3 destaques → HTML diz Gemini", () => {
    const d = tmp("tool-10881-");
    try {
      const destaques = [1, 2, 3]
        .flatMap((n) => [
          `**DESTAQUE ${n} | RADAR**`,
          "",
          `**[Título ${n}](https://example.com/${n})**`,
          "",
          `Corpo ${n} com contexto suficiente.`,
          "",
          `Por que isso importa: razão ${n}.`,
          "",
          "---",
          "",
        ])
        .join("\n");
      const encerrar = buildParaEncerrar({ slotA: TOOLS }, null, undefined, "codex");
      assert.match(encerrar, /ChatGPT para criar imagens/);
      writeFileSync(join(d, "02-reviewed.md"), `${destaques}${encerrar}\n`, "utf8");
      writeFileSync(join(d, "01-eia.md"), "É IA?\n\nCrédito [link](https://x.com).\n", "utf8");
      for (const k of ["d1", "d2", "d3"]) writeImageGeneratorSidecar(d, k, { generator: "gemini", configured: "codex", fallback: true });
      const content = extractContent(d);
      assert.match(content.encerrar ?? "", /ChatGPT para criar imagens/, "o markdown guarda o nome do config");
      const html = renderHTML(content);
      assert.match(html, /Gemini para criar imagens/);
      assert.doesNotMatch(html, /ChatGPT para criar imagens/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
