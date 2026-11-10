/**
 * test/renumber-edition-retry-12719.test.ts (#12719, #12720, #12721)
 *
 * Achados do review consolidado da rodada overnight 261110d sobre
 * `scripts/renumber-edition.ts`:
 * - #12719: falha ao mover a pasta depois de gravar os stores globais travava
 *   toda nova tentativa (conflito do `globalStoresRefusal`, exit 2); e falha
 *   num store depois do `mv` precisa ser retomável.
 * - #12720: `--unschedule` não desagendava a semanal de frio do Kit, e
 *   `detectScheduledSends` não a listava — ela disparava sozinha no dia antigo.
 * - #12721: `--unschedule` agia no Kit/Worker antes das recusas de
 *   `--video-dir` inválido e de `--run-remote` sem `--ack-scheduled`.
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
  buildRemoteSteps,
  detectScheduledSends,
  readRenumberReport,
  renumberLocal,
  unscheduleSends,
  type UnscheduleDeps,
} from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, runUnschedule, type RenumberCliDeps } from "../scripts/renumber-edition.ts";

const FROM = "261110";
const TO = "261111";
let root: string;
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);

function write(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const put = (rel: string, content: string) => write(join(fromDir(), rel), content);
const putData = (rel: string, content: string) => write(join(root, "data", rel), content);
const readData = (rel: string) => readFileSync(join(root, "data", rel), "utf8");
const readState = (rel: string, dir = fromDir()) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

function cliDeps(): RenumberCliDeps & { logs: string[] } {
  const logs: string[] = [];
  return { root, logs, log: (m) => void logs.push(m), nowIso: () => "2026-11-10T12:00:00.000Z", runStep: () => 0 };
}

function fakes(opts: { kitFail?: number[] } = {}) {
  const calls: string[] = [];
  const deps: UnscheduleDeps = {
    nowIso: () => "2026-11-10T12:00:00.000Z",
    deleteWorkerEntry: async (key) => {
      calls.push(`worker:${key}`);
      return { deleted: true, alreadyGone: false };
    },
    unscheduleKit: async (id) => {
      calls.push(`kit:${id}`);
      if (opts.kitFail?.includes(id)) return { ok: false, message: "releitura ainda mostra send_at" };
      return { ok: true, message: "send_at: null confirmado" };
    },
  };
  return { deps, calls };
}

function seedScheduled(): void {
  put("02-reviewed.md", `Edição ${FROM}\n`);
  put("_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 10, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z" }));
  put(
    "_internal/kit-semanal-frio-published.json",
    JSON.stringify({ broadcast_id: 11, status: "scheduled", scheduled_at: "2026-11-10T09:00:00Z", source_broadcast_id: 10, tag_id: 7 }),
  );
  put(
    "_internal/06-social-published.json",
    JSON.stringify({ posts: [{ platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-10T12:15:00Z", worker_queue_key: "queue:ig-d1" }] }),
  );
}

describe("#12719 — stores globais gravados depois do mv da pasta", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12719-"));
    put("02-reviewed.md", `Edição ${FROM}\n`);
    putData("intentional-errors.jsonl", `{"edition":"${FROM}","detail":"x"}\n`);
    putData("eia-used.json", JSON.stringify([{ edition_date: FROM }], null, 2));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: mv que falha deixa os stores intactos e a nova tentativa conclui", () => {
    const failingIo = {
      ...DEFAULT_RENUMBER_IO,
      renameDir: () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      },
    };
    assert.throws(() => renumberLocal(root, FROM, TO, "2026-11-10T12:00:00.000Z", [], failingIo), /EBUSY/);
    assert.match(readData("intentional-errors.jsonl"), new RegExp(`"edition":"${FROM}"`), "store intocado com o mv falho");
    assert.ok(existsSync(fromDir()));

    // Antes do fix: conflito de 261111 nos stores ⇒ exit 2 em toda tentativa.
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0, d.logs.join("\n"));
    assert.ok(!existsSync(fromDir()));
    assert.match(readData("intentional-errors.jsonl"), new RegExp(`"edition":"${TO}"`));
    assert.equal(JSON.parse(readData("eia-used.json"))[0].edition_date, TO);
    const report = readRenumberReport(toDir())!;
    assert.deepEqual(report.global_stores_pending, []);
    assert.deepEqual(report.global_stores!.map((g) => g.path).sort(), ["data/eia-used.json", "data/intentional-errors.jsonl"]);
  });

  it("falha num store depois do mv fica pendente no relatório e a retomada termina", () => {
    let writes = 0;
    const flakyIo = {
      ...DEFAULT_RENUMBER_IO,
      writeStore: (abs: string, text: string) => {
        writes += 1;
        if (writes === 2) throw new Error("EPERM: operation not permitted");
        DEFAULT_RENUMBER_IO.writeStore(abs, text);
      },
    };
    assert.throws(() => renumberLocal(root, FROM, TO, "2026-11-10T12:00:00.000Z", [], flakyIo), /EPERM/);
    assert.ok(existsSync(toDir()));
    const partial = readRenumberReport(toDir())!;
    assert.equal(partial.global_stores_pending!.length, 1, "um store gravado, um pendente");

    const dry = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, dry), 0);
    assert.match(dry.logs.join("\n"), /store global pendente/);

    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0, d.logs.join("\n"));
    assert.match(d.logs.join("\n"), /retomando/);
    assert.match(readData("intentional-errors.jsonl"), new RegExp(`"edition":"${TO}"`));
    assert.equal(JSON.parse(readData("eia-used.json"))[0].edition_date, TO);
    assert.deepEqual(readRenumberReport(toDir())!.global_stores_pending, []);
  });
});

describe("#12720 — semanal de frio no --unschedule e no aviso", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12720-"));
    seedScheduled();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: detectScheduledSends lista a semanal agendada", () => {
    const det = detectScheduledSends(fromDir(), "data/editions/2611/261111");
    const semanal = det.find((s) => s.what === "kit-semanal-frio");
    assert.ok(semanal, "a semanal agendada entra no aviso");
    assert.equal(semanal.scheduled_at, "2026-11-10T09:00:00Z");
    assert.equal(semanal.auto_unschedule, true);
  });

  it("REGRESSÃO: unscheduleSends desagenda a semanal ANTES do principal e grava created_unverified", async () => {
    const f = fakes();
    const out = await unscheduleSends(fromDir(), f.deps);
    assert.deepEqual(f.calls, ["kit:11", "kit:10", "worker:queue:ig-d1"]);
    assert.equal(out.find((o) => o.what === "kit-semanal-frio")!.result, "unscheduled");
    const semanal = readState("_internal/kit-semanal-frio-published.json");
    assert.equal(semanal.status, "created_unverified");
    assert.equal(semanal.tag_id, 7, "o resto do registro fica (a retomada usa tag_id)");
    assert.deepEqual(detectScheduledSends(fromDir(), "x"), [], "nada mais agendado");
    // Com a semanal fora da agenda, o passo remoto que a re-sincronizaria sai da lista.
    assert.ok(!buildRemoteSteps(root, "data/editions/2611/261110", TO).some((s) => s.id === "kit-semanal-frio"));
  });

  it("semanal que não sai da agenda segura o principal (não desagenda um sem o outro)", async () => {
    const f = fakes({ kitFail: [11] });
    const out = await unscheduleSends(fromDir(), f.deps);
    assert.ok(!f.calls.includes("kit:10"), "principal não é tocado");
    assert.equal(out.find((o) => o.what === "kit-semanal-frio")!.result, "failed");
    assert.equal(out.find((o) => o.what === "kit-newsletter")!.result, "failed");
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
    assert.equal(readState("_internal/kit-semanal-frio-published.json").status, "scheduled");
  });

  it("runRenumberEdition --run-remote sem --ack-scheduled recusa quando só a semanal está agendada", () => {
    put("_internal/newsletter-kit-published.json", JSON.stringify({ broadcast_id: 10, status: "draft" }));
    put("_internal/06-social-published.json", JSON.stringify({ posts: [] }));
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 2);
    assert.match(d.logs.join("\n"), /kit-semanal-frio/);
    assert.ok(existsSync(fromDir()), "nada renumerado");
  });
});

describe("#12721 — recusas antes de qualquer efeito externo do --unschedule", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12721-"));
    seedScheduled();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: --video-dir inexistente ⇒ exit 2 sem chamar Kit nem Worker", async () => {
    const f = fakes();
    const d = cliDeps();
    const code = await runUnschedule({ from: FROM, to: TO, videoDir: join(root, "nao-existe") }, { root, log: d.log, unschedule: f.deps });
    assert.equal(code, 2);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /--video-dir/);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
  });

  it("REGRESSÃO: --run-remote sem --ack-scheduled com Brevo agendada ⇒ exit 2 sem desagendar nada", async () => {
    put("_internal/brevo-diaria-published.json", JSON.stringify({ campaign_id: 5, status: "scheduled", scheduled_at: "2026-11-10T09:30:00Z" }));
    const f = fakes();
    const d = cliDeps();
    const code = await runUnschedule({ from: FROM, to: TO, runRemote: true }, { root, log: d.log, unschedule: f.deps });
    assert.equal(code, 2);
    assert.deepEqual(f.calls, []);
    assert.match(d.logs.join("\n"), /brevo-diaria/);
    assert.equal(readState("_internal/newsletter-kit-published.json").status, "scheduled");
  });

  it("com --ack-scheduled (ou sem --run-remote) o desagendamento segue", async () => {
    put("_internal/brevo-diaria-published.json", JSON.stringify({ campaign_id: 5, status: "scheduled" }));
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO, runRemote: true, ackScheduled: true }, { root, log: d.log, unschedule: f.deps }), 0);
    assert.deepEqual(f.calls, ["kit:11", "kit:10", "worker:queue:ig-d1"]);
  });

  it("só itens com caminho automático: --run-remote sem --ack-scheduled segue (o --unschedule os resolve)", async () => {
    const f = fakes();
    const d = cliDeps();
    assert.equal(await runUnschedule({ from: FROM, to: TO, runRemote: true }, { root, log: d.log, unschedule: f.deps }), 0, d.logs.join("\n"));
    const d2 = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d2), 0, d2.logs.join("\n"));
    assert.ok(!existsSync(fromDir()));
  });
});
