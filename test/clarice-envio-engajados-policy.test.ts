/**
 * test/clarice-envio-engajados-policy.test.ts (#6945)
 *
 * Cobre `scripts/lib/clarice-envio-engajados-policy.ts` — motor PURO de
 * volume da automação `engajados`. Sem I/O, sem `new Date()` interno.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  proposeEngajadosVolume,
  buildEngajadosPlanPreview,
  ENGAJADOS_BOOTSTRAP_VOLUME,
  ENGAJADOS_MAX_DAILY_VOLUME,
  ENGAJADOS_DAILY_GROWTH_STEP,
} from "../scripts/lib/clarice-envio-engajados-policy.ts";

describe("proposeEngajadosVolume (#6945)", () => {
  it("sem histórico (null) -> bootstrap × (1 + step)", () => {
    const expected = Math.round(ENGAJADOS_BOOTSTRAP_VOLUME * (1 + ENGAJADOS_DAILY_GROWTH_STEP));
    assert.equal(proposeEngajadosVolume(null), expected);
  });

  it("undefined tratado igual a null (bootstrap)", () => {
    assert.equal(proposeEngajadosVolume(undefined), proposeEngajadosVolume(null));
  });

  it("base válida cresce exatamente ENGAJADOS_DAILY_GROWTH_STEP (10%)", () => {
    assert.equal(proposeEngajadosVolume(2000), Math.round(2000 * 1.1));
    assert.equal(proposeEngajadosVolume(1000), 1100);
  });

  it("nunca excede ENGAJADOS_MAX_DAILY_VOLUME (teto absoluto)", () => {
    assert.equal(proposeEngajadosVolume(ENGAJADOS_MAX_DAILY_VOLUME), ENGAJADOS_MAX_DAILY_VOLUME);
    assert.equal(proposeEngajadosVolume(ENGAJADOS_MAX_DAILY_VOLUME * 10), ENGAJADOS_MAX_DAILY_VOLUME);
  });

  it("base 0/negativa/não-finita -> trata como sem histórico (bootstrap), nunca escala sobre dado inválido", () => {
    const bootstrapResult = proposeEngajadosVolume(null);
    assert.equal(proposeEngajadosVolume(0), bootstrapResult);
    assert.equal(proposeEngajadosVolume(-500), bootstrapResult);
    assert.equal(proposeEngajadosVolume(NaN), bootstrapResult);
    assert.equal(proposeEngajadosVolume(Infinity), bootstrapResult);
  });

  it("base fracionária é truncada (Math.floor) antes de escalar", () => {
    assert.equal(proposeEngajadosVolume(1000.9), Math.round(1000 * 1.1));
  });

  it("nunca devolve não-finito nem negativo pra nenhuma entrada testada", () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity, 1, 100000]) {
      const r = proposeEngajadosVolume(v as number | null | undefined);
      assert.ok(Number.isFinite(r) && r >= 0, `entrada ${v} produziu ${r}`);
    }
  });

  it("escalada composta ao longo de N dias converge pro teto sem ultrapassá-lo", () => {
    let volume: number | null = null;
    for (let day = 0; day < 60; day++) {
      volume = proposeEngajadosVolume(volume);
      assert.ok(volume <= ENGAJADOS_MAX_DAILY_VOLUME, `dia ${day}: volume ${volume} excedeu o teto`);
    }
    assert.equal(volume, ENGAJADOS_MAX_DAILY_VOLUME);
  });
});

describe("buildEngajadosPlanPreview (#7235)", () => {
  const CUTOFF = "2026-09-01T00:00:00.000Z";
  function row(email: string, priorityPoints: number, lastSentAt: string | null = null) {
    return { email, send_eligible: 1, sends_count: 3, priority_points: priorityPoints, last_sent_at: lastSentAt };
  }

  it("ordena por priority_points DESC e corta pelo volume, reportando a faixa de score selecionada", () => {
    const rows = [row("baixo@x.com", 10), row("alto@x.com", 90), row("medio@x.com", 50)];
    const preview = buildEngajadosPlanPreview(rows, 2, CUTOFF);
    assert.equal(preview.queueEligible, 3);
    assert.equal(preview.excludedByRecency, 0);
    assert.equal(preview.eligibleForRound, 3);
    assert.equal(preview.selectedCount, 2);
    assert.deepEqual(preview.scoreRange, { min: 50, max: 90 }, "alto+medio, nunca baixo");
    assert.equal(preview.remainingAboveCutoff, 1);
  });

  it("exclui quem já recebeu desde o cutoff ANTES de aplicar o volume (mesma ordem do #4765/#7234)", () => {
    const rows = [row("recebeu@x.com", 90, "2026-09-02T00:00:00.000Z"), row("elegivel@x.com", 50)];
    const preview = buildEngajadosPlanPreview(rows, 10, CUTOFF);
    assert.equal(preview.queueEligible, 2);
    assert.equal(preview.excludedByRecency, 1);
    assert.equal(preview.eligibleForRound, 1);
    assert.equal(preview.selectedCount, 1);
  });

  it("ignora quem NÃO bate o predicado isEngajados (não-elegível, sem histórico, sem score)", () => {
    const rows = [
      { email: "inelegivel@x.com", send_eligible: 0, sends_count: 3, priority_points: 90, last_sent_at: null },
      { email: "sem-historico@x.com", send_eligible: 1, sends_count: 0, priority_points: 90, last_sent_at: null },
      { email: "score-zero@x.com", send_eligible: 1, sends_count: 3, priority_points: 0, last_sent_at: null },
      row("ok@x.com", 40),
    ];
    const preview = buildEngajadosPlanPreview(rows, 10, CUTOFF);
    assert.equal(preview.queueEligible, 1);
    assert.equal(preview.selectedCount, 1);
  });

  it("volume 0 ou universo vazio -> selectedCount 0, scoreRange null (não `{min:0,max:0}`)", () => {
    const rows = [row("a@x.com", 40)];
    assert.equal(buildEngajadosPlanPreview(rows, 0, CUTOFF).selectedCount, 0);
    assert.equal(buildEngajadosPlanPreview(rows, 0, CUTOFF).scoreRange, null);
    assert.equal(buildEngajadosPlanPreview([], 100, CUTOFF).scoreRange, null);
  });

  it("volume >= elegíveis -> remainingAboveCutoff 0 (nada sobra pra amanhã)", () => {
    const rows = [row("a@x.com", 40), row("b@x.com", 20)];
    const preview = buildEngajadosPlanPreview(rows, 100, CUTOFF);
    assert.equal(preview.selectedCount, 2);
    assert.equal(preview.remainingAboveCutoff, 0);
  });
});
