/**
 * test/renumber-edition-fixes-12725-12727.test.ts (#12725, #12726, #12727)
 *
 * Achados do review 1.5b da rodada overnight 261110d sobre o PR #12724:
 * - #12725: a semanal de frio desagendada pelo `--unschedule`
 *   (`created_unverified`) devolvia `not_monday` na Etapa 6 de uma pasta que
 *   deixou de ser de segunda — a base fria ficava sem a edição da semana.
 * - #12726: a retomada de store global pendente reescrevia o store sem
 *   checar conflito nem se as entradas do ID antigo tinham mudado.
 * - #12727: falha no principal depois de a semanal sair da agenda não dizia
 *   que a semanal ficou desagendada sozinha.
 *
 * Chamadas externas sempre fakes; tudo em tmpdir, nunca em `data/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_RENUMBER_IO,
  GLOBAL_EDITION_STORES,
  GlobalStoreRefusalError,
  completePendingGlobalStores,
  globalStoreFromFingerprint,
  readRenumberReport,
  renumberLocal,
  unscheduleSends,
  type UnscheduleDeps,
} from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, runUnschedule, type RenumberCliDeps } from "../scripts/renumber-edition.ts";
import { publishKitSemanalFrio, semanalSourceContentHash, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { buildTagFilter } from "../scripts/lib/kit-broadcasts.ts";
import type { KitSemanalFrioPublished } from "../scripts/lib/kit-frio.ts";

let root: string;

function write(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ─── #12725 ──────────────────────────────────────────────────────────────

describe("#12725 — semanal de frio created_unverified retomada fora de segunda", () => {
  const cfgFrioOn = {
    kit: {
      frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
      diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
    },
  };
  // 261110 é terça (renumerada de 261109, segunda).
  const TUESDAY_DIR = "/x/2611/261110";
  const NEW_SEND_AT = "2026-11-10T09:00:00.000Z";
  const MAIN = { subject: "S", preview_text: "P", content: "<p>links 261110</p>" };

  function deps(own: KitSemanalFrioPublished | null, mainStatus: "scheduled" | "draft" = "scheduled") {
    const schedules: string[] = [];
    const written: KitSemanalFrioPublished[] = [];
    const bcs = new Map<number, { status: string; send_at: string | null; subscriber_filter: unknown; subject: string; preview_text: string | null; content: string }>([
      [10, { ...MAIN, status: mainStatus, send_at: mainStatus === "scheduled" ? NEW_SEND_AT : null, subscriber_filter: undefined }],
      [11, { subject: "S", preview_text: "P", content: "<i>intro</i><p>links 261109</p>", status: "draft", send_at: null, subscriber_filter: buildTagFilter(900) }],
    ]);
    const d: SemanalFrioPublishDeps = {
      log: () => {},
      nowIso: () => "2026-11-10T08:00:00Z",
      readMainState: () =>
        mainStatus === "scheduled"
          ? { broadcast_id: 10, subject: "S", preview_text: "P", status: "scheduled", scheduled_at: NEW_SEND_AT }
          : ({ broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" } as never),
      readOwnState: () => own,
      writeOwnState: (_d, s) => void written.push(s),
      readPause: () => ({ paused: false }),
      findTagId: async () => 900,
      countTagMembers: async () => 5,
      getBroadcast: async (id) => ({ id, ...bcs.get(id)! }) as never,
      createBroadcast: async () => {
        throw new Error("não deveria criar fora de segunda");
      },
      scheduleBroadcast: async (id, at) => {
        schedules.push(`${id}@${at}`);
        const b = bcs.get(id)!;
        b.send_at = at;
        b.status = at === null ? "draft" : "scheduled";
      },
      updateBroadcastContent: async (id, input) => {
        const b = bcs.get(id)!;
        b.content = input.content!;
        b.subject = input.subject!;
        b.preview_text = input.preview_text ?? null;
        b.subscriber_filter = input.subscriber_filter;
      },
      deleteBroadcast: async () => {
        throw new Error("não deveria apagar");
      },
      raiseAlarm: () => {},
    };
    return { d, schedules, written };
  }

  const ownUnverified = (): KitSemanalFrioPublished => ({
    broadcast_id: 11,
    status: "created_unverified",
    scheduled_at: "2026-11-09T09:00:00.000Z",
    source_broadcast_id: 10,
    tag_id: 900,
    created_at: "2026-11-08T22:00:00Z",
    reason: "principal desagendado (renumber-edition, #12720)",
    source_content_hash: semanalSourceContentHash({ subject: "S", preview_text: "P", content: "<p>links 261109</p>" }),
  });

  it("REGRESSÃO: pasta de terça com a semanal created_unverified e o principal reagendado ⇒ retoma e agenda no horário novo", async () => {
    const t = deps(ownUnverified());
    const r = await publishKitSemanalFrio(TUESDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "scheduled", JSON.stringify(r));
    assert.equal(r.code, 0);
    assert.deepEqual(t.schedules, [`11@${NEW_SEND_AT}`]);
    assert.equal(t.written.at(-1)!.status, "scheduled");
    assert.equal(t.written.at(-1)!.scheduled_at, NEW_SEND_AT);
  });

  it("dry-run de terça com created_unverified ⇒ 'retomaria', não not_monday", async () => {
    const t = deps(ownUnverified());
    const r = await publishKitSemanalFrio(TUESDAY_DIR, cfgFrioOn, { push: false }, t.d);
    assert.equal(r.status, "dry_run");
    assert.match(String((r as { reason?: string }).reason), /retomaria o rascunho 11/);
  });

  it("followOnly (agendamento do principal falhou) de terça com created_unverified ⇒ nothing_to_follow, sem agendar", async () => {
    const t = deps(ownUnverified());
    const r = await publishKitSemanalFrio(TUESDAY_DIR, cfgFrioOn, { push: true, followOnly: true }, t.d);
    assert.equal(r.status, "nothing_to_follow");
    assert.deepEqual(t.schedules, []);
  });

  it("terça sem estado da semanal continua not_monday (criar segue só na segunda)", async () => {
    const t = deps(null);
    const r = await publishKitSemanalFrio(TUESDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "not_monday");
  });

  it("terça com a semanal apagada (deleted) continua not_monday", async () => {
    const t = deps({ ...ownUnverified(), status: "deleted" });
    const r = await publishKitSemanalFrio(TUESDAY_DIR, cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "not_monday");
  });
});

// ─── #12726 / #12727 (renumber-edition) ──────────────────────────────────

const FROM = "261110";
const TO = "261111";
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);
const put = (rel: string, content: string) => write(join(fromDir(), rel), content);
const putData = (rel: string, content: string) => write(join(root, "data", rel), content);
const readData = (rel: string) => readFileSync(join(root, "data", rel), "utf8");
const readState = (rel: string, dir = fromDir()) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

function cliDeps(): RenumberCliDeps & { logs: string[] } {
  const logs: string[] = [];
  return { root, logs, log: (m) => void logs.push(m), nowIso: () => "2026-11-10T12:00:00.000Z", runStep: () => 0 };
}

/** Parte local com o store `exploration-quota.json` falhando na escrita (EBUSY do sync). */
function renumberWithQuotaWriteFailing(): void {
  const io = {
    ...DEFAULT_RENUMBER_IO,
    writeStore: (abs: string, text: string) => {
      if (abs.endsWith("exploration-quota.json")) throw new Error("EBUSY: resource busy or locked");
      DEFAULT_RENUMBER_IO.writeStore(abs, text);
    },
  };
  assert.throws(() => renumberLocal(root, FROM, TO, "2026-11-10T12:00:00.000Z", [], io), /EBUSY/);
  assert.ok(existsSync(toDir()));
  assert.deepEqual(readRenumberReport(toDir())!.global_stores_pending, ["data/exploration-quota.json"]);
}

