/**
 * test/onboarding-followup-rodizio-janela-10773.test.ts (#10773)
 *
 * O rodízio do #10763 rebaixava quem falhou a leitura singular, mas: (1) a
 * marca só sai com uma leitura, e quem fica em `adiado_teto` não é lido —
 * com a etapa acima do teto por vários dias, o rebaixado vencia sem nunca
 * receber; (2) a projeção do teto (`capWindowOverflows`) ordenava sem o
 * rebaixamento e não alarmava essa perda. Agora o rebaixamento cede no
 * último dia da janela e a projeção aplica a mesma regra.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capWindowOverflows,
  isCapDemoted,
  parseFollowupSnippet,
  resolveFollowupConfig,
  type FollowupDue,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const snip = parseFollowupSnippet(`<!--\nassunto: "A"\npreview_text: "P"\n-->\nCorpo`);
const snippets: FollowupSnippets = { apoio30: snip, apoio90: snip, apoio180: snip, apoio360: snip, form: null, form_lembrete: null };

describe("#10773 rebaixamento do rodízio cede no fim da janela", () => {
  const cfg = resolveFollowupConfig({ enabled: true, grace_days: 3 });
  const due = (id: number): FollowupDue => ({ kit_subscriber_id: id, email: `${id}@x.com`, kind: "apoio30" });

  it("isCapDemoted: rebaixa com janela sobrando, cede na última rodada, sem janela rebaixa sempre", () => {
    // janela [T0+30d, T0+33d)
    assert.equal(isCapDemoted(due(1), true, T0, T0 + 30 * DAY + 3600, cfg), true, "3 rodadas restantes");
    assert.equal(isCapDemoted(due(1), true, T0, T0 + 31 * DAY + 3600, cfg), true, "2 rodadas restantes");
    assert.equal(isCapDemoted(due(1), true, T0, T0 + 32 * DAY + 3600, cfg), false, "última rodada: cede");
    assert.equal(isCapDemoted(due(1), false, T0, T0 + 30 * DAY, cfg), false, "sem falha nunca rebaixa");
    assert.equal(isCapDemoted(due(1), true, null, T0 + 30 * DAY, cfg), true, "sem âncora: rebaixa");
    const lembrete: FollowupDue = { kit_subscriber_id: 1, email: "1@x.com", kind: "form_lembrete" };
    assert.equal(isCapDemoted(lembrete, true, T0, T0 + 900 * DAY, cfg), true, "form_lembrete não tem janela");
  });

  it("capWindowOverflows: aplica o rebaixamento rodada a rodada (o rebaixado cede no último dia) sem inventar nem esconder perda", () => {
    // cap 1, janela de 3 rodadas. Pessoa 1 (mais antiga) falhou ontem; 2 e 3
    // têm janela até mais tarde. Rodada 0: 2 (1 rebaixada). Rodada 1: 3.
    // Rodada 2 (última de 1): 1 cede e sai. Nada vence.
    const now = T0 + 30 * DAY + 3600;
    const anchors = new Map([[1, T0], [2, T0 + 2 * DAY], [3, T0 + 2 * DAY + 60]]);
    const list = [1, 2, 3].map(due);
    const anchor = (d: FollowupDue) => anchors.get(d.kit_subscriber_id)!;
    assert.deepEqual(capWindowOverflows(list, 1, now, cfg, anchor, (d) => d.kit_subscriber_id === 1), []);

    // Agora 4 pessoas com a mesma janela de 1 e cap 1: ordem por âncora
    // perde 1 de qualquer jeito; com 1 rebaixada a contagem é a mesma (o
    // rebaixamento não pode inventar nem esconder perda nesse caso).
    const tight = [1, 2, 3, 4].map(due);
    const sameAnchor = (d: FollowupDue) => T0 + d.kit_subscriber_id;
    const base = capWindowOverflows(tight, 1, now, cfg, sameAnchor);
    const withFail = capWindowOverflows(tight, 1, now, cfg, sameAnchor, (d) => d.kit_subscriber_id === 1);
    assert.equal(base[0]!.projected_vencidas, 1);
    assert.equal(withFail[0]!.projected_vencidas, 1);
  });
});

/** Kit fingido para várias rodadas: `failOn(id, dia)` decide se a leitura falha. */
function setup(n: number, failOn: (id: number, day: number) => boolean) {
  const storePath = join(mkdtempSync(join(tmpdir(), "followup-10773-")), "store.json");
  writeStore(emptyStore(), storePath);
  const lots: string[][] = [];
  let seq = 0;
  let day = 0;
  const d: FollowupRoundDeps = {
    async listActiveSubscribers() {
      // id 1 é o cadastro mais antigo; todos na mesma janela de apoio30
      return Array.from({ length: n }, (_, i) => ({
        kit_subscriber_id: i + 1,
        email: `${i + 1}@x.com`,
        cadastro_at: new Date((T0 + i * 60) * 1000).toISOString(),
      }));
    },
    async getSubscriber(id) {
      if (failOn(id, day)) throw new Error("HTTP 429");
      return { state: "active", apoioNivel: "" };
    },
    async listEnvioBrevoEmails() { return []; },
    async fetchFormResponses() { return []; },
    async runLot(lot) {
      lots.push([...lot.recipient_subscription_ids]);
      lot.broadcast_id = 9000 + ++seq;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
    async sleep() {},
    isTransientLookupError: () => true,
  };
  return { storePath, d, lots, setDay: (x: number) => { day = x; } };
}

describe("#10773 teto excedido por vários dias seguidos (regressão)", () => {
  it("quem falhou uma vez é lido e recebe no último dia da janela, em vez de vencer calado", async () => {
    // cap 1, janela de 3 rodadas, 3 pessoas. Dia 0: pessoa 1 falha (429).
    // Antes do fix: dia 1 sai 2, dia 2 sai 3 e a pessoa 1 vence sem ser lida.
    const cfg = resolveFollowupConfig({ enabled: true, max_recipients_per_lot: 1, grace_days: 3 });
    const k = setup(3, (id, day) => id === 1 && day === 0);
    const base = T0 + 30 * DAY + 3600;
    for (let day = 0; day < 3; day++) {
      k.setDay(day);
      await runFollowupRound({ storePath: k.storePath, send: true, cfg, snippets, nowMs: (base + day * DAY) * 1000 }, k.d);
    }
    const sent = k.lots.flat();
    assert.deepEqual(sent, ["2", "1"], "dia 1 sai a saudável; dia 2 a rebaixada cede e recebe");
    const p1 = readStore(k.storePath).store.followup!.people["1"]!;
    assert.equal(p1.sends.length, 1);
    assert.equal(p1.live_failures, undefined, "a leitura do último dia limpa a marca");
  });

  it("a projeção da rodada acusa a perda quando nem cedendo o rebaixado cabe", async () => {
    // cap 1, janela de 3 rodadas, 4 pessoas na mesma janela: 1 vai vencer de
    // qualquer jeito, e o alarme precisa disparar já no dia 0.
    const cfg = resolveFollowupConfig({ enabled: true, max_recipients_per_lot: 1, grace_days: 3 });
    const k = setup(4, (id, day) => id === 1 && day === 0);
    const r = await runFollowupRound({ storePath: k.storePath, send: true, cfg, snippets, nowMs: (T0 + 30 * DAY + 3600) * 1000 }, k.d);
    assert.equal(r.run.cap_window_overflow, 1);
    assert.equal(r.run.counts.apoio30?.excede_janela, 1);
  });
});
