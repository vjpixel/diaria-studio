/**
 * test/beehiiv-backfill.test.ts (#7179, F7 do épico #7172)
 *
 * Cobre o miolo puro `scripts/lib/metrics/beehiiv-backfill.ts` contra os
 * casos citados no corpo da issue #7179 (aparição mais antiga vence,
 * `reativado: true` quando o `id` muda, fronteira 2026-08-25, idempotência
 * de entrada, agregação por dia e enumeração do seed do log).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBeehiivBackfillRows,
  countBackfillRowsByDay,
  enumerateSeedGapDays,
  normalizeEmail,
  BACKFILL_WINDOW_END_EXCLUSIVE,
  ATRIBUICAO_FONTE_BEEHIIV,
} from "../scripts/lib/metrics/beehiiv-backfill.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function sub(overrides: Partial<BeehiivBackupSubscriber> & { email: string; created: number }): BeehiivBackupSubscriber {
  return {
    status: "active",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  };
}

const D_2025_09_13 = Math.floor(new Date("2025-09-13T12:00:00.000Z").getTime() / 1000);
const D_2026_08_04 = Math.floor(new Date("2026-08-04T12:00:00.000Z").getTime() / 1000);
const D_2026_06_01 = Math.floor(new Date("2026-06-01T12:00:00.000Z").getTime() / 1000);
const D_2026_08_25 = Math.floor(new Date("2026-08-25T12:00:00.000Z").getTime() / 1000); // fora da janela
const D_2026_08_24 = Math.floor(new Date("2026-08-24T12:00:00.000Z").getTime() / 1000); // dentro (fronteira, dia BRT)

describe("normalizeEmail", () => {
  it("trim + lowercase, mesma fórmula de cac.ts", () => {
    assert.equal(normalizeEmail("  Foo@Bar.COM  "), "foo@bar.com");
  });
});

describe("buildBeehiivBackfillRows — aparição mais antiga vence", () => {
  it("e-mail com 2 id e 2 created distintos entra 1x só, com o created mais antigo e reativado: true (achado #7179)", () => {
    const snapshotJunho = [
      sub({ email: "ana@x.com", id: "id-original", created: D_2025_09_13, utm_source: "linkedin", utm_medium: "social" }),
    ];
    const snapshotAgosto = [
      // DELETE+CREATE da reativação: novo id, novo created, utm_source de reativação.
      sub({ email: "ana@x.com", id: "id-reativado", created: D_2026_08_04, utm_source: "brevo-diaria", utm_medium: "email" }),
    ];
    const { rows } = buildBeehiivBackfillRows([snapshotJunho, snapshotAgosto]);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.email, "ana@x.com");
    assert.equal(row.reativado, true);
    assert.equal(row.enteredAt, new Date(D_2025_09_13 * 1000).toISOString());
    assert.equal(row.externalId, "id-original");
    // #7179: reativado → utm_medium/campaign/channel nulos, utm_source
    // sobrevive (já veio da camada de origem recuperada, aplicada pelo
    // chamador antes de chegar aqui — aqui só reflete o que veio na
    // aparição mais antiga).
    assert.equal(row.utmMedium, null);
    assert.equal(row.utmSource, "linkedin");
    assert.equal(row.atribuicaoFonte, ATRIBUICAO_FONTE_BEEHIIV);
    assert.equal(row.origemSerie, "backfill-beehiiv");
  });

  it("e-mail presente em 2 snapshots (mesmo id) entra 1x só, sem reativado", () => {
    const s1 = [sub({ email: "bea@x.com", id: "id-1", created: D_2026_06_01, utm_source: "google" })];
    const s2 = [sub({ email: "BEA@x.com", id: "id-1", created: D_2026_06_01, utm_source: "google" })]; // mesmo email, capitalização diferente
    const { rows } = buildBeehiivBackfillRows([s1, s2]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reativado, false);
    assert.equal(rows[0].utmSource, "google");
  });

  it("origem recuperada prevalece: aparição mais antiga já vem com utm_source/referring_site sobrescritos pelo chamador", () => {
    // Simula o que `applyOrigemOverride` (scripts/lib/cac.ts) já teria feito
    // ANTES de chegar aqui — este módulo não reaplica a sobrescrita, só
    // confia no que veio na aparição mais antiga.
    const snapshot = [
      sub({
        email: "carla@x.com",
        id: "id-carla",
        created: D_2026_06_01,
        utm_source: "origem-recuperada", // já veio sobrescrito
        referring_site: "https://origem.example/",
      }),
    ];
    const { rows } = buildBeehiivBackfillRows([snapshot]);
    assert.equal(rows[0].utmSource, "origem-recuperada");
    assert.equal(rows[0].referringSite, "https://origem.example/");
  });

  it("idempotente na ENTRADA: rodar 2x com os mesmos snapshots produz as mesmas linhas", () => {
    const snapshot = [sub({ email: "dan@x.com", id: "id-dan", created: D_2026_06_01, utm_source: "x" })];
    const r1 = buildBeehiivBackfillRows([snapshot]);
    const r2 = buildBeehiivBackfillRows([snapshot]);
    assert.deepEqual(r1.rows, r2.rows);
  });

  it("nunca duplica e-mail no resultado, mesmo com o mesmo e-mail repetido dentro do MESMO snapshot", () => {
    const snapshot = [
      sub({ email: "eva@x.com", id: "id-eva", created: D_2026_06_01 }),
      sub({ email: "eva@x.com", id: "id-eva", created: D_2026_06_01 }),
    ];
    const { rows } = buildBeehiivBackfillRows([snapshot]);
    assert.equal(rows.length, 1);
  });
});

describe("buildBeehiivBackfillRows — fronteira 2026-08-25 (decisão 10/11 do #7172)", () => {
  it("entered_at cujo dia BRT é >= 2026-08-25 é EXCLUÍDO (série viva do Kit assume a partir daí)", () => {
    const snapshot = [sub({ email: "fora@x.com", id: "id-fora", created: D_2026_08_25 })];
    const { rows, excludedByWindow, totalEmailsSeen } = buildBeehiivBackfillRows([snapshot]);
    assert.equal(rows.length, 0);
    assert.equal(excludedByWindow, 1);
    assert.equal(totalEmailsSeen, 1);
  });

  it("entered_at em 2026-08-24 (fronteira, dia BRT) é INCLUÍDO — nunca escreve >= 2026-08-25, mas 24/08 vale", () => {
    const snapshot = [sub({ email: "dentro@x.com", id: "id-dentro", created: D_2026_08_24 })];
    const { rows } = buildBeehiivBackfillRows([snapshot]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].dia < BACKFILL_WINDOW_END_EXCLUSIVE);
  });
});

describe("countBackfillRowsByDay", () => {
  it("agrupa por dia, ordem ascendente", () => {
    const s = [
      sub({ email: "a@x.com", id: "a", created: D_2026_06_01 }),
      sub({ email: "b@x.com", id: "b", created: D_2026_06_01 }),
      sub({ email: "c@x.com", id: "c", created: D_2025_09_13 }),
    ];
    const { rows } = buildBeehiivBackfillRows([s]);
    const byDay = countBackfillRowsByDay(rows);
    assert.equal(byDay.length, 2);
    assert.ok(byDay[0].dia < byDay[1].dia);
    const junho = byDay.find((d) => d.total === 2);
    assert.ok(junho);
  });
});

describe("enumerateSeedGapDays", () => {
  it("enumera [2026-08-25, until] inclusive", () => {
    const days = enumerateSeedGapDays("2026-08-27");
    assert.deepEqual(days, ["2026-08-25", "2026-08-26", "2026-08-27"]);
  });

  it("until igual à fronteira devolve 1 dia só", () => {
    assert.deepEqual(enumerateSeedGapDays("2026-08-25"), ["2026-08-25"]);
  });

  it("lança quando until é anterior à fronteira", () => {
    assert.throws(() => enumerateSeedGapDays("2026-08-24"), /anterior à fronteira/);
  });
});
