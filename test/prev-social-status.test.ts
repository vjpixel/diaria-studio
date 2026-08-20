/**
 * test/prev-social-status.test.ts (#5756)
 *
 * O check 0l do Stage 0 acusava ~12 "posts sociais atrasados" em TODA edição,
 * indefinidamente, sobre um estado correto. Estes testes travam a distinção
 * que faltava: `scheduled` vencido só é informação em canal que REPORTA
 * status.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePrevSocial,
  formatPrevSocialSummary,
  FIRE_AND_FORGET_PLATFORMS,
} from "../scripts/lib/prev-social-status.ts";

const NOW = new Date("2026-08-20T20:00:00-03:00");
const PAST = "2026-08-20T10:00:00-03:00";
const FUTURE = "2026-08-21T10:00:00-03:00";

/** Réplica fiel da forma real de uma edição: 3 destaques × 5 canais. */
function realisticEdition(fbStatus = "published") {
  const posts = [];
  for (const d of ["d1", "d2", "d3"]) {
    posts.push({ platform: "facebook", destaque: d, status: fbStatus, scheduled_at: PAST });
    for (const p of ["linkedin", "instagram", "threads", "twitter"]) {
      posts.push({ platform: p, destaque: d, status: "scheduled", scheduled_at: PAST });
    }
  }
  return posts;
}

describe("prev-social-status — o falso alarme diário (#5756)", () => {
  it("edição inteiramente saudável não gera achado nenhum", () => {
    const r = analyzePrevSocial(realisticEdition(), NOW);

    // Antes do #5756 este mesmo input produzia "12 posts sociais com
    // status=scheduled e scheduled_at já passado" — todo dia, para sempre.
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 12);
    assert.equal(r.total, 15);
  });

  it("os 4 canais fire-and-forget nunca viram achado por 'vencido'", () => {
    const posts = [...FIRE_AND_FORGET_PLATFORMS].map((platform) => ({
      platform,
      destaque: "d1",
      status: "scheduled",
      // Vencido há um ano: mesmo assim não é informação nenhuma, porque o
      // registro local congela no enqueue e nunca é reconsultado.
      scheduled_at: "2025-08-20T10:00:00-03:00",
    }));
    const r = analyzePrevSocial(posts, NOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 4);
  });

  it("Facebook vencido em 'scheduled' É achado — ali o silêncio significa algo", () => {
    const r = analyzePrevSocial(realisticEdition("scheduled"), NOW);

    // O verify-facebook-posts.ts do check 0k teria virado para "published"
    // se o post tivesse saído. Continuar "scheduled" depois da hora é sinal.
    assert.equal(r.findings.length, 3);
    assert.ok(r.findings.every((f) => f.platform === "facebook" && f.reason === "overdue-pollable"));
  });

  it("Facebook agendado para o FUTURO não é achado", () => {
    const r = analyzePrevSocial(
      [{ platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: FUTURE }],
      NOW,
    );
    assert.deepEqual(r.findings, []);
  });

  it("'failed' é achado em QUALQUER canal, inclusive fire-and-forget", () => {
    const posts = [
      { platform: "linkedin", destaque: "d1", status: "failed", scheduled_at: PAST },
      { platform: "facebook", destaque: "d2", status: "failed", scheduled_at: PAST },
    ];
    const r = analyzePrevSocial(posts, NOW);

    // `failed` é o script LOCAL dizendo que o dispatch não saiu — não uma
    // inferência sobre estado remoto. Vale para todo canal.
    assert.equal(r.findings.length, 2);
    assert.ok(r.findings.every((f) => f.reason === "failed"));
  });

  it("scheduled_at ausente ou inválido não vira achado por acidente", () => {
    const r = analyzePrevSocial(
      [
        { platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: null },
        { platform: "facebook", destaque: "d2", status: "scheduled", scheduled_at: "não é data" },
      ],
      NOW,
    );
    // Sem timestamp confiável não há como afirmar "vencido" — silêncio é
    // melhor que um alarme que o editor não consegue verificar.
    assert.deepEqual(r.findings, []);
  });

  it("platform com caixa diferente ainda é reconhecida", () => {
    const r = analyzePrevSocial(
      [{ platform: "LinkedIn", destaque: "d1", status: "scheduled", scheduled_at: PAST }],
      NOW,
    );
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 1);
  });

  it("lista vazia é silêncio, não erro", () => {
    const r = analyzePrevSocial([], NOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.total, 0);
  });
});

describe("prev-social-status — resumo", () => {
  it("sem achados, não há mensagem — silêncio é o comportamento correto", () => {
    assert.equal(formatPrevSocialSummary(analyzePrevSocial(realisticEdition(), NOW), "260819"), null);
  });

  it("com achados, nomeia canal, destaque e motivo", () => {
    const s = formatPrevSocialSummary(analyzePrevSocial(realisticEdition("scheduled"), NOW), "260819");
    assert.ok(s);
    assert.match(s, /260819/);
    assert.match(s, /facebook\/d1 \(overdue-pollable\)/);
  });
});
