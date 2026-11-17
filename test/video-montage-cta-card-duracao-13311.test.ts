/**
 * test/video-montage-cta-card-duracao-13311.test.ts
 *
 * #13311 — o card final de CTA ficava 4 s fixos no fim de toda sequência.
 * Decisão do editor (16/11/2026): 2 s em todas as sequências, configurável em
 * `publishing.video.cta_card_s` do `platform.config.json`. O build renderiza o
 * MP4 nessa duração (hash do nome inclui a duração), e o roteiro de fala
 * mostra a mesma duração quando o roteiro não traz a sua.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTA_CARD, ctaCardDurationFrom, ctaCardFrames, ctaCardRenderArgs } from "../scripts/lib/diaria/video-cta-card.ts";
import { roteiroDuracaoConfigFrom } from "../scripts/lib/diaria/roteiro-videos.ts";
import { renderCtaCard } from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");

describe("duração do card de CTA (#13311)", () => {
  it("default de 2 s (era 4 s)", () => {
    assert.equal(CTA_CARD.durationS, 2);
    assert.equal(ctaCardFrames(30), 60);
  });

  it("publishing.video.cta_card_s sobrepõe; ausente = default em silêncio; inválido = default com aviso", () => {
    const avisos: string[] = [];
    const warn = (m: string) => void avisos.push(m);
    assert.equal(ctaCardDurationFrom({ publishing: { video: { cta_card_s: 3 } } }, warn), 3);
    assert.equal(ctaCardDurationFrom({ publishing: { video: {} } }, warn), CTA_CARD.durationS);
    assert.equal(ctaCardDurationFrom(null, warn), CTA_CARD.durationS);
    assert.equal(avisos.length, 0);
    for (const bad of ["2", 0, -1, 0.4, Number.NaN]) assert.equal(ctaCardDurationFrom({ publishing: { video: { cta_card_s: bad } } }, warn), CTA_CARD.durationS);
    assert.equal(avisos.length, 5);
    assert.match(avisos[0], /cta_card_s inválido/);
  });

  it("o platform.config.json versionado traz 2 s (decisão do editor de 16/11)", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.equal(ctaCardDurationFrom(config), 2);
    assert.equal(roteiroDuracaoConfigFrom(config).ctaCardS, 2, "o roteiro mostra a mesma duração que o build põe no vídeo");
  });

  it("o roteiro herda a duração da montagem; roteiro.cta_card_s sobrepõe só no roteiro", () => {
    assert.equal(roteiroDuracaoConfigFrom({ publishing: { video: { cta_card_s: 3 } } }).ctaCardS, 3);
    assert.equal(roteiroDuracaoConfigFrom({ publishing: { video: { cta_card_s: 3, roteiro: { cta_card_s: 5 } } } }).ctaCardS, 5);
    assert.equal(roteiroDuracaoConfigFrom({}).ctaCardS, CTA_CARD.durationS);
  });

  it("renderCtaCard: duração entra nos quadros, no ffmpeg e no nome do arquivo (outra duração = outro card)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-card-13311-"));
    try {
      const render = (_png: string, out: string) => void writeFileSync(out, "mp4");
      const input = { outDir: join(dir, "out"), workDir: join(dir, "work"), mediaPath: "G:/Meu Drive/YouTube/261117/bruto.mp4", edition: "261117", width: 1080, height: 1920, fps: 30, share: null, render };
      mkdirSync(input.outDir, { recursive: true });
      const def = await renderCtaCard(input);
      assert.equal(def.asset.frames, 60);
      const tres = await renderCtaCard({ ...input, durationS: 3 });
      assert.equal(tres.asset.frames, 90);
      assert.notEqual(tres.asset.path, def.asset.path, "card de 4 s antigo nunca é reaproveitado como o de 2 s");
      assert.equal(tres.reused, false);
      assert.ok(existsSync(tres.asset.path));
      const a = ctaCardRenderArgs({ png: "c.png", out: "c.mp4", fps: 30, durationS: 3 });
      assert.equal(a[a.indexOf("-t") + 1], "3.000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