describe("#12726 — retomada de store global pendente com checagem de conflito e de dono", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12726-"));
    put("02-reviewed.md", `Edição ${FROM}\n`);
    putData("intentional-errors.jsonl", `{"edition":"${FROM}","detail":"x"}\n`);
    putData("exploration-quota.json", JSON.stringify({ editions: { [FROM]: { used: 1 } } }, null, 2) + "\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("o relatório grava a impressão digital das entradas de from de cada store pendente", () => {
    renumberWithQuotaWriteFailing();
    const report = readRenumberReport(toDir())!;
    const store = GLOBAL_EDITION_STORES.find((s) => s.path === "data/exploration-quota.json")!;
    const expected = globalStoreFromFingerprint(store, JSON.stringify({ editions: { [FROM]: { used: 1 } } }), FROM);
    assert.equal(report.global_stores_fingerprints?.["data/exploration-quota.json"], expected);
  });

  it("REGRESSÃO (a): edição nova com o ID antigo reescreve a entrada de from antes da retomada ⇒ exit 2, store intocado", () => {
    renumberWithQuotaWriteFailing();
    // `/diaria-edicao 261110` de uma edição NOVA, antes da retomada.
    const reused = JSON.stringify({ editions: { [FROM]: { used: 3, nova: true } } }, null, 2) + "\n";
    putData("exploration-quota.json", reused);

    const dry = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, dry), 0);
    assert.match(dry.logs.join("\n"), /recusaria: .*exploration-quota\.json: as entradas de 261110 mudaram/);

    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2, d.logs.join("\n"));
    assert.match(d.logs.join("\n"), /mudaram desde a tentativa anterior/);
    assert.equal(readData("exploration-quota.json"), reused, "a entrada da edição nova não foi levada pro ID novo");
    assert.deepEqual(readRenumberReport(toDir())!.global_stores_pending, ["data/exploration-quota.json"], "pendência mantida");
  });

  it("REGRESSÃO (b): object-key com from e to ao mesmo tempo ⇒ recusa, sem sobrescrever editions[to]", () => {
    renumberWithQuotaWriteFailing();
    const both = JSON.stringify({ editions: { [FROM]: { used: 1 }, [TO]: { used: 9 } } }, null, 2) + "\n";
    putData("exploration-quota.json", both);
    const report = readRenumberReport(toDir())!;
    assert.throws(() => completePendingGlobalStores(root, toDir(), report), (e: unknown) => e instanceof GlobalStoreRefusalError && /já tem 1 entrada\(s\) de 261111/.test((e as Error).message));
    assert.equal(readData("exploration-quota.json"), both);

    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2);
  });

  it("store sem mudança desde a tentativa anterior ⇒ a retomada termina (exit 0)", () => {
    renumberWithQuotaWriteFailing();
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0, d.logs.join("\n"));
    assert.deepEqual(Object.keys(JSON.parse(readData("exploration-quota.json")).editions), [TO]);
    assert.deepEqual(readRenumberReport(toDir())!.global_stores_pending, []);
  });

  it("store já gravado na tentativa anterior (só o relatório ficou pra trás) ⇒ sai da lista sem recusar", () => {
    renumberWithQuotaWriteFailing();
    putData("exploration-quota.json", JSON.stringify({ editions: { [TO]: { used: 1 } } }, null, 2) + "\n");
    const report = completePendingGlobalStores(root, toDir(), readRenumberReport(toDir())!);
    assert.deepEqual(report.global_stores_pending, []);
  });

  it("--unschedule numa retomada que recusaria ⇒ exit 2 antes de desagendar", async () => {
    renumberWithQuotaWriteFailing();
    putData("exploration-quota.json", JSON.stringify({ editions: { [FROM]: { used: 7 } } }, null, 2) + "\n");
    write(join(toDir(), "_internal", "newsletter-kit-published.json"), JSON.stringify({ broadcast_id: 10, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
    const calls: string[] = [];
    const deps: UnscheduleDeps = {
      nowIso: () => "2026-11-10T12:00:00.000Z",
      deleteWorkerEntry: async () => ({ deleted: true, alreadyGone: false }),
      unscheduleKit: async (id) => {
        calls.push(`kit:${id}`);
        return { ok: true, message: "ok" };
      },
    };
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: deps }), 2);
    assert.deepEqual(calls, []);
  });

  it("globalStoreFromFingerprint: jsonl e array mudam com linha nova do ID; null sem entrada", () => {
    const jsonl = GLOBAL_EDITION_STORES.find((s) => s.kind === "jsonl-field")!;
    const a = globalStoreFromFingerprint(jsonl, `{"edition":"${FROM}","d":1}\n{"edition":"x"}\n`, FROM);
    const b = globalStoreFromFingerprint(jsonl, `{"edition":"${FROM}","d":1}\n{"edition":"${FROM}","d":2}\n`, FROM);
    assert.ok(a && b && a !== b);
    assert.equal(globalStoreFromFingerprint(jsonl, `{"edition":"x"}\n`, FROM), null);
    const arr = GLOBAL_EDITION_STORES.find((s) => s.kind === "array-field")!;
    assert.notEqual(
      globalStoreFromFingerprint(arr, JSON.stringify([{ edition_date: FROM }]), FROM),
      globalStoreFromFingerprint(arr, JSON.stringify([{ edition_date: FROM }, { edition_date: FROM, n: 1 }]), FROM),
    );
  });
});

