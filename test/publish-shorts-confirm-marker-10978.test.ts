/**
 * test/publish-shorts-confirm-marker-10978.test.ts (#10978 item 5)
 *
 * O `--confirm-instagram` não pode depender só da 1ª linha da legenda: o
 * editor às vezes muda o título do D1 no Chrome antes do Share. Agora o gancho
 * (1ª frase do D1) também é marcador, e sem marcador nenhum vale o ÚNICO
 * Reels no formato do vertical perto do horário planejado. Ambíguo continua
 * recusando. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INSTAGRAM_CAPTION_FORMAT_MARKER,
  INSTAGRAM_CONFIRM_TIME_WINDOW_MS,
  INSTAGRAM_HOOK_MARKER_MIN_CHARS,
  decideInstagramConfirm,
  instagramEditionMarkers,
} from "../scripts/publish-shorts.ts";
import { buildReelsCaption } from "../scripts/lib/diaria/short-video.ts";

const AAMMDD = "261028";
const D1 = {
  title: "OpenAI lança modelo que lê planilhas",
  body: "A empresa disse que o modelo entende fórmulas e gráficos sem instrução extra. Segunda frase do destaque.",
};
const CAPTION = buildReelsCaption({ platform: "instagram", aammdd: AAMMDD, d1: D1, editionUrl: "https://diar.ia.br/p/x" });
const MARKERS = instagramEditionMarkers({ aammdd: AAMMDD, d1Title: D1.title, d1Body: D1.body, editionUrl: "https://diar.ia.br/p/x" });
const SINCE = "2026-10-28T03:00:00.000Z"; // 00:00 BRT
const EXPECTED = "2026-10-28T11:00:00.000Z"; // 08:00 BRT
const NOW = "2026-10-28T12:00:00.000Z";

function reel(id: string, caption: string, timestamp: string) {
  return { id, media_product_type: "REELS", media_type: "VIDEO", caption, timestamp, permalink: `https://www.instagram.com/reel/${id}/` };
}

function decide(data: unknown[], extra: Partial<Parameters<typeof decideInstagramConfirm>[0]> = {}) {
  return decideInstagramConfirm({
    published: { aammdd: AAMMDD, entries: [] },
    media: { data },
    sinceIso: SINCE,
    markers: MARKERS,
    nowIso: NOW,
    expectedAtIso: EXPECTED,
    ...extra,
  });
}

describe("#10978 item 5: marcador robusto a edição da 1ª linha", () => {
  it("o gancho do D1 entra nos marcadores; gancho curto demais fica de fora", () => {
    assert.ok(MARKERS.includes("A empresa disse que o modelo entende fórmulas e gráficos sem instrução extra."));
    const short = instagramEditionMarkers({ aammdd: AAMMDD, d1Title: "T", d1Body: "Curto. Outra." });
    assert.ok(short.every((m) => m !== "Curto."), `gancho < ${INSTAGRAM_HOOK_MARKER_MIN_CHARS} chars não é marcador`);
  });

  it("legenda com a 1ª linha (título) trocada no Chrome: casa pelo gancho", () => {
    const edited = CAPTION.replace(D1.title, "Título reescrito na hora do Share");
    const d = decide([reel("r1", edited, "2026-10-28T11:05:00+0000")]);
    assert.equal(d.kind, "register");
    if (d.kind === "register") assert.equal(d.matchedBy, "marker");
  });

  it("título E gancho trocados: o único Reels no formato do vertical perto do horário é registrado (time-window)", () => {
    const edited = CAPTION.replace(D1.title, "Outro título").replace(D1.body.split(". ")[0] + ".", "Outro gancho escrito à mão.");
    assert.ok(edited.includes(INSTAGRAM_CAPTION_FORMAT_MARKER));
    const d = decide([reel("r1", edited, "2026-10-28T11:20:00+0000")]);
    assert.equal(d.kind, "register");
    if (d.kind === "register") {
      assert.equal(d.matchedBy, "time-window");
      assert.equal(d.entry.id, "r1");
    }
  });

  it("dois Reels no formato do vertical dentro da janela: recusa (ambíguo), nunca escolhe", () => {
    const d = decide([
      reel("r1", "Outro título\n\nyoutube.com/@diariabr", "2026-10-28T11:10:00+0000"),
      reel("r2", "Mais um\n\nyoutube.com/@diariabr", "2026-10-28T11:40:00+0000"),
    ]);
    assert.equal(d.kind, "refuse");
    if (d.kind === "refuse") {
      assert.equal(d.cause, "ambiguous");
      assert.equal(d.candidates.length, 2);
    }
  });

  it("Reels sem marcador fora da janela: recusa (no-match)", () => {
    const far = new Date(Date.parse(EXPECTED) + INSTAGRAM_CONFIRM_TIME_WINDOW_MS + 60_000).toISOString();
    const d = decide([reel("r1", "Outro\n\nyoutube.com/@diariabr", far)]);
    assert.equal(d.kind, "refuse");
    if (d.kind === "refuse") assert.equal(d.cause, "no-match");
  });

  it("Reels perto do horário mas sem o formato do vertical (outro conteúdo da conta): recusa", () => {
    const d = decide([reel("r1", "Bastidores do estúdio hoje", "2026-10-28T11:05:00+0000")]);
    assert.equal(d.kind, "refuse");
  });

  it("sem horário planejado (caller antigo): só o marcador vale, como antes", () => {
    const d = decide([reel("r1", "Outro\n\nyoutube.com/@diariabr", "2026-10-28T11:05:00+0000")], { expectedAtIso: null });
    assert.equal(d.kind, "refuse");
  });

  it("dois Reels com o marcador continuam ambíguos (o fallback de horário não desempata)", () => {
    const d = decide([reel("r1", CAPTION, "2026-10-28T11:01:00+0000"), reel("r2", CAPTION, "2026-10-28T11:02:00+0000")]);
    assert.equal(d.kind, "refuse");
    if (d.kind === "refuse") assert.equal(d.cause, "ambiguous");
  });
});
