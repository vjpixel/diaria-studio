/**
 * test/kit-semanal-frio-content-resync-11429.test.ts
 *
 * #11429: a semanal de frio copiava o conteúdo do principal uma vez só, na
 * criação. Corrigido o principal depois (re-run da Etapa 5,
 * `updateExistingKitBroadcast`), o follow (`scheduled`) e o resume
 * (`created_unverified`) seguiam com o conteúdo antigo. Agora o estado guarda
 * `source_content_hash` e os dois caminhos re-sincronizam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publishKitSemanalFrio, semanalSourceContentHash, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { buildTagFilter, type UpdateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { KIT_SEMANAL_FRIO_INTRO_TEXT, type KitSemanalFrioPublished } from "../scripts/lib/kit-frio.ts";

const cfgFrioOn = {
  kit: {
    frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
    diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
  },
};
const MONDAY_DIR = "/x/2611/261102";
const SEND_AT = "2026-11-02T09:00:00.000Z";
const OLD = { subject: "S", preview_text: "P", content: "<p>link errado</p>" };
const NEW = { subject: "S corrigido", preview_text: "P", content: "<p>link certo</p>" };

interface Bc {
  subject: string;
  preview_text: string | null;
  content: string;
  status: string;
  send_at: string | null;
  subscriber_filter: unknown;
}

type MainState = ReturnType<SemanalFrioPublishDeps["readMainState"]>;

function kit(opts: { own: KitSemanalFrioPublished | null; main?: MainState; mainContent?: typeof NEW; semanalStatus?: string; rereadFilter?: unknown }) {
  const mainContent = opts.mainContent ?? NEW;
  const bcs = new Map<number, Bc>([
    [10, { ...mainContent, status: "scheduled", send_at: SEND_AT, subscriber_filter: undefined }],
    [
      11,
      {
        ...OLD,
        content: `<i>intro</i>${OLD.content}`,
        status: opts.semanalStatus ?? (opts.own?.status === "scheduled" ? "scheduled" : "draft"),
        send_at: opts.own?.status === "scheduled" ? opts.own.scheduled_at : null,
        subscriber_filter: buildTagFilter(900),
      },
    ],
  ]);
  const contentPatches: { id: number; input: UpdateBroadcastInput }[] = [];
  const schedules: string[] = [];
  const written: KitSemanalFrioPublished[] = [];
  const deleted: number[] = [];
  const gets: number[] = [];
  const d: SemanalFrioPublishDeps = {
    log: () => {},
    nowIso: () => "2026-11-01T23:00:00Z",
    readMainState: () => opts.main ?? { broadcast_id: 10, subject: mainContent.subject, preview_text: "P", status: "scheduled", scheduled_at: SEND_AT },
    readOwnState: () => opts.own,
    writeOwnState: (_d, s) => void written.push(s),
    readPause: () => ({ paused: false }),
    findTagId: async () => 900,
    countTagMembers: async () => 5,
    getBroadcast: async (id) => {
      gets.push(id);
      const b = bcs.get(id)!;
      return { id, ...b } as never;
    },
    createBroadcast: async () => {
      throw new Error("não deveria criar");
    },
    scheduleBroadcast: async (id, at) => {
      schedules.push(`${id}@${at}`);
      const b = bcs.get(id)!;
      b.send_at = at;
      b.status = at === null ? "draft" : "scheduled";
    },
    updateBroadcastContent: async (id, input) => {
      contentPatches.push({ id, input });
      const b = bcs.get(id)!;
      b.subject = input.subject!;
      b.preview_text = input.preview_text ?? null;
      b.content = input.content!;
      b.send_at = input.send_at ?? null;
      b.status = input.send_at ? "scheduled" : "draft";
      b.subscriber_filter = "rereadFilter" in opts ? opts.rereadFilter : input.subscriber_filter;
    },
    deleteBroadcast: async (id) => void deleted.push(id),
    raiseAlarm: () => {},
  };
  return { d, bcs, contentPatches, schedules, written, deleted, gets };
}

const ownState = (status: KitSemanalFrioPublished["status"], hash: string | undefined, scheduledAt = SEND_AT): KitSemanalFrioPublished => ({
  broadcast_id: 11,
  status,
  scheduled_at: scheduledAt,
  source_broadcast_id: 10,
  tag_id: 900,
  created_at: "2026-11-01T22:00:00Z",
  ...(hash !== undefined ? { source_content_hash: hash } : {}),
});

const OLD_HASH = semanalSourceContentHash(OLD);
const NEW_HASH = semanalSourceContentHash(NEW);

describe("semanal de frio re-sincroniza o conteúdo do principal corrigido (#11429)", () => {
  it("hash muda com assunto, preview ou conteúdo", () => {
    assert.notEqual(OLD_HASH, NEW_HASH);
    assert.notEqual(semanalSourceContentHash({ ...OLD, preview_text: "Q" }), OLD_HASH);
    assert.equal(semanalSourceContentHash({ ...OLD }), OLD_HASH);
  });

  it("REGRESSÃO: semanal agendada + principal corrigido no mesmo horário ⇒ PATCH do conteúdo novo (com intro, send_at e filtro explícitos) e estado com o hash novo", async () => {
    const t = kit({ own: ownState("scheduled", OLD_HASH) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.code, 0);
    assert.equal(r.status, "content_synced");
    assert.equal(t.contentPatches.length, 1);
    const { id, input } = t.contentPatches[0]!;
    assert.equal(id, 11);
    assert.equal(input.subject, NEW.subject);
    assert.ok(input.content!.includes(NEW.content));
    assert.ok(input.content!.includes(KIT_SEMANAL_FRIO_INTRO_TEXT.slice(0, 40)), "intro reinjetado");
    assert.equal(input.send_at, SEND_AT, "send_at explícito (#8208)");
    assert.deepEqual(input.subscriber_filter, buildTagFilter(900));
    assert.equal(input.public, false);
    assert.deepEqual(t.schedules, [], "horário igual: sem re-PATCH de send_at");
    assert.equal(t.written.at(-1)!.source_content_hash, NEW_HASH);
    assert.equal(t.written.at(-1)!.status, "scheduled");
  });

  it("principal sem mudança ⇒ already_done, sem PATCH", async () => {
    const t = kit({ own: ownState("scheduled", NEW_HASH) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "already_done");
    assert.deepEqual(t.contentPatches, []);
    assert.deepEqual(t.written, []);
  });

  it("principal corrigido E reagendado ⇒ conteúdo re-sincronizado e semanal reagendada", async () => {
    const later = "2026-11-02T11:00:00.000Z";
    const t = kit({
      own: ownState("scheduled", OLD_HASH),
      main: { broadcast_id: 10, subject: NEW.subject, preview_text: "P", status: "scheduled", scheduled_at: later },
    });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "rescheduled");
    assert.equal(t.contentPatches.length, 1);
    assert.deepEqual(t.schedules, [`11@${later}`]);
    const last = t.written.at(-1)!;
    assert.equal(last.scheduled_at, later);
    assert.equal(last.source_content_hash, NEW_HASH);
  });

  it("REGRESSÃO: resume (created_unverified, ex. depois do desagendamento #11323) re-sincroniza antes de agendar", async () => {
    const t = kit({ own: ownState("created_unverified", OLD_HASH) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "scheduled");
    assert.equal(t.contentPatches.length, 1);
    assert.equal(t.contentPatches[0]!.input.send_at, null, "rascunho: o agendamento recoloca o horário");
    assert.deepEqual(t.schedules, [`11@${SEND_AT}`]);
    assert.ok(t.bcs.get(11)!.content.includes(NEW.content));
    assert.equal(t.written.at(-1)!.status, "scheduled");
    assert.equal(t.written.at(-1)!.source_content_hash, NEW_HASH);
  });

  it("resume sem mudança no principal ⇒ não re-sincroniza, mantém o hash", async () => {
    const t = kit({ own: ownState("created_unverified", NEW_HASH) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "scheduled");
    assert.deepEqual(t.contentPatches, []);
    assert.equal(t.written.at(-1)!.source_content_hash, NEW_HASH);
  });

  it("estado anterior ao #11429 (sem hash) ⇒ comportamento antigo, sem reler o principal nem PATCH", async () => {
    const t = kit({ own: ownState("scheduled", undefined) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "already_done");
    assert.deepEqual(t.contentPatches, []);
    assert.deepEqual(t.gets, [11], "só a releitura da própria semanal");
  });

  it("dry-run com principal corrigido ⇒ dry_run, nada escrito", async () => {
    const t = kit({ own: ownState("scheduled", OLD_HASH) });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: false }, t.d);
    assert.equal(r.status, "dry_run");
    assert.match(r.reason ?? "", /re-sincronizaria/);
    assert.deepEqual(t.contentPatches, []);
    assert.deepEqual(t.written, []);
  });

  it("filtro relido diverge depois do PATCH de conteúdo ⇒ apaga (filtro não resolvido = base inteira)", async () => {
    const t = kit({ own: ownState("scheduled", OLD_HASH), rereadFilter: [] });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.code, 1);
    assert.deepEqual(t.deleted, [11]);
    assert.equal(t.written.at(-1)!.status, "deleted");
  });

  it("semanal já enviada ⇒ already_sent antes de qualquer re-sincronização", async () => {
    const t = kit({ own: ownState("scheduled", OLD_HASH), semanalStatus: "completed" });
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "already_sent");
    assert.deepEqual(t.contentPatches, []);
  });
});

describe("criação grava o hash da cópia (#11429)", () => {
  it("source_content_hash do estado = hash do principal copiado", async () => {
    const t = kit({ own: null, mainContent: OLD });
    t.d.createBroadcast = async () => ({ id: 11 }) as never;
    t.d.countTagMembers = async () => 5;
    const r = await publishKitSemanalFrio(MONDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "scheduled");
    assert.deepEqual(
      t.written.map((w) => w.source_content_hash),
      [OLD_HASH, OLD_HASH],
    );
  });
});
