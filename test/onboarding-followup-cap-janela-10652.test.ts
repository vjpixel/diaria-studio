/**
 * test/onboarding-followup-cap-janela-10652.test.ts (#10652)
 *
 * Depois do #10631 (lote parcial até o teto, decisão do editor) o excedente
 * fica só em `counts[etapa].adiado_teto` e não conta como falha. Quando a
 * etapa tem mais elegíveis do que a janela comporta (`eligible > cap ×
 * grace_days`), o resto vira `vencida` sem receber — e saía com exit 0, sem
 * alarme. Agora a rodada marca `cap_window_overflow`, conta como falha
 * (contador de continuidade + exit 1) e o painel mostra o alerta. O lote
 * parcial em si não muda.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capWindowOverflows,
  isFailedFollowupRun,
  parseFollowupSnippet,
  recordFollowupRun,
  resolveFollowupConfig,
  type FollowupDue,
  type FollowupSnippets,
  type FollowupStepKind,
} from "../scripts/lib/onboarding-followup.ts";
import { buildFollowupPanel } from "../scripts/lib/onboarding-followup-panel.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;

// Coorte no 1º dia da janela de D+30 (assinatura nova desde o #10660:
// capacidade por pessoa; ver test/onboarding-followup-cap-por-pessoa-10660.test.ts).
function cohortDue(kind: FollowupStepKind, n: number): FollowupDue[] {
  return Array.from({ length: n }, (_, i) => ({ kit_subscriber_id: i + 1, email: `${i + 1}@x.com`, kind }));
}
const day0 = { nowSec: T0 + 30 * DAY, anchor: () => T0 };
const cfg10 = { graceDays: 10, formFirstDays: 30 };

describe("#10652 capWindowOverflows — excedente que não cabe na janela", () => {
  it("eligible > cap × grace no 1º dia: acusa a etapa com as vencidas", () => {
    assert.deepEqual(capWindowOverflows(cohortDue("apoio30", 5000), 300, day0.nowSec, cfg10, day0.anchor), [
      { kind: "apoio30", eligible: 5000, capacity: 3000, projected_vencidas: 2000 },
    ]);
  });

  it("dentro da janela (inclusive no limite exato) não acusa", () => {
    assert.deepEqual(capWindowOverflows(cohortDue("apoio30", 3000), 300, day0.nowSec, cfg10, day0.anchor), []);
    assert.deepEqual(capWindowOverflows(cohortDue("apoio30", 400), 300, day0.nowSec, cfg10, day0.anchor), []);
  });

  it("form_lembrete não tem janela (só atrasa, nunca vence): fica de fora", () => {
    assert.deepEqual(capWindowOverflows(cohortDue("form_lembrete", 9999), 300, day0.nowSec, cfg10, day0.anchor), []);
    // `form`: âncora da escada + form_first_days (30) — mesmo dia 0 da janela.
    assert.equal(capWindowOverflows(cohortDue("form", 3001), 300, day0.nowSec, cfg10, day0.anchor).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Rodada real do executor (store em disco, Kit fingido)
// ---------------------------------------------------------------------------

function tempStore(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-10652-")), "store.json");
  writeStore(emptyStore(), p);
  return p;
}

const ok = parseFollowupSnippet(`<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo`);
const snippets: FollowupSnippets = { apoio30: ok, apoio90: ok, apoio180: ok, apoio360: ok, form: null, form_lembrete: null };

function deps(n: number): FollowupRoundDeps {
  // Coorte inteira com o mesmo cadastro (a importação do Kit), no mesmo D+30.
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
      lot.broadcast_id = 7000 + ++seq;
      lot.tag_id = 7;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
  };
}

describe("#10652 executor — alarme quando o excedente vai vencer", () => {
  // cap 2 × grace 3 dias = 6 por janela.
  const cfg = { ...resolveFollowupConfig({ enabled: true, grace_days: 3 }), maxRecipientsPerLot: 2 };
  const nowMs = (T0 + 30 * DAY) * 1000;

  it("coorte acima de cap × janela: marca cap_window_overflow, conta como falha e o painel alerta", async () => {
    const storePath = tempStore();
    const r = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs }, deps(10));
    // Decisão do editor (#10631) intacta: lote parcial até o teto.
    assert.equal(r.run.counts.apoio30?.enviado, 2);
    assert.equal(r.run.counts.apoio30?.adiado_teto, 8);
    assert.equal(r.run.over_cap, 0);
    // Visibilidade nova.
    assert.equal(r.run.cap_window_overflow, 1);
    assert.equal(r.run.counts.apoio30?.excede_janela, 4, "10 elegíveis − 6 de capacidade");
    assert.equal(isFailedFollowupRun(r.run), true, "excedente que vai vencer não sai com rodada limpa");

    const block = { people: {}, lots: {}, consecutive_failed_runs: 0 };
    recordFollowupRun(block, r.run);
    assert.equal(block.consecutive_failed_runs, 1, "alimenta o alarme de continuidade");

    const { store } = readStore(storePath);
    store.followup!.last_run = r.run;
    const view = buildFollowupPanel(store, {});
    const alert = view.alerts.find((a) => a.mensagem.includes("não cabe na janela"));
    assert.ok(alert, "painel mostra o alerta já na 1ª rodada");
    assert.match(alert!.mensagem, /estimativa de vencimento sem envio: Apoio D\+30: 4/);
    // `excede_janela` é subconjunto de `adiado_teto`: não soma de novo nos pendentes.
    const step = view.steps.find((s) => s.step === "apoio30")!;
    assert.equal(step.pendentes.adiado_teto, 8);
    assert.equal(step.pendentes.excede_janela, undefined);
  });

  it("coorte acima do teto mas dentro da janela: adiamento normal, sem alarme", async () => {
    const storePath = tempStore();
    const r = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs }, deps(6));
    assert.equal(r.run.counts.apoio30?.adiado_teto, 4);
    assert.equal(r.run.cap_window_overflow, 0);
    assert.equal(r.run.counts.apoio30?.excede_janela, undefined);
    assert.equal(isFailedFollowupRun(r.run), false);
    const { store } = readStore(storePath);
    store.followup!.last_run = r.run;
    assert.ok(!buildFollowupPanel(store, {}).alerts.some((a) => a.mensagem.includes("não cabe na janela")));
  });

  it("registro antigo sem o campo segue não-falho", () => {
    const run = { at: "2026-10-20T12:00:00Z", apoio_blocked: null, form_blocked: null, lots_created: 1, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {} };
    assert.equal(isFailedFollowupRun(run), false);
  });
});
