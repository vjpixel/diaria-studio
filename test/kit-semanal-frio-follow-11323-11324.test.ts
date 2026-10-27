/**
 * test/kit-semanal-frio-follow-11323-11324.test.ts
 *
 * Achados do review consolidado da rodada overnight 261027d (PR #11308):
 *  - #11323: semanal de frio já enviada (`completed`/`sending` no Kit) é
 *    terminal — re-rodar a Etapa 6 não faz PATCH (422 "already sent") nem
 *    tenta desagendar (alarme falso);
 *  - #11324: quando o re-run da Etapa 5 desagenda o principal por audiência
 *    divergente, a semanal acompanha (followOnly), depois de o estado do
 *    principal voltar pra `draft`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publishKitSemanalFrio, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { revertMainToDraftAndFollowSemanal, type KitNewsletterPublished } from "../scripts/publish-newsletter-kit.ts";
import { buildTagFilter } from "../scripts/lib/kit-broadcasts.ts";
import type { KitSemanalFrioPublished } from "../scripts/lib/kit-frio.ts";

const cfgFrioOn = {
  kit: {
    frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
    diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
  },
};
const MONDAY_DIR = "/x/2611/261102";
const SEND_AT = "2026-11-02T09:00:00.000Z";

type MainState = ReturnType<SemanalFrioPublishDeps["readMainState"]>;
const mainAt = (at: string): MainState => ({ broadcast_id: 10, subject: "S", preview_text: "P", status: "scheduled", scheduled_at: at });

function deps(main: MainState, kitStatus: string) {
  const patched: string[] = [];
  const written: KitSemanalFrioPublished[] = [];
  const alarms: string[] = [];
  const own: KitSemanalFrioPublished = {
    broadcast_id: 11,
    status: "scheduled",
    scheduled_at: SEND_AT,
    source_broadcast_id: 10,
    tag_id: 900,
    created_at: "2026-11-01T22:00:00Z",
  };
  const d: SemanalFrioPublishDeps = {
    log: () => {},
    nowIso: () => "2026-11-02T12:00:00Z",
    readMainState: () => main,
    readOwnState: () => own,
    writeOwnState: (_dir, s) => void written.push(s),
    readPause: () => ({ paused: false }),
    findTagId: async () => 900,
    countTagMembers: async () => 5,
    getBroadcast: async (id) =>
      ({ id, subject: "S", content: "<p>x</p>", status: kitStatus, send_at: SEND_AT, subscriber_filter: buildTagFilter(900) }) as never,
    createBroadcast: async () => {
      throw new Error("não deveria criar");
    },
    scheduleBroadcast: async (id, at) => {
      patched.push(`${id}@${at}`);
      throw new Error("Kit API PATCH -> 422: Broadcast has already been sent");
    },
    deleteBroadcast: async () => {
      throw new Error("não deveria apagar");
    },
    raiseAlarm: (title) => void alarms.push(title),
  };
  return { d, patched, written, alarms };
}

describe("semanal de frio já enviada é terminal (#11323)", () => {
  for (const kitStatus of ["completed", "sending"]) {
    it(`REGRESSÃO: re-run do Stage 6 com o principal already_scheduled e a semanal ${kitStatus} ⇒ already_sent, sem PATCH`, async () => {
      const t = deps(mainAt(SEND_AT), kitStatus);
      const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
      assert.equal(r.code, 0);
      assert.equal(r.status, "already_sent");
      assert.equal(r.broadcastId, 11);
      assert.deepEqual(t.patched, []);
      assert.deepEqual(t.written, [], "estado local intocado");
    });

    it(`REGRESSÃO: principal caiu pra draft depois do envio e a semanal está ${kitStatus} ⇒ already_sent, sem desagendar nem alarmar`, async () => {
      const t = deps({ broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" }, kitStatus);
      const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true, followOnly: true }, t.d);
      assert.equal(r.status, "already_sent");
      assert.deepEqual(t.patched, []);
      assert.deepEqual(t.alarms, []);
    });
  }

  it("principal reagendado com a semanal já enviada ⇒ already_sent (nunca re-PATCH)", async () => {
    const t = deps(mainAt("2026-11-02T11:00:00.000Z"), "completed");
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "already_sent");
    assert.deepEqual(t.patched, []);
  });

  it("dry-run também reconhece o envio (relê sem escrever)", async () => {
    const t = deps(mainAt("2026-11-02T11:00:00.000Z"), "completed");
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: false }, t.d);
    assert.equal(r.status, "already_sent");
    assert.deepEqual(t.patched, []);
  });
});

describe("Etapa 5 desagenda o principal ⇒ a semanal acompanha (#11324)", () => {
  const existing: KitNewsletterPublished = {
    broadcast_id: 10,
    subject: "S",
    preview_text: "P",
    status: "scheduled",
    scheduled_at: SEND_AT,
  } as KitNewsletterPublished;

  it("REGRESSÃO: grava o principal como draft ANTES do follow e chama o follow (followOnly)", async () => {
    const events: string[] = [];
    let saved: KitNewsletterPublished | null = null;
    await revertMainToDraftAndFollowSemanal("/x/2611/261102", existing, () => {}, "/root", {
      writeState: (_dir, s) => {
        saved = s;
        events.push(`write:${s.status}`);
      },
      followSemanal: async (dir, _log, root) => {
        events.push(`follow:${dir}:${root}`);
        return { status: "unscheduled" };
      },
    });
    assert.deepEqual(events, ["write:draft", "follow:/x/2611/261102:/root"]);
    assert.equal(saved!.status, "draft");
    assert.equal("scheduled_at" in saved!, false, "scheduled_at descartado");
  });

  it("integração com o publisher da semanal: estado draft gravado ⇒ follow desagenda a semanal agendada", async () => {
    let mainState: MainState = mainAt(SEND_AT);
    const unscheduled: string[] = [];
    const sendAt = new Map<number, string>([[11, SEND_AT]]);
    const t = deps(mainState, "scheduled");
    const d: SemanalFrioPublishDeps = {
      ...t.d,
      readMainState: () => mainState,
      getBroadcast: async (id) =>
        ({ id, status: sendAt.has(id) ? "scheduled" : "draft", send_at: sendAt.get(id) ?? null, subscriber_filter: buildTagFilter(900) }) as never,
      scheduleBroadcast: async (id, at) => {
        unscheduled.push(`${id}@${at}`);
        if (at === null) sendAt.delete(id);
      },
    };
    let result: { status: string } | null = null;
    await revertMainToDraftAndFollowSemanal("/x/2611/261102", existing, () => {}, "/root", {
      writeState: (_dir, s) => void (mainState = s),
      followSemanal: async (dir) => (result = await publishKitSemanalFrio(dir, cfgFrioOn, { push: true, followOnly: true }, d)),
    });
    assert.equal(result!.status, "unscheduled");
    assert.deepEqual(unscheduled, ["11@null"]);
  });

  it("follow que lança ou falha não propaga (fail-soft) e sai como ERRO no log", async () => {
    const logs: string[] = [];
    await revertMainToDraftAndFollowSemanal("/x/2611/261102", existing, (m) => void logs.push(m), "/root", {
      writeState: () => {},
      followSemanal: async () => {
        throw new Error("boom");
      },
    });
    assert.ok(logs.some((l) => /ERRO: acompanhamento da semanal falhou \(boom\)/.test(l)));
    logs.length = 0;
    await revertMainToDraftAndFollowSemanal("/x/2611/261102", existing, (m) => void logs.push(m), "/root", {
      writeState: () => {},
      followSemanal: async () => ({ status: "failed", reason: "x" }),
    });
    assert.ok(logs.some((l) => /semanal frio: ERRO: failed — x/.test(l)));
  });

  it("guard: o caminho check.unscheduled do main() usa o helper (não regrava o draft à mão)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/publish-newsletter-kit.ts"), "utf8");
    const start = src.indexOf("if (check.unscheduled && existing)");
    assert.ok(start > 0);
    const block = src.slice(start, src.indexOf("process.exitCode = 13", start));
    assert.ok(block.length > 0);
    // Só o nome da chamada (review do PR #11326): casar os argumentos literais
    // quebrava com qualquer renomeação de variável.
    assert.match(block, /await revertMainToDraftAndFollowSemanal\(/);
  });
});

describe("review do PR #11326", () => {
  const draftMain: MainState = { broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" };

  it("REGRESSÃO (P2): principal desagendado + GET inicial falha + desagendamento falha ⇒ alarme 'sairia SOZINHA', nunca exceção sem alarme", async () => {
    const t = deps(draftMain, "scheduled");
    const d: SemanalFrioPublishDeps = {
      ...t.d,
      getBroadcast: async () => {
        throw new Error("Kit API GET -> 503");
      },
    };
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true, followOnly: true }, d);
    assert.equal(r.status, "failed");
    assert.equal(r.code, 1);
    assert.match(r.reason!, /sairia SOZINHA/);
    assert.equal(t.alarms.length, 1);
    assert.match(t.alarms[0], /agendada sem o principal/);
    assert.deepEqual(t.patched, ["11@null"], "tentou desagendar mesmo sem conseguir reler antes");
  });

  it("principal desagendado + GET inicial falha, mas o desagendamento e a releitura funcionam ⇒ unscheduled", async () => {
    const t = deps(draftMain, "scheduled");
    let calls = 0;
    const d: SemanalFrioPublishDeps = {
      ...t.d,
      getBroadcast: async (id) => {
        calls++;
        if (calls === 1) throw new Error("Kit API GET -> 503");
        return { id, status: "draft", send_at: null, subscriber_filter: buildTagFilter(900) } as never;
      },
      scheduleBroadcast: async (id, at) => void t.patched.push(`${id}@${at}`),
    };
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true, followOnly: true }, d);
    assert.equal(r.status, "unscheduled");
    assert.deepEqual(t.patched, ["11@null"]);
    assert.deepEqual(t.alarms, []);
  });

  it("(P3) semanal abortada no Kit é terminal ⇒ status aborted, sem PATCH nem alarme", async () => {
    for (const main of [mainAt("2026-11-02T11:00:00.000Z"), draftMain]) {
      const t = deps(main, "aborted");
      const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true, followOnly: main.status !== "scheduled" }, t.d);
      assert.equal(r.code, 0);
      assert.equal(r.status, "aborted");
      assert.deepEqual(t.patched, []);
      assert.deepEqual(t.alarms, []);
      assert.deepEqual(t.written, []);
    }
  });

  it("(P3) schedule-newsletter-kit.ts omite not_monday do log/JSON, como o caller do publisher", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/schedule-newsletter-kit.ts"), "utf8");
    assert.match(src, /semanal\.status !== "not_monday"/);
  });
});
