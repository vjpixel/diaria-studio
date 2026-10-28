/**
 * test/brevo-semanal-terca-id-11420.test.ts (#11420)
 *
 * Regressão: o score semanal da Brevo diária contava como semanal TODO envio
 * de terça para quem é do grupo "terça" da divisão (#11286), não só a
 * campanha de terça da semanal dividida. Na transição (#10533) ou com
 * `--fora-da-segunda`, a Brevo manda campanha de terça que não é semanal —
 * o grupo "terça" acumulava 2 semanais por semana e era suprimido em ~2
 * semanas em vez de 4. Agora a terça só conta pelo id (`terca_campaign_id`).
 * Nada aqui toca a Brevo: entrada sintética e um diretório temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSemanalEvaluationInput, isSemanalSendDay, semanalSplitGroup } from "../scripts/lib/brevo-diaria-semanal.ts";
import { collectTercaCampaignIds } from "../scripts/evaluate-brevo-diaria.ts";
import { writeBrevoDiariaPublished, type BrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";

function tercaEmail(): string {
  for (let i = 0; ; i++) {
    const e = `contato${i}@exemplo.com`;
    if (semanalSplitGroup(e) === "terca") return e;
  }
}

describe("score semanal: terça só conta pela campanha de terça da semanal dividida (#11420)", () => {
  const desdeMs = Date.parse("2026-11-02T00:00:00-03:00");
  const nowMs = Date.parse("2026-12-01T12:00:00Z");
  const email = tercaEmail();
  // Duas semanas: segunda (semanal) + terça de TRANSIÇÃO (#10533, não é a
  // campanha de terça da divisão) em cada uma.
  const transicao = {
    messagesSent: [
      { campaignId: 10, eventTime: "2026-11-02T09:00:00Z" }, // segunda 06:00 BRT
      { campaignId: 11, eventTime: "2026-11-03T09:00:00Z" }, // terça (diária da transição)
      { campaignId: 12, eventTime: "2026-11-09T09:00:00Z" }, // segunda
      { campaignId: 13, eventTime: "2026-11-10T09:00:00Z" }, // terça (--fora-da-segunda)
    ],
  };

  it("contato do grupo terça NÃO acumula 2 semanais por semana com terça fora da divisão", () => {
    const r = buildSemanalEvaluationInput(transicao, desdeMs, nowMs, email, new Set([999]));
    assert.equal(r.semanais.length, 2, "só as 2 segundas contam");
    assert.deepEqual(
      r.semanais.map((s) => s.sentAtMs).sort(),
      [Date.parse("2026-11-02T09:00:00Z"), Date.parse("2026-11-09T09:00:00Z")],
    );
  });

  it("sem ids registrados, nenhuma terça conta (direção que não suprime)", () => {
    assert.equal(buildSemanalEvaluationInput(transicao, desdeMs, nowMs, email).semanais.length, 2);
  });

  it("a campanha de terça da semanal dividida continua contando", () => {
    const dividida = {
      messagesSent: [
        { campaignId: 20, eventTime: "2026-11-03T09:00:00Z" }, // terça da divisão
        { campaignId: 21, eventTime: "2026-11-10T09:00:00Z" }, // terça da divisão
        { campaignId: 22, eventTime: "2026-11-11T09:00:00Z" }, // quarta: nunca
      ],
    };
    assert.equal(buildSemanalEvaluationInput(dividida, desdeMs, nowMs, email, new Set([20, 21])).semanais.length, 2);
  });

  it("isSemanalSendDay: terça exige o id da campanha de terça", () => {
    const terca = Date.parse("2026-11-03T09:00:00Z");
    assert.equal(isSemanalSendDay(terca, email), false);
    assert.equal(isSemanalSendDay(terca, email, 5, new Set([6])), false);
    assert.equal(isSemanalSendDay(terca, email, 6, new Set([6])), true);
    assert.equal(isSemanalSendDay(Date.parse("2026-11-02T09:00:00Z"), email), true, "segunda sempre conta");
  });
});

describe("collectTercaCampaignIds (#11420)", () => {
  const base: BrevoDiariaPublished = {
    campaign_id: 1,
    subject: "s",
    preview_text: "p",
    status: "scheduled",
    list_id: 7,
    created_at: "2026-11-01T20:00:00.000Z",
  };

  it("lê terca_campaign_id das edições (nested e flat) e ignora edição sem divisão", () => {
    const root = mkdtempSync(join(tmpdir(), "terca-ids-"));
    try {
      writeBrevoDiariaPublished(join(root, "2611", "261103"), { ...base, terca_list_id: 8, terca_campaign_id: 41 });
      writeBrevoDiariaPublished(join(root, "261110"), { ...base, terca_list_id: 8, terca_campaign_id: 42 });
      writeBrevoDiariaPublished(join(root, "2611", "261104"), { ...base, campaign_id: 2 });
      const ids = collectTercaCampaignIds(root);
      assert.deepEqual([...ids].sort(), [41, 42]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pasta ausente ⇒ conjunto vazio", () => {
    assert.equal(collectTercaCampaignIds(join(tmpdir(), "nao-existe-11420-xyz")).size, 0);
  });
});
