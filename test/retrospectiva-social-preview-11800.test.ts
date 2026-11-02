/**
 * test/retrospectiva-social-preview-11800.test.ts (#11800)
 *
 * O gate do `/diaria-mensal-apoiadores` (Passo 2) mostra os posts públicos no
 * artefato Social Preview da diária, gerado pelo `--dry-run` do
 * `publish-retrospectiva-social.ts`. No ciclo 2610-11 isso foi montado à mão
 * (md com `# Social`/`# Curto` + pós-processamento) e o render da diária
 * mostrava o aviso do 4º post USE MELHOR e as linhas `publish-additions` de
 * Facebook/Instagram, que o publicador da Retrospectiva não publica.
 *
 * Cobre: (1) sem aviso do 4º post e sem linhas `publish-additions`; (2) título
 * da história e horário efetivo POR REDE vindo do planner; (3) o post manual
 * do perfil LinkedIn; (4) que imagem cada rede leva.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRetrospectivaPreviewInput,
  localImageDataUri,
  previewImageDescription,
  type RetrospectivaPreviewOptions,
} from "../scripts/publish-retrospectiva-social.ts";
import { buildRetrospectivaSocialHtml, formatPreviewScheduledAt } from "../scripts/render-social-html.ts";
import { RETROSPECTIVA_CARD_SLOTS, retrospectivaCardPaths } from "../scripts/lib/mensal/retrospectiva-cards.ts";

const CORPO = "Parágrafo um da história.\n\nParágrafo dois.\n\nParágrafo três.\n\nApoie e leia a retrospectiva completa em: apoia.se/diaria";
const CURTO = "Curto da história. Apoie e leia a retrospectiva completa: apoia.se/diaria";

let cycleDir: string;

beforeEach(() => {
  cycleDir = mkdtempSync(join(tmpdir(), "retro-preview-11800-"));
  for (const h of ["d1"] as const) {
    const cards = retrospectivaCardPaths(cycleDir, h);
    for (const s of RETROSPECTIVA_CARD_SLOTS) {
      mkdirSync(dirname(cards[s]), { recursive: true });
      writeFileSync(cards[s], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
  }
});
afterEach(() => rmSync(cycleDir, { recursive: true, force: true }));

function options(over: Partial<RetrospectivaPreviewOptions> = {}): RetrospectivaPreviewOptions {
  const base = { historia: "d1" as const };
  return {
    cycle: "2610-11",
    cycleDir,
    titles: { d1: "Agentes saem do laboratório" },
    perfilText: "Post do perfil, voz do Pixel.\n\nApoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria",
    perfilAt: "2026-11-09T12:30:00-03:00",
    toImageUrl: localImageDataUri,
    result: {
      warnings: ["dia 2026-11-08: aviso de teste"],
      legacyLinkedin: { action: "none" },
      results: [
        { ...base, key: "linkedin_pagina:d1", channel: "linkedin_pagina", action: "dry-run", scheduledAt: "2026-11-08T09:45:00-03:00", images: [], text: CORPO },
        { ...base, key: "facebook:d1", channel: "facebook", page: "diaria", action: "dry-run", scheduledAt: "2026-11-08T11:45:00-03:00", images: [], text: CORPO },
        { ...base, key: "instagram:d1", channel: "instagram", action: "dry-run", scheduledAt: "2026-11-08T09:45:00-03:00", images: [], text: CORPO },
        { ...base, key: "threads:d1", channel: "threads", action: "dry-run", scheduledAt: "2026-11-08T10:15:00-03:00", images: [], text: CURTO },
        {
          ...base,
          key: "x:d1",
          channel: "x",
          action: "x-payload",
          payload: {
            historia: "d1",
            channelId: "buf",
            text: CURTO,
            dueAt: "2026-11-08T13:05:00-03:00",
            images: [],
            imagePendingUpload: true,
            publishedPath: "/tmp/x.json",
            destaque: "especial-retrospectiva",
          },
        },
        { key: "facebook:d2", channel: "facebook", historia: "d2", action: "skipped", reason: "já done" },
      ],
    },
    ...over,
  };
}

describe("preview da Retrospectiva no artefato Social Preview (#11800)", () => {
  it("(1) não mostra o aviso do 4º post nem as linhas publish-additions", () => {
    const html = buildRetrospectivaSocialHtml(buildRetrospectivaPreviewInput(options()));
    assert.doesNotMatch(html, /4º POST|USE MELHOR/i);
    assert.doesNotMatch(html, /use-melhor-notice/);
    assert.doesNotMatch(html, /class="publish-additions"/);
    assert.doesNotMatch(html, /Acrescentado na publicação/);
  });

  it("(2) mostra o título da história e o horário efetivo de cada rede", () => {
    const html = buildRetrospectivaSocialHtml(buildRetrospectivaPreviewInput(options()));
    assert.match(html, /História 1 — Agentes saem do laboratório/);
    // Facebook saiu 2 h depois pelo planner: o preview mostra o horário DELE, não o slot da história.
    assert.match(html, /📘 Facebook: [^<]*08\/11 11:45 BRT/);
    assert.match(html, /💼 LinkedIn página: [^<]*08\/11 09:45 BRT/);
    assert.match(html, /Threads: [^<]*10:15 BRT/);
    assert.match(html, /X \(via Buffer\): [^<]*13:05 BRT/);
    // Texto igual agrupa as redes num bloco só (corpo longo / curto).
    const input = buildRetrospectivaPreviewInput(options());
    assert.equal(input.historias.length, 1);
    assert.equal(input.historias[0].posts.length, 5);
  });

  it("(3) inclui o post manual do perfil LinkedIn com o horário", () => {
    const html = buildRetrospectivaSocialHtml(buildRetrospectivaPreviewInput(options()));
    assert.match(html, /Post manual — perfil LinkedIn/);
    assert.match(html, /Post do perfil, voz do Pixel\./);
    assert.match(html, /perfil \(MANUAL, colar à mão\): [^<]*09\/11 12:30 BRT/);
    const sem = buildRetrospectivaSocialHtml(buildRetrospectivaPreviewInput(options({ perfilText: null })));
    assert.doesNotMatch(sem, /Post manual — perfil LinkedIn/);
  });

  it("(4) diz qual imagem cada rede leva e embute o carrossel", () => {
    assert.equal(previewImageDescription("linkedin_pagina"), "capa 4:5");
    assert.equal(previewImageDescription("facebook"), "capa 4:5");
    assert.equal(previewImageDescription("instagram"), "carrossel de 5 (capa + 3 parágrafos + CTA)");
    assert.equal(previewImageDescription("threads"), "carrossel de 5 (capa + 3 parágrafos + CTA)");
    assert.equal(previewImageDescription("x"), "4 imagens (capa + 3 slides, sem o CTA)");
    const html = buildRetrospectivaSocialHtml(buildRetrospectivaPreviewInput(options()));
    assert.match(html, /📷 Instagram: [^<]*imagem: carrossel de 5/);
    assert.equal((html.match(/src="data:image\/jpeg;base64,/g) ?? []).length, 5);
  });

  it("pulados e avisos viram notas no topo; slide ausente omite a galeria com aviso", () => {
    rmSync(retrospectivaCardPaths(cycleDir, "d1").cta);
    const input = buildRetrospectivaPreviewInput(options());
    assert.ok(input.notices.some((n) => /Facebook d2: pulado — já done/.test(n)));
    assert.ok(input.notices.some((n) => /aviso de teste/.test(n)));
    assert.ok(input.notices.some((n) => /d1: 1 imagem/.test(n)));
    assert.deepEqual(input.historias[0].slides, []);
  });

  it("formatPreviewScheduledAt: null e ISO inválido não lançam", () => {
    assert.equal(formatPreviewScheduledAt(null), "horário não resolvido");
    assert.equal(formatPreviewScheduledAt("lixo"), "lixo");
  });
});
