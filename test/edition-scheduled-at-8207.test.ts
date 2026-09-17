/**
 * test/edition-scheduled-at-8207.test.ts (#8207)
 *
 * Cobre `scripts/lib/edition-scheduled-at.ts` — a causa raiz do bug era a
 * Etapa 6 resolvendo "amanhã HH:MM BRT" contra o RELÓGIO em vez da data da
 * edição, quando rodada depois da meia-noite BRT. O teste central aqui é
 * justamente esse: `resolveEditionScheduledAt` nunca deve depender de
 * `now`/`Date.now()` — não recebe clock nenhum como parâmetro, então não tem
 * como fazer essa conta errada de novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEditionScheduledAt,
  editionAammddFromDir,
  checkScheduledAtMatchesEditionDate,
  DEFAULT_EDITION_SCHEDULE_HHMM,
} from "../scripts/lib/edition-scheduled-at.ts";

describe("resolveEditionScheduledAt (#8207 item 1)", () => {
  it("AAMMDD + HH:MM BRT → ISO UTC (BRT = UTC-3, caso simples)", () => {
    assert.equal(resolveEditionScheduledAt("260917", "06:00"), "2026-09-17T09:00:00.000Z");
  });

  it("default HH:MM é 06:00 (mesmo default já documentado no playbook)", () => {
    assert.equal(DEFAULT_EDITION_SCHEDULE_HHMM, "06:00");
    assert.equal(resolveEditionScheduledAt("260917"), resolveEditionScheduledAt("260917", "06:00"));
  });

  it("gate respondido 'sim HH:MM' DEPOIS da meia-noite BRT (#8207 — cenário real da edição 260917) ainda resolve pra data da EDIÇÃO, nunca pra D+1", () => {
    // A causa raiz: gate 6 respondido às 00:19 BRT de 17/09 (=03:19 UTC),
    // "amanhã" resolvido contra o relógio virava 18/09. Esta função nunca
    // recebe `now`/clock — não tem como repetir esse erro.
    assert.equal(resolveEditionScheduledAt("260917", "06:00"), "2026-09-17T09:00:00.000Z");
  });

  it("horário que viraria o dia em UTC (22:00 BRT) soma corretamente pro dia seguinte em UTC — comportamento CORRETO, não um bug de overflow", () => {
    assert.equal(resolveEditionScheduledAt("260917", "22:00"), "2026-09-18T01:00:00.000Z");
  });

  it("AAMMDD inválido (calendário impossível) → lança", () => {
    assert.throws(() => resolveEditionScheduledAt("260631", "06:00"));
    assert.throws(() => resolveEditionScheduledAt("260230", "06:00"));
  });

  it("AAMMDD malformado (não 6 dígitos) → lança", () => {
    assert.throws(() => resolveEditionScheduledAt("26091", "06:00"));
    assert.throws(() => resolveEditionScheduledAt("abcdef", "06:00"));
  });

  it("HH:MM malformado ou fora do range → lança", () => {
    assert.throws(() => resolveEditionScheduledAt("260917", "24:00"));
    assert.throws(() => resolveEditionScheduledAt("260917", "06:60"));
    assert.throws(() => resolveEditionScheduledAt("260917", "not-a-time"));
  });
});

describe("editionAammddFromDir", () => {
  it("edition-dir flat → AAMMDD do basename", () => {
    assert.equal(editionAammddFromDir("/data/editions/260917"), "260917");
  });

  it("edition-dir nested (YYMM/AAMMDD) → AAMMDD do basename (último segmento)", () => {
    assert.equal(editionAammddFromDir("/data/editions/2609/260917"), "260917");
    assert.equal(editionAammddFromDir("/data/editions/2609/260917/"), "260917");
  });

  it("path que não termina em AAMMDD (ex: tmpdir de teste) → null", () => {
    assert.equal(editionAammddFromDir("/tmp/kit-schedule-main-abc123"), null);
    assert.equal(editionAammddFromDir("/tmp/edicao-fake-6048"), null);
  });
});

describe("checkScheduledAtMatchesEditionDate (#8207 item 2)", () => {
  it("scheduledAt no MESMO dia civil BRT da edição → ok", () => {
    const result = checkScheduledAtMatchesEditionDate("260917", "2026-09-17T09:00:00.000Z");
    assert.equal(result.ok, true);
  });

  it("scheduledAt 1 dia DEPOIS (o bug do #8207: 'amanhã' resolvido contra o relógio) → reprovado", () => {
    const result = checkScheduledAtMatchesEditionDate("260917", "2026-09-18T09:00:00.000Z");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /260918/);
      assert.match(result.reason, /260917/);
      assert.match(result.reason, /--allow-other-date/);
    }
  });

  it("scheduledAt 1 dia ANTES → também reprovado (a checagem não é só 'não atrasar')", () => {
    const result = checkScheduledAtMatchesEditionDate("260917", "2026-09-16T09:00:00.000Z");
    assert.equal(result.ok, false);
  });

  it("allowOtherDate=true → sempre ok, mesmo com data divergente (escape hatch nomeado)", () => {
    const result = checkScheduledAtMatchesEditionDate("260917", "2026-09-18T09:00:00.000Z", true);
    assert.equal(result.ok, true);
  });

  it("scheduledAt ISO malformado → reprovado com mensagem clara (nunca finge que bate)", () => {
    const result = checkScheduledAtMatchesEditionDate("260917", "não-é-uma-data");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /ISO 8601/);
  });

  it("horário perto da virada de dia BRT (03:00 UTC = 00:00 BRT) ainda cai no dia civil correto", () => {
    // 2026-09-17T03:00:00Z = 2026-09-17T00:00:00-03:00 — início do dia civil BRT 260917.
    const result = checkScheduledAtMatchesEditionDate("260917", "2026-09-17T03:00:00.000Z");
    assert.equal(result.ok, true);
    // 1ms antes já é o dia civil BRT anterior (260916).
    const before = checkScheduledAtMatchesEditionDate("260917", "2026-09-17T02:59:59.999Z");
    assert.equal(before.ok, false);
  });
});
