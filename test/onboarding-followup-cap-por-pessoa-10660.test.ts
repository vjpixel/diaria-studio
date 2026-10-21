/**
 * test/onboarding-followup-cap-por-pessoa-10660.test.ts (#10660)
 *
 * `capWindowOverflows` (#10652) usava capacidade fixa `cap × graceDays`, como
 * se a coorte estivesse sempre no 1º dia da janela. Três falhas: o alarme
 * sumia antes da perda acabar (a coorte encolhe, mas os dias restantes
 * também), excedente pequeno só alarmava no dia 0, e coorte entrando no meio
 * da janela passava calada. Agora a capacidade é por pessoa (dias que restam
 * da janela de cada um), simulada na ordem do corte do teto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capWindowOverflows,
  capWindowStartSec,
  isFailedFollowupRun,
  parseFollowupSnippet,
  resolveFollowupConfig,
  type FollowupDue,
  type FollowupSnippets,
  type FollowupStepKind,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;

function dueOf(kind: FollowupStepKind, n: number, firstId = 1): FollowupDue[] {
  return Array.from({ length: n }, (_, i) => ({ kit_subscriber_id: firstId + i, email: `${firstId + i}@x.com`, kind }));
}

describe("#10660 capWindowOverflows — capacidade por pessoa (puro)", () => {
  const cfg10 = { graceDays: 10, formFirstDays: 30 };

  it("coorte entrando no meio da janela (5 de 10 dias restantes, cap 300, 2.500): alarma 1.000", () => {
    // Cadastro em T0 → janela de D+30 começa em T0+30d; agora é T0+35d.
    const r = capWindowOverflows(dueOf("apoio30", 2500), 300, T0 + 35 * DAY, cfg10, () => T0);
    // A conta antiga (2.500 ≤ 300 × 10) não alarmava.
    assert.deepEqual(r, [{ kind: "apoio30", eligible: 2500, capacity: 1500, projected_vencidas: 1000 }]);
  });

  it("coorte que cabe nos dias restantes: não alarma", () => {
    assert.deepEqual(capWindowOverflows(dueOf("apoio30", 1500), 300, T0 + 35 * DAY, cfg10, () => T0), []);
    assert.deepEqual(capWindowOverflows(dueOf("apoio30", 300), 300, T0 + 39 * DAY, cfg10, () => T0), [], "último dia, cabe num lote");
  });

  it("excedente pequeno (entre 0 e cap) segue alarmando enquanto a perda existe", () => {
    const cfg3 = { graceDays: 3, formFirstDays: 30 };
    // Dia 0: 7 elegíveis, cap 2 × 3 dias = 6 → 1 vence.
    assert.equal(capWindowOverflows(dueOf("apoio30", 7), 2, T0 + 30 * DAY, cfg3, () => T0)[0]?.projected_vencidas, 1);
    // Dia 1: saíram 2, restam 5 para 2 dias × 2 = 4 → ainda 1 vence.
    assert.equal(capWindowOverflows(dueOf("apoio30", 5, 3), 2, T0 + 31 * DAY, cfg3, () => T0)[0]?.projected_vencidas, 1);
    // Dia 2: restam 3 para 1 dia × 2 → ainda 1 vence.
    assert.equal(capWindowOverflows(dueOf("apoio30", 3, 5), 2, T0 + 32 * DAY, cfg3, () => T0)[0]?.projected_vencidas, 1);
  });

  it("segue a ordem do teto: quem vence antes sai antes, sem acusar perda evitável", () => {
    const cfg2 = { graceDays: 2, formFirstDays: 30 };
    const now = T0 + 31 * DAY;
    // id 1: cadastro em T0 (último dia da janela); id 2: cadastro T0+1d (1º dia).
    const anchors = new Map([[1, T0], [2, T0 + DAY]]);
    const anchor = (d: FollowupDue) => anchors.get(d.kit_subscriber_id) ?? null;
    assert.deepEqual(capWindowOverflows(dueOf("apoio30", 2), 1, now, cfg2, anchor), []);
    // Três pessoas, cap 1: o mais novo (id 3, também 1º dia) fica para o dia 2 → vence.
    anchors.set(3, T0 + DAY);
    assert.deepEqual(capWindowOverflows(dueOf("apoio30", 3), 1, now, cfg2, anchor), [
      { kind: "apoio30", eligible: 3, capacity: 2, projected_vencidas: 1 },
    ]);
  });

  it("offsets por etapa: apoio90 e form usam o próprio D+N", () => {
    assert.equal(capWindowStartSec("apoio90", T0, { formFirstDays: 30 }), T0 + 90 * DAY);
    assert.equal(capWindowStartSec("form", T0, { formFirstDays: 14 }), T0 + 14 * DAY);
    assert.equal(capWindowStartSec("form_lembrete", T0, { formFirstDays: 14 }), null);
    assert.equal(capWindowStartSec("apoio30", null, { formFirstDays: 14 }), null);
    // apoio90 no 8º dia da janela de 10: 3 dias × 300 = 900 cabem.
    const r = capWindowOverflows(dueOf("apoio90", 1000), 300, T0 + 97 * DAY, cfg10, () => T0);
    assert.deepEqual(r, [{ kind: "apoio90", eligible: 1000, capacity: 900, projected_vencidas: 100 }]);
  });

  it("devido sem âncora não tem prazo conhecido: não conta como vencida", () => {
    assert.deepEqual(capWindowOverflows(dueOf("apoio30", 50), 1, T0 + 39 * DAY, cfg10, () => null), []);
  });
});

// ---------------------------------------------------------------------------
// Rodadas seguidas do executor sobre a mesma coorte (store em disco)
// ---------------------------------------------------------------------------

const ok = parseFollowupSnippet(`<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo`);
const snippets: FollowupSnippets = { apoio30: ok, apoio90: ok, apoio180: ok, apoio360: ok, form: null, form_lembrete: null };

function deps(n: number): FollowupRoundDeps {
  const cohort = Array.from({ length: n }, (_, i) => ({
    kit_subscriber_id: i + 1,
    email: `${i + 1}@x.com`,
    cadastro_at: new Date(T0 * 1000).toISOString(),
  }));
  let seq = 0;
  return {
    listActiveSubscribers: async () => cohort,
    getSubscriber: async () => ({ state: "active", apoioNivel: "" }),
    listEnvioBrevoEmails: async () => [],
    fetchFormResponses: async () => [],
    async runLot(lot) {
      lot.broadcast_id = 9000 + ++seq;
      lot.tag_id = 7;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
  };
}

describe("#10660 executor — dias 30, 31 e 32 sobre a mesma coorte", () => {
  // cap 2, janela de 3 dias. `min_gap_days` não interfere: cada pessoa recebe 1 só.
  const cfg = { ...resolveFollowupConfig({ enabled: true, grace_days: 3 }), maxRecipientsPerLot: 2 };

  async function rounds(n: number, days: number[]) {
    const storePath = join(mkdtempSync(join(tmpdir(), "followup-10660-")), "store.json");
    writeStore(emptyStore(), storePath);
    const d = deps(n);
    const out = [];
    for (const day of days) out.push((await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: (T0 + day * DAY) * 1000 }, d)).run);
    return out;
  }

  it("10 elegíveis: o alarme continua até o fim da janela (antes sumia no dia 32) e cessa quando a perda se consuma", async () => {
    const [d30, d31, d32, d33] = await rounds(10, [30, 31, 32, 33]);
    for (const [label, r] of [["dia 30", d30], ["dia 31", d31], ["dia 32", d32]] as const) {
      assert.equal(r.counts.apoio30?.enviado, 2, `${label}: lote parcial até o teto (#10631)`);
      assert.equal(r.cap_window_overflow, 1, `${label}: alarme segue enquanto houver perda`);
      assert.equal(r.counts.apoio30?.excede_janela, 4, `${label}: as mesmas 4 pessoas vão vencer`);
      assert.equal(isFailedFollowupRun(r), true, label);
    }
    // Dia 33: janela fechada — as 4 viraram `vencida` (já contado), nada mais a projetar.
    assert.equal(d33.cap_window_overflow, 0);
    assert.equal(d33.counts.apoio30?.vencida, 4);
    assert.equal(d33.counts.apoio30?.excede_janela, undefined);
  });

  it("6 elegíveis (cabe na janela): nenhuma rodada alarma, e ninguém vence", async () => {
    const runs = await rounds(6, [30, 31, 32, 33]);
    for (const r of runs) {
      assert.equal(r.cap_window_overflow, 0);
      assert.equal(isFailedFollowupRun(r), false);
    }
    assert.deepEqual(runs.slice(0, 3).map((r) => r.counts.apoio30?.enviado), [2, 2, 2]);
    assert.equal(runs[3].counts.apoio30?.vencida, undefined);
  });
});
