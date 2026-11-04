/**
 * #11450 — o Passo 3e (`sync-kit-envio-brevo-orphans.ts`, #11431) reparava os
 * órfãos da tag `envio-brevo` a cada rodada, mas nada avisava quando o estoque
 * crescia (muitos órfãos por rodada) ou persistia (reparo falhando). Mesmo
 * padrão do `summarizeAwaitingFrioBacklog` (#11294).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENVIO_BREVO_ORPHAN_ALARM_COUNT,
  ENVIO_BREVO_ORPHAN_FAILED_ALARM_COUNT,
  envioBrevoOrphanAlarmReasons,
  runEnvioBrevoOrphanSweep,
  type EnvioBrevoOrphanCandidate,
  type EnvioBrevoOrphanDeps,
} from "../scripts/sync-kit-envio-brevo-orphans.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const cfgOff = { brevo_diaria: { api_key_env: "X", list_id: 7, kit_sem_abertura: { enabled: false } } };
const sub = (id: number): EnvioBrevoOrphanCandidate => ({ id, email: `o${id}@x.com`, tagNames: ["envio-brevo"] });

function makeDeps(actives: EnvioBrevoOrphanCandidate[], over: Partial<EnvioBrevoOrphanDeps> = {}) {
  const alarms: Array<{ title: string; body: string }> = [];
  const lines: string[] = [];
  const store: BrevoDiariaStore = {
    contacts: [
      {
        email: "no-store@x.com",
        beehiiv_subscription_id: "kit-sem-abertura:1",
        status: "in_brevo",
        opens_count: 0,
        sends_count: 0,
        last_open_rate: null,
        added_at: "2026-10-01T00:00:00Z",
        last_evaluated_at: null,
      },
    ],
  };
  const deps: EnvioBrevoOrphanDeps = {
    nowMs: Date.parse("2026-11-04T12:00:00Z"),
    log: (m) => lines.push(m),
    readStore: () => store,
    writeStore: () => {},
    listKitActive: async () => actives,
    readBrevoContact: async () => ({ exists: false, blacklisted: false, listIds: [] }),
    findEnvioBrevoTagId: async () => 42,
    untagKit: async () => {},
    appendLog: () => {},
    raiseAlarm: (title, body) => alarms.push({ title, body }),
    ...over,
  };
  return { deps, alarms, lines };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => sub(i + 1));

describe("envioBrevoOrphanAlarmReasons (#11450)", () => {
  it("abaixo dos dois tetos ⇒ sem motivo", () => {
    assert.deepEqual(envioBrevoOrphanAlarmReasons({ orphans: ENVIO_BREVO_ORPHAN_ALARM_COUNT - 1, failed: ENVIO_BREVO_ORPHAN_FAILED_ALARM_COUNT - 1 }), []);
  });
  it("cada teto gera o próprio motivo", () => {
    const r = envioBrevoOrphanAlarmReasons({ orphans: ENVIO_BREVO_ORPHAN_ALARM_COUNT, failed: ENVIO_BREVO_ORPHAN_FAILED_ALARM_COUNT });
    assert.equal(r.length, 2);
    assert.match(r[0], /órfão\(s\) da tag envio-brevo nesta rodada/);
    assert.match(r[1], /sem reparo por falha/);
  });
});

describe("runEnvioBrevoOrphanSweep — alarme do estoque (#11450)", () => {
  it("--push com órfãos no teto ⇒ abre alarme uma vez e expõe os motivos no resultado", async () => {
    const { deps, alarms } = makeDeps(range(ENVIO_BREVO_ORPHAN_ALARM_COUNT));
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 0);
    assert.equal(r.returnedToKit, ENVIO_BREVO_ORPHAN_ALARM_COUNT);
    assert.equal(alarms.length, 1);
    assert.match(alarms[0].title, /#11450/);
    assert.equal(r.alarmReasons?.length, 1);
  });

  it("reparo falhando de forma repetida ⇒ alarme por persistência", async () => {
    const { deps, alarms } = makeDeps(range(ENVIO_BREVO_ORPHAN_FAILED_ALARM_COUNT), {
      readBrevoContact: async () => {
        throw new Error("HTTP 500");
      },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(alarms.length, 1);
    assert.match(alarms[0].body, /sem reparo por falha/);
  });

  it("dry-run só avisa no log, não abre alarme", async () => {
    const { deps, alarms, lines } = makeDeps(range(ENVIO_BREVO_ORPHAN_ALARM_COUNT));
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: false }, deps);
    assert.equal(alarms.length, 0);
    assert.ok(lines.some((l) => l.startsWith("warn:") && l.includes("#11450")));
    assert.equal(r.alarmReasons?.length, 1);
  });

  it("rodada normal (poucos órfãos) ⇒ sem alarme e sem campo no resultado", async () => {
    const { deps, alarms } = makeDeps(range(2));
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(alarms.length, 0);
    assert.equal(r.alarmReasons, undefined);
  });

  it("falha do gh ao abrir o alarme é fail-soft", async () => {
    const { deps, lines } = makeDeps(range(ENVIO_BREVO_ORPHAN_ALARM_COUNT), {
      raiseAlarm: () => {
        throw new Error("gh sem auth");
      },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 0);
    assert.ok(lines.some((l) => l.includes("issue de alarme dos órfãos não aberta (gh sem auth)")));
  });
});
