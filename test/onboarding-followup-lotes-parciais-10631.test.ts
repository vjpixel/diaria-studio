/**
 * test/onboarding-followup-lotes-parciais-10631.test.ts (#10631)
 *
 * Decisão do editor (21/10/2026): etapa com mais elegíveis que
 * `max_recipients_per_lot` sai em LOTES PARCIAIS até o teto por dia — o
 * restante fica para os dias seguintes, dentro da janela da etapa. Antes, a
 * etapa inteira era barrada (`acima_do_teto`) e, depois de ~10 rodadas com
 * alarme, virava `vencida` para todos (cenário real: a coorte importada no Kit
 * em 04/09 carrega o `created_at` da importação e cai inteira no mesmo D+90).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  splitDueByCap,
  parseFollowupSnippet,
  resolveFollowupConfig,
  isFailedFollowupRun,
  type FollowupDue,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;

function due(id: number, kind: FollowupDue["kind"] = "apoio90"): FollowupDue {
  return { kit_subscriber_id: id, email: `${id}@x.com`, kind };
}

describe("#10631 splitDueByCap — lote parcial até o teto", () => {
  it("etapa acima do teto: mantém os `cap` de cadastro mais antigo e adia o resto", () => {
    const list = [due(1), due(2), due(3), due(4), due(5)];
    // id 5 é o mais antigo, id 1 o mais novo.
    const sec = new Map([[1, 500], [2, 400], [3, 300], [4, 200], [5, 100]]);
    const r = splitDueByCap(list, 2, (d) => sec.get(d.kit_subscriber_id) ?? null);
    assert.deepEqual(r.within.map((d) => d.kit_subscriber_id).sort(), [4, 5]);
    assert.deepEqual(r.deferred, [{ kind: "apoio90", eligible: 5, deferred: 3 }]);
  });

  it("ordem determinística: empate desempata por id; sem data vai por último", () => {
    const list = [due(9), due(3), due(7), due(1)];
    const sec = new Map<number, number | null>([[9, 100], [3, 100], [7, null], [1, null]]);
    const r = splitDueByCap(list, 3, (d) => sec.get(d.kit_subscriber_id) ?? null);
    assert.deepEqual(new Set(r.within.map((d) => d.kit_subscriber_id)), new Set([3, 9, 1]));
    // Mesma entrada em outra ordem: mesmo corte.
    const r2 = splitDueByCap([...list].reverse(), 3, (d) => sec.get(d.kit_subscriber_id) ?? null);
    assert.deepEqual(new Set(r2.within.map((d) => d.kit_subscriber_id)), new Set([3, 9, 1]));
  });

  it("etapa dentro do teto sai inalterada (mesmos itens, mesma ordem, nada adiado)", () => {
    const list = [due(3), due(1, "form"), due(2)];
    const r = splitDueByCap(list, 2);
    assert.deepEqual(r.within, list);
    assert.deepEqual(r.deferred, []);
    // Exatamente no teto também não adia.
    assert.deepEqual(splitDueByCap([due(1), due(2)], 2).deferred, []);
  });

  it("o teto vale por etapa: cada etapa acima do teto é cortada separadamente (D+30/90/180/360 e formulário)", () => {
    const list = [
      ...[1, 2, 3].map((i) => due(i, "apoio30")),
      ...[4, 5, 6].map((i) => due(i, "apoio180")),
      ...[7, 8].map((i) => due(i, "apoio360")),
      ...[10, 11, 12].map((i) => due(i, "form")),
    ];
    const r = splitDueByCap(list, 2);
    assert.deepEqual(r.deferred, [
      { kind: "apoio30", eligible: 3, deferred: 1 },
      { kind: "apoio180", eligible: 3, deferred: 1 },
      { kind: "form", eligible: 3, deferred: 1 },
    ]);
    assert.equal(r.within.length, 8);
  });
});

// ---------------------------------------------------------------------------
// Rodadas reais do executor (store em disco, Kit fingido), dia após dia
// ---------------------------------------------------------------------------

function tempStore(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-10631-")), "store.json");
  writeStore(emptyStore(), p);
  return p;
}

function okSnippet(withPlaceholder = false): string {
  return `<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo${withPlaceholder ? " {{FORM_URL}}" : ""}`;
}

const snippets: FollowupSnippets = {
  apoio30: parseFollowupSnippet(okSnippet()),
  apoio90: parseFollowupSnippet(okSnippet()),
  apoio180: parseFollowupSnippet(okSnippet()),
  apoio360: parseFollowupSnippet(okSnippet()),
  form: null,
  form_lembrete: null,
};

/** Coorte de 5 com cadastro escalonado em horas (todos no mesmo D+90): id 5 é o mais antigo. */
const COHORT = [1, 2, 3, 4, 5].map((i) => ({
  kit_subscriber_id: i,
  email: `${i}@x.com`,
  cadastro_at: new Date((T0 - i * 3600) * 1000).toISOString(),
}));