describe("#12727 — principal falha depois de a semanal sair da agenda", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12727-"));
    put("02-reviewed.md", `Edição ${FROM}\n`);
    put("_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 10, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
    put(
      "_internal/kit-semanal-frio-published.json",
      JSON.stringify({ broadcast_id: 11, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z", source_broadcast_id: 10, tag_id: 7 }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fakes(failMain: "not_ok" | "throw") {
    const calls: string[] = [];
    const deps: UnscheduleDeps = {
      nowIso: () => "2026-11-10T12:00:00.000Z",
      deleteWorkerEntry: async () => ({ deleted: true, alreadyGone: false }),
      unscheduleKit: async (id) => {
        calls.push(`kit:${id}`);
        if (id === 10) {
          if (failMain === "throw") throw new Error("Kit 503");
          return { ok: false, message: "timeout" };
        }
        return { ok: true, message: "send_at: null confirmado" };
      },
    };
    return { deps, calls };
  }

  for (const mode of ["not_ok", "throw"] as const) {
    it(`REGRESSÃO (${mode}): o failed do principal diz que a semanal ficou desagendada e como reagendá-la`, async () => {
      const f = fakes(mode);
      const out = await unscheduleSends(fromDir(), f.deps);
      assert.deepEqual(f.calls, ["kit:11", "kit:10"]);
      const main = out.find((o) => o.what === "kit-newsletter")!;
      assert.equal(main.result, "failed");
      assert.match(main.detail, /semanal de frio \(broadcast 11\) está FORA da agenda/);
      assert.match(main.detail, /publish-kit-semanal-frio\.ts --edition-dir .*261110 --push/);
      assert.equal(readState("_internal/kit-semanal-frio-published.json").status, "created_unverified");
      assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
    });
  }

  it("reexecução (semanal já created_unverified) que falha de novo no principal mantém o aviso", async () => {
    await unscheduleSends(fromDir(), fakes("not_ok").deps);
    const f = fakes("not_ok");
    const out = await unscheduleSends(fromDir(), f.deps);
    // #12803 — created_unverified herdada pode estar agendada: desagenda de novo (idempotente) antes do principal.
    assert.deepEqual(f.calls, ["kit:11", "kit:10"]);
    assert.match(out.find((o) => o.what === "kit-newsletter")!.detail, /FORA da agenda/);
  });

  it("CLI: o aviso sai no log e o exit é 1, nada renumerado", async () => {
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO }, { root, log: d.log, unschedule: fakes("not_ok").deps }), 1);
    assert.match(d.logs.join("\n"), /\[failed\] kit-newsletter: .*FORA da agenda/);
    assert.ok(existsSync(fromDir()));
  });

  it("REGRESSÃO #12730/#12803: o aviso só afirma 'está FORA' depois de desagendar confirmado nesta execução", async () => {
    const first = await unscheduleSends(fromDir(), fakes("not_ok").deps);
    const d1 = first.find((o) => o.what === "kit-newsletter")!.detail;
    assert.match(d1, /está FORA da agenda \(desagendada nesta execução\)/);
    // Herdada created_unverified: desagendada de novo e confirmada nesta execução ⇒ o aviso continua verdadeiro.
    const second = await unscheduleSends(fromDir(), fakes("not_ok").deps);
    assert.equal(second.find((o) => o.what === "kit-semanal-frio")!.result, "unscheduled");
    assert.match(second.find((o) => o.what === "kit-newsletter")!.detail, /está FORA da agenda \(desagendada nesta execução\)/);
    // Herdada cujo desagendamento falha: o principal não é tocado (a semanal sairia sozinha).
    const calls: string[] = [];
    const third = await unscheduleSends(fromDir(), {
      nowIso: () => "x",
      deleteWorkerEntry: async () => ({ deleted: true, alreadyGone: false }),
      unscheduleKit: async (id) => {
        calls.push(`kit:${id}`);
        return id === 11 ? { ok: false, message: "Kit 503" } : { ok: true, message: "ok" };
      },
    });
    assert.deepEqual(calls, ["kit:11"]);
    assert.equal(third.find((o) => o.what === "kit-semanal-frio")!.result, "failed");
    assert.match(third.find((o) => o.what === "kit-newsletter")!.detail, /semanal de frio segue agendada/);
  });

  it("REGRESSÃO #12729: principal sem broadcast_id ⇒ aviso manda reagendar à mão no Kit, sem o comando do publisher que recusa", async () => {
    put("_internal/newsletter-kit-published.json", JSON.stringify({ status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
    const f = fakes("not_ok");
    const out = await unscheduleSends(fromDir(), f.deps);
    assert.deepEqual(f.calls, ["kit:11"]);
    const main = out.find((o) => o.what === "kit-newsletter")!;
    assert.equal(main.result, "failed");
    assert.match(main.detail, /registro sem broadcast_id/);
    assert.match(main.detail, /reagendar a semanal à mão no Kit, junto do principal/);
    assert.doesNotMatch(main.detail, /--push/);
    // Repetir sozinho cai no mesmo ramo: o aviso pede desagendar o principal à mão antes.
    assert.match(main.detail, /Desagendar o principal à mão no Kit e repetir o mesmo comando termina a troca/);
    assert.doesNotMatch(main.detail, /horário antigo\. Repetir o mesmo comando/);
  });

  it("principal desagendado com sucesso ⇒ sem o aviso", async () => {
    const calls: string[] = [];
    const out = await unscheduleSends(fromDir(), {
      nowIso: () => "x",
      deleteWorkerEntry: async () => ({ deleted: true, alreadyGone: false }),
      unscheduleKit: async (id) => {
        calls.push(String(id));
        return { ok: true, message: "ok" };
      },
    });
    assert.ok(out.every((o) => !/FORA da agenda/.test(o.detail)));
  });
});
