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

    it("#4961: o fingerprint cobre só os painéis STALE — mudar o painel saudável NÃO muda o fingerprint", () => {
      // `geral` está saudável nas duas chamadas (9 e 5 dias atrás, abaixo do
      // limiar de 10 — ver #5117 item 5, baixou de 21) mesmo tendo `ts`
      // diferente; `hubs` está parado (null) nas duas. Antes do #4961 o
      // fingerprint compunha TODOS os painéis e mudava aqui — que era
      // exatamente o bug (reenvio semanal do alarme de `hubs` só porque
      // `geral` avançou).
      const a = mk("2026-08-23T07:00:00.000Z", null);
      const b = mk("2026-08-27T07:00:00.000Z", null);
      assert.equal(a.fingerprint, b.fingerprint, "painel saudável mudando de ts não deve mudar o fingerprint");
      assert.doesNotMatch(a.fingerprint, /geral:/, "painel saudável não entra no fingerprint");
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

  describe("#4961: painel travado não realarma toda semana só porque o outro painel avança", () => {
    // Cenário exato da issue: `hubs` trava num único `ts` (staleness real, sem
    // novo registro nunca mais); `geral` continua saudável, produzindo um
    // registro fresco toda semana. Antes do fix, o fingerprint composto
    // incluía o `ts` de `geral` — mudava toda semana mesmo com `hubs`
    // continuando exatamente no mesmo estado, e `shouldAlarm` reenviava o
    // alarme indefinidamente pra uma condição já conhecida.
    const HUBS_STUCK_TS = "2026-07-15T07:00:00.000Z"; // nunca muda — travado de verdade

    const checkAt = (now: Date, geralTs: string | null) =>
      computeMultiPanelStaleness([
        { panel: "geral", latestRecordTs: geralTs, check: computeStaleness(geralTs, now) },
        { panel: "hubs", latestRecordTs: HUBS_STUCK_TS, check: computeStaleness(HUBS_STUCK_TS, now) },
      ]);

    it("alarma na 1ª semana, mas NÃO realarma nas semanas seguintes enquanto só hubs continua travado", () => {
      let state = emptyGeoCitationStalenessAlarmState();

      // Semana 1: hubs já velho o bastante pra ser stale; geral fresco (2 dias).
      const week1 = new Date("2026-09-01T07:00:00.000Z");
      const agg1 = checkAt(week1, "2026-08-30T07:00:00.000Z");
      assert.deepEqual(agg1.stalePanels.map((p) => p.panel), ["hubs"], "sanity: só hubs está stale");
      const check1 = { isStale: agg1.isStale, staleDays: agg1.stalePanels[0].check.staleDays };
      assert.equal(shouldAlarm(state, check1, agg1.fingerprint), true, "1º alarme precisa disparar");
      state = advanceState(check1.isStale ? agg1.fingerprint : null, week1);

      // Semanas 2, 3 e 4: `geral` segue produzindo registro novo toda semana
      // (ts avança); `hubs` permanece exatamente no mesmo HUBS_STUCK_TS. Sem
      // o fix, o fingerprint composto mudaria a cada semana (porque incluía
      // o ts de `geral`) e isto dispararia `true` em todas as 3 iterações.
      const weeklyGeralTs = [
        ["2026-09-08T07:00:00.000Z", "2026-09-06T07:00:00.000Z"], // now, geral ts
        ["2026-09-15T07:00:00.000Z", "2026-09-13T07:00:00.000Z"],
        ["2026-09-22T07:00:00.000Z", "2026-09-20T07:00:00.000Z"],
      ] as const;
      for (const [nowIso, geralTsIso] of weeklyGeralTs) {
        const now2 = new Date(nowIso);
        const agg = checkAt(now2, geralTsIso);
        assert.deepEqual(agg.stalePanels.map((p) => p.panel), ["hubs"], "sanity: geral segue saudável");
        assert.equal(agg.fingerprint, agg1.fingerprint, "fingerprint não deve mudar só porque geral avançou");
        const check = { isStale: agg.isStale, staleDays: agg.stalePanels[0].check.staleDays };
        assert.equal(
          shouldAlarm(state, check, agg.fingerprint),
          false,
          `não deve realarmar em ${nowIso} — hubs continua na MESMA condição já alarmada`,
        );
        state = advanceState(check.isStale ? agg.fingerprint : null, now2);
      }

      // Agora hubs de fato MUDA (ex: task rodou de novo brevemente e parou
      // num ts diferente, ainda velho) — isto TEM que gerar alarme novo.
      const nowFinal = new Date("2026-09-29T07:00:00.000Z");
      const hubsNewStuckTs = "2026-08-20T07:00:00.000Z";
      const aggFinal = computeMultiPanelStaleness([
        {
          panel: "geral",
          latestRecordTs: "2026-09-27T07:00:00.000Z",
          check: computeStaleness("2026-09-27T07:00:00.000Z", nowFinal),
        },
        { panel: "hubs", latestRecordTs: hubsNewStuckTs, check: computeStaleness(hubsNewStuckTs, nowFinal) },
      ]);
      assert.notEqual(aggFinal.fingerprint, agg1.fingerprint, "sanity: hubs realmente mudou de ts");
      const checkFinal = { isStale: aggFinal.isStale, staleDays: aggFinal.stalePanels[0].check.staleDays };
      assert.equal(
        shouldAlarm(state, checkFinal, aggFinal.fingerprint),
        true,
        "hubs mudando de verdade precisa continuar alarmando",
      );
    });
  });
});
