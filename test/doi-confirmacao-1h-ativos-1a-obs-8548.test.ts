/**
 * test/doi-confirmacao-1h-ativos-1a-obs-8548.test.ts — #8548, reavaliação de
 * 04/11/2026 com a 1ª semana da task horária.
 *
 * Achado: dos 24 cadastros observados (28/10 a 04/11), 9 já estavam `active`
 * na 1ª observação, feita menos de 1h depois do cadastro, e os 12 membros
 * (1ª observação `inactive`) não confirmaram em 48h. O relatório mostrava só
 * "1h: 0,0% (0/11)" e um aviso que juntava esses 9 com os vistos tarde. Lido
 * sozinho, o número diz "ninguém confirma em 1h", o contrário do dado.
 *
 * O contador novo não muda a taxa (os 9 são ambíguos: confirmação rápida ou
 * single opt-in), só separa quem estava ativo cedo de quem foi visto tarde.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHourlyConfirmationReport,
  renderHourlyConfirmationText,
  MAX_FIRST_SEEN_LAG_HOURS,
  type HourlyObservation,
} from "../scripts/lib/subscriber-hourly-confirmation.ts";

const T0 = Date.parse("2026-10-28T22:00:00Z");
const at = (h: number) => new Date(T0 + h * 3_600_000);
const created = (minAfterT0: number) => new Date(T0 + minAfterT0 * 60_000).toISOString();

// id 1: active na 1ª obs, 30 min após o cadastro (ativo cedo).
// id 2: active na 1ª obs, mas visto 5h depois (tarde, não conta como cedo).
// id 3: cancelled na 1ª obs, cedo (outro estado, não conta).
// id 4: inactive na 1ª obs, nunca confirma (membro).
const records = (): HourlyObservation["records"] => [
  { id: 1, state: "active", created_at: created(0) },
  { id: 3, state: "cancelled", created_at: created(0) },
  { id: 4, state: "inactive", created_at: created(0) },
];
const obs: HourlyObservation[] = [
  { at: at(0.5), records: records() },
  { at: at(1.5), records: records() },
  { at: at(5), records: [...records(), { id: 2, state: "active", created_at: created(0) }] },
  { at: at(25), records: [...records(), { id: 2, state: "active", created_at: created(0) }] },
];

describe("#8548 — ativos na 1ª observação horária", () => {
  it("conta só quem estava active numa 1ª observação dentro do lag máximo", () => {
    assert.equal(MAX_FIRST_SEEN_LAG_HOURS, 2);
    const r = buildHourlyConfirmationReport(obs);
    assert.equal(r.membros, 1);
    assert.equal(r.fora_de_escopo, 3);
    assert.equal(r.ativos_na_1a_observacao, 1);
  });

  it("não muda a taxa: o ativo cedo segue fora do denominador", () => {
    const r = buildHourlyConfirmationReport(obs);
    const w1 = r.janelas.find((w) => w.horas === 1)!;
    assert.deepEqual([w1.confirmados, w1.maduros], [0, 1]);
  });

  it("o texto mostra o contador no cabeçalho e no aviso", () => {
    const text = renderHourlyConfirmationText(buildHourlyConfirmationReport(obs));
    assert.match(text, /já active na 1ª observação \(≤2h, fora das taxas\): 1/);
    assert.match(text, /AVISO: 1 desses já estavam active numa 1ª observação feita até 2h/);
  });

  it("sem ninguém ativo cedo, contador 0 e sem o aviso", () => {
    const r = buildHourlyConfirmationReport([
      { at: at(0.5), records: [{ id: 4, state: "inactive", created_at: created(0) }] },
      { at: at(2), records: [{ id: 4, state: "active", created_at: created(0) }] },
    ]);
    assert.equal(r.ativos_na_1a_observacao, 0);
    assert.doesNotMatch(renderHourlyConfirmationText(r), /desses já estavam active/);
    assert.equal(buildHourlyConfirmationReport([]).ativos_na_1a_observacao, 0);
  });
});