function deps(): FollowupRoundDeps & { lots: string[][] } {
  const lots: string[][] = [];
  let seq = 0;
  return {
    lots,
    async listActiveSubscribers() {
      return COHORT;
    },
    async getSubscriber() {
      return { state: "active", apoioNivel: "" };
    },
    async listEnvioBrevoEmails() {
      return [];
    },
    async fetchFormResponses() {
      return [];
    },
    async runLot(lot) {
      lots.push([...lot.recipient_subscription_ids]);
      lot.broadcast_id = 5000 + ++seq;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
  };
}

describe("#10631 executor — excedente sai nos dias seguintes, sem duplicidade", () => {
  it(">teto elegíveis em D+90: manda o teto, adia o resto; dias seguintes mandam o resto; ninguém recebe 2 vezes", async () => {
    const storePath = tempStore();
    const cfg = { ...resolveFollowupConfig({ enabled: true }), maxRecipientsPerLot: 2 };
    const d = deps();
    const day = (n: number) => (T0 + 90 * DAY + n * DAY) * 1000;

    const r1 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(0) }, d);
    assert.deepEqual(d.lots.map((l) => [...l].sort()), [["4", "5"]], "cadastro mais antigo primeiro");
    assert.equal(r1.run.counts.apoio90?.enviado, 2);
    assert.equal(r1.run.counts.apoio90?.adiado_teto, 3);
    assert.equal(r1.run.counts.apoio90?.vencida, undefined, "excedente dentro da janela nunca vira vencida");
    assert.equal(r1.run.over_cap, 0);
    assert.equal(isFailedFollowupRun(r1.run), false, "adiamento pelo teto não é falha (sem alarme)");

    // Mesmo dia, nova rodada: o teto é por dia (lote da etapa/dia já existe).
    await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(0) + 3_600_000 }, d);
    assert.equal(d.lots.length, 1, "rerun no mesmo dia não manda um 2º lote");

    const r2 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(1) }, d);
    assert.deepEqual([...d.lots[1]].sort(), ["2", "3"]);
    assert.equal(r2.run.counts.apoio90?.adiado_teto, 1);
    assert.equal(r2.run.counts.apoio90?.vencida, undefined);

    const r3 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(2) }, d);
    assert.deepEqual(d.lots[2], ["1"]);
    assert.equal(r3.run.counts.apoio90?.adiado_teto, undefined);

    const r4 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(3) }, d);
    assert.equal(d.lots.length, 3, "nada sobrou");
    assert.equal(r4.run.lots_created, 0);

    const all = d.lots.flat();
    assert.equal(new Set(all).size, all.length, "nenhum destinatário em 2 lotes");
    assert.deepEqual([...all].sort(), ["1", "2", "3", "4", "5"]);
    const { store } = readStore(storePath);
    for (const c of COHORT) {
      const sends = store.followup!.people[String(c.kit_subscriber_id)].sends.filter((s) => s.step === "apoio90");
      assert.equal(sends.length, 1, `id ${c.kit_subscriber_id} recebeu D+90 exatamente 1 vez`);
    }
  });

  it("excedente segue devido até o último dia da janela e só vira vencida depois dela", async () => {
    const storePath = tempStore();
    const cfg = { ...resolveFollowupConfig({ enabled: true, grace_days: 2 }), maxRecipientsPerLot: 2 };
    const d = deps();
    // Cadastro de todos em T0 exato — janela D+90 = [T0+90d, T0+92d).
    const sameDay = COHORT.map((c) => ({ ...c, cadastro_at: new Date(T0 * 1000).toISOString() }));
    d.listActiveSubscribers = async () => sameDay;
    const at = (s: number) => (T0 + 90 * DAY + s) * 1000;

    await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: at(0) }, d);
    const last = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: at(2 * DAY - 60) }, d);
    assert.equal(last.run.counts.apoio90?.vencida, undefined);
    assert.equal(last.run.counts.apoio90?.adiado_teto, 1);
    const after = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: at(2 * DAY) }, d);
    assert.equal(after.run.counts.apoio90?.vencida, 1, "fora da janela: vencida, nunca enviada atrasada");
    assert.equal(d.lots.flat().length, 4);
  });

  it("etapa dentro do teto: lote único com todos, sem adiamento", async () => {
    const storePath = tempStore();
    const cfg = resolveFollowupConfig({ enabled: true });
    const d = deps();
    const r = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: (T0 + 90 * DAY) * 1000 }, d);
    assert.equal(d.lots.length, 1);
    assert.equal(d.lots[0].length, 5);
    assert.equal(r.run.counts.apoio90?.adiado_teto, undefined);
    assert.equal(r.run.counts.apoio90?.enviado, 5);
  });
});
