/**
 * test/geo-citation-staleness-por-painel-4900.test.ts (#4900)
 *
 * Regressão do buraco que a ativação do 2º painel abriria: com dois painéis
 * escrevendo no MESMO `history.jsonl`, o alarme de staleness (#4755) passaria
 * a olhar "a última linha do arquivo" e concluir saúde a partir de um painel
 * só. Se o passo `hubs` quebrasse de forma sustentada e o `geral` continuasse
 * rodando, o arquivo seguiria recebendo registro fresco toda semana e o
 * alarme nunca dispararia.
 *
 * É o mesmo modo de falha que a auditoria de GEO encontrou dentro do próprio
 * monitor — rodou com 1 de 3 provedores sem alarmar — e que motivou este
 * alarme existir. Repeti-lo um nível acima, no exato commit que liga o
 * segundo painel, seria gratuito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestGeoCitationTs } from "../scripts/geo-citation-staleness-alarm.ts";
import {
  computeMultiPanelStaleness,
  computeStaleness,
  emptyGeoCitationStalenessAlarmState,
  shouldAlarm,
  advanceState,
} from "../scripts/lib/geo-citation-staleness-alarm.ts";

function historyWith(records: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "geo-panel-"));
  const p = join(dir, "history.jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return p;
}

const rec = (ts: string, panel?: string) => ({
  ts,
  date: ts.slice(0, 10),
  question: "q?",
  provider: "openai",
  cited: false,
  ...(panel ? { panel } : {}),
});

describe("#4900 — staleness é avaliada por painel, não pela última linha do arquivo", () => {
  describe("readLatestGeoCitationTs filtra por painel", () => {
    it("devolve o ts do painel pedido, ignorando o outro", () => {
      const p = historyWith([
        rec("2026-08-01T07:00:00.000Z", "hubs"),
        rec("2026-08-09T07:00:00.000Z", "geral"),
      ]);
      assert.equal(readLatestGeoCitationTs(p, "hubs"), "2026-08-01T07:00:00.000Z");
      assert.equal(readLatestGeoCitationTs(p, "geral"), "2026-08-09T07:00:00.000Z");
    });

    it("registro legado SEM campo panel conta como 'geral'", () => {
      // Todos os 40 registros que existiam em 10/08/2026 são anteriores ao
      // campo `panel` — se não contassem como `geral`, o painel original
      // apareceria como "nunca mediu" no primeiro alarme depois desta PR.
      const p = historyWith([rec("2026-08-09T07:00:00.000Z")]);
      assert.equal(readLatestGeoCitationTs(p, "geral"), "2026-08-09T07:00:00.000Z");
      assert.equal(readLatestGeoCitationTs(p, "hubs"), null);
    });

    it("sem o parâmetro, mantém o comportamento antigo (última linha legível)", () => {
      const p = historyWith([rec("2026-08-01T07:00:00.000Z", "geral"), rec("2026-08-09T07:00:00.000Z", "hubs")]);
      assert.equal(readLatestGeoCitationTs(p), "2026-08-09T07:00:00.000Z");
    });
  });

  describe("o cenário que motivou a mudança", () => {
    const now = new Date("2026-09-01T10:30:00.000Z");

    it("ALARMA quando 'geral' está fresco e 'hubs' está parado há semanas", () => {
      const perPanel = [
        { panel: "geral", latestRecordTs: "2026-08-30T07:00:00.000Z", check: computeStaleness("2026-08-30T07:00:00.000Z", now) },
        { panel: "hubs", latestRecordTs: "2026-08-02T07:00:00.000Z", check: computeStaleness("2026-08-02T07:00:00.000Z", now) },
      ];
      assert.equal(perPanel[0].check.isStale, false, "sanity: geral está fresco");
      assert.equal(perPanel[1].check.isStale, true, "sanity: hubs está velho");

      const agg = computeMultiPanelStaleness(perPanel);
      assert.equal(agg.isStale, true, "com hubs parado, o alarme TEM de disparar");
      assert.deepEqual(agg.stalePanels.map((p) => p.panel), ["hubs"]);
    });

    it("ALARMA quando 'hubs' nunca produziu registro nenhum", () => {
      const perPanel = [
        { panel: "geral", latestRecordTs: "2026-08-30T07:00:00.000Z", check: computeStaleness("2026-08-30T07:00:00.000Z", now) },
        { panel: "hubs", latestRecordTs: null, check: computeStaleness(null, now) },
      ];
      const agg = computeMultiPanelStaleness(perPanel);
      assert.equal(agg.isStale, true);
      assert.deepEqual(agg.stalePanels.map((p) => p.panel), ["hubs"]);
    });

    it("NÃO alarma quando os dois painéis estão frescos", () => {
      const perPanel = ["geral", "hubs"].map((panel) => ({
        panel,
        latestRecordTs: "2026-08-30T07:00:00.000Z",
        check: computeStaleness("2026-08-30T07:00:00.000Z", now),
      }));
      assert.equal(computeMultiPanelStaleness(perPanel).isStale, false);
    });
  });

  describe("fingerprint composto — um painel não suprime o alarme do outro", () => {
    const now = new Date("2026-09-01T10:30:00.000Z");
    const mk = (geral: string | null, hubs: string | null) =>
      computeMultiPanelStaleness([
        { panel: "geral", latestRecordTs: geral, check: computeStaleness(geral, now) },
        { panel: "hubs", latestRecordTs: hubs, check: computeStaleness(hubs, now) },
      ]);

    it("o fingerprint cobre TODOS os painéis, não só os stale", () => {
      const a = mk("2026-08-30T07:00:00.000Z", null);
      const b = mk("2026-08-23T07:00:00.000Z", null);
      assert.notEqual(a.fingerprint, b.fingerprint, "mudar o painel saudável muda o fingerprint");
      assert.match(a.fingerprint, /geral:/);
      assert.match(a.fingerprint, /hubs:/);
    });

    it("depois de alarmar por 'geral', o 1º alarme de 'hubs' NÃO é suprimido", () => {
      // Os dois painéis dividem um único `lastAlarmedFingerprint` no state.
      // Com fingerprint só do painel pior, alarmar por `geral` gravaria um
      // valor que também abafaria o primeiro alarme de `hubs`.
      const primeiro = mk(null, "2026-08-30T07:00:00.000Z"); // só geral stale
      let state = emptyGeoCitationStalenessAlarmState();
      assert.equal(shouldAlarm(state, { isStale: primeiro.isStale, staleDays: null }, primeiro.fingerprint), true);
      state = advanceState(primeiro.fingerprint, now);

      const segundo = mk(null, "2026-08-02T07:00:00.000Z"); // agora hubs também
      assert.equal(
        shouldAlarm(state, { isStale: segundo.isStale, staleDays: null }, segundo.fingerprint),
        true,
        "hubs entrando em staleness precisa gerar alarme novo",
      );
    });

    it("é idempotente: mesma situação duas vezes não realarma", () => {
      const agg = mk(null, "2026-08-02T07:00:00.000Z");
      const state = advanceState(agg.fingerprint, now);
      assert.equal(shouldAlarm(state, { isStale: agg.isStale, staleDays: null }, agg.fingerprint), false);
    });
  });
});
