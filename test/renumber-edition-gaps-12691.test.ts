/**
 * test/renumber-edition-gaps-12691.test.ts (#12691)
 *
 * Lacunas da troca manual 261110 → 261111 (10/11/2026) que o
 * `scripts/renumber-edition.ts` não cobria:
 * - stores globais de `data/` com o ID fora da pasta da edição
 *   (`intentional-errors.jsonl`, `eia-used.json`, `exploration-quota.json`);
 * - a lista do que fica fora (Drive do vídeo, cache, peers, histórico);
 * - aviso de `edition-lock` vivo.
 * E a prova de que os arquivos citados na issue como "sobrando com o ID
 * antigo" (01-approved*.json, 02-title-picks.json, video-montagem/fact-check.json,
 * sentinels `.step-N-done.json`) já saem trocados pela varredura da pasta.
 * Tudo em tmpdir — nunca em `data/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GLOBAL_EDITION_STORES,
  leftOutItems,
  liveEditionLock,
  readRenumberReport,
  rewriteGlobalStore,
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

function cliDeps(nowIso = "2026-11-10T12:00:00.000Z"): RenumberCliDeps & { logs: string[] } {
  const logs: string[] = [];
  return { root, logs, log: (m) => void logs.push(m), nowIso: () => nowIso, runStep: () => 0 };
}

const store = (path: string) => GLOBAL_EDITION_STORES.find((s) => s.path === path)!;

describe("rewriteGlobalStore (#12691)", () => {
  it("jsonl: só a linha da edição muda; linha quebrada e outras edições ficam byte a byte", () => {
    const src = [
      '{"edition":"261109","detail":"cita 261110 no texto"}',
      '{"edition":"261110","detail":"Appel","correct_value":"Apple"}',
      '{"edition": "2611',
      "",
    ].join("\n");
    const r = rewriteGlobalStore(store("data/intentional-errors.jsonl"), src, FROM, TO);
    assert.equal(r.count, 1);
    assert.equal(r.conflict, 0);
    const lines = r.text.split("\n");
    assert.equal(lines[0], '{"edition":"261109","detail":"cita 261110 no texto"}');
    assert.deepEqual(JSON.parse(lines[1]), { edition: TO, detail: "Appel", correct_value: "Apple" });
    assert.equal(lines[2], '{"edition": "2611');
    assert.equal(lines[3], "");
  });

  it("jsonl: entrada já existente do ID novo é conflito", () => {
    const r = rewriteGlobalStore(store("data/intentional-errors.jsonl"), '{"edition":"261111"}\n{"edition":"261110"}\n', FROM, TO);
    assert.equal(r.conflict, 1);
  });

  it("array (eia-used): troca edition_date, mantém o resto", () => {
    const src = JSON.stringify([{ edition_date: "261110", image_date: "2026-11-10", title: "x" }, { edition_date: "261109" }], null, 2);
    const r = rewriteGlobalStore(store("data/eia-used.json"), src, FROM, TO);
    assert.equal(r.count, 1);
    const out = JSON.parse(r.text);
    assert.equal(out[0].edition_date, TO);
    assert.equal(out[0].image_date, "2026-11-10", "data da imagem não é o ID");
    assert.equal(out[1].edition_date, "261109");
  });

  it("object-key (exploration-quota): renomeia a chave e mantém a ordem", () => {
    const src = JSON.stringify({ editions: { "261106": { a: 1 }, "261110": { b: 2 }, "261112": { c: 3 } } });
    const r = rewriteGlobalStore(store("data/exploration-quota.json"), src, FROM, TO);
    assert.equal(r.count, 1);
    const out = JSON.parse(r.text);
    assert.deepEqual(Object.keys(out.editions), ["261106", "261111", "261112"]);
    assert.deepEqual(out.editions[TO], { b: 2 });
  });

  it("JSON ilegível é sinalizado, não reescrito", () => {
    const r = rewriteGlobalStore(store("data/eia-used.json"), "[{", FROM, TO);
    assert.equal(r.unreadable, true);
    assert.equal(r.text, "[{");
  });
});

describe("renumber-edition — lacunas da troca manual (#12691)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12691-"));
    put("02-reviewed.md", "Edição 261110\n");
    // Arquivos que a issue cita como "sobrando com o ID antigo" depois da troca manual.
    put("_internal/01-approved.json", JSON.stringify({ edition: FROM, items: [{ title: "T", date: "2026-11-10" }] }));
    put("_internal/01-approved-capped.json", JSON.stringify({ edition: FROM }));
    put("_internal/02-title-picks.json", JSON.stringify({ edition: FROM, picked_at: "2026-11-10T12:00:00-03:00" }));
    put("_internal/video-montagem/fact-check.json", JSON.stringify({ mode: "video", edition: FROM, checked_at: "2026-11-10T12:00:00-03:00" }));
    put("_internal/video-montagem/roteiro.md", "retranscribe 261110 --from 706.2\n");
    put("_internal/.step-4-done.json", JSON.stringify({ edition: FROM, stage: 4 }));
    putData("intentional-errors.jsonl", '{"edition":"261109","x":1}\n{"edition":"261110","detail":"Appel"}\n');
    putData("eia-used.json", JSON.stringify([{ edition_date: "261110", image_date: "2026-11-10" }], null, 2) + "\n");
    putData("exploration-quota.json", JSON.stringify({ editions: { "261110": { exploracao: true } } }, null, 2) + "\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("--apply troca o ID nos arquivos citados na issue e nos stores globais", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0);
    const read = (rel: string) => readFileSync(join(toDir(), rel), "utf8");
    assert.equal(JSON.parse(read("_internal/01-approved.json")).edition, TO);
    assert.equal(JSON.parse(read("_internal/01-approved.json")).items[0].date, "2026-11-10", "data de artigo intocada");
    assert.equal(JSON.parse(read("_internal/01-approved-capped.json")).edition, TO);
    assert.equal(JSON.parse(read("_internal/02-title-picks.json")).edition, TO);
    assert.equal(JSON.parse(read("_internal/video-montagem/fact-check.json")).edition, TO);
    assert.match(read("_internal/video-montagem/roteiro.md"), /retranscribe 261111/);
    assert.equal(JSON.parse(read("_internal/.step-4-done.json")).edition, TO);

    assert.equal(readData("intentional-errors.jsonl"), '{"edition":"261109","x":1}\n{"edition":"261111","detail":"Appel"}\n');
    assert.equal(JSON.parse(readData("eia-used.json"))[0].edition_date, TO);
    assert.deepEqual(Object.keys(JSON.parse(readData("exploration-quota.json")).editions), [TO]);

    const report = readRenumberReport(toDir())!;
    assert.deepEqual(report.global_stores, [
      { path: "data/intentional-errors.jsonl", count: 1 },
      { path: "data/eia-used.json", count: 1 },
      { path: "data/exploration-quota.json", count: 1 },
    ]);
    const out = d.logs.join("\n");
    assert.match(out, /fica fora/);
    assert.match(out, /Drive: renomear a pasta 261110\//);
  });

  it("dry-run lista os stores globais e o que fica fora, sem escrever", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, d), 0);
    const out = d.logs.join("\n");
    assert.match(out, /\[dry-run\] reescreveria data\/intentional-errors\.jsonl: 1 entrada/);
    assert.match(out, /\[dry-run\] reescreveria data\/exploration-quota\.json/);
    assert.match(out, /\[dry-run\] fica fora/);
    for (const item of leftOutItems(FROM, TO)) assert.ok(out.includes(item));
    assert.match(readData("intentional-errors.jsonl"), /"edition":"261110"/);
    assert.ok(existsSync(fromDir()));
  });

  it("entrada já existente do ID novo num store global ⇒ exit 2, nada escrito", () => {
    putData("intentional-errors.jsonl", '{"edition":"261111"}\n{"edition":"261110"}\n');
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2);
    assert.match(d.logs.join("\n"), /intentional-errors\.jsonl já tem 1 entrada\(s\) de 261111/);
    assert.ok(existsSync(fromDir()));
    assert.match(readFileSync(join(fromDir(), "02-reviewed.md"), "utf8"), /261110/);
    assert.match(readData("eia-used.json"), /"261110"/, "nenhum store escrito");
  });

  it("--unschedule não desagenda nada quando a troca seria recusada", async () => {
    putData("exploration-quota.json", "{");
    put("_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"scheduled"}');
    let called = 0;
    const logs: string[] = [];
    const code = await runUnschedule(
      { from: FROM, to: TO },
      {
        root,
        log: (m) => void logs.push(m),
        unschedule: {
          nowIso: () => "x",
          deleteWorkerEntry: async () => (called++, { deleted: true, alreadyGone: false }),
          unscheduleKit: async () => (called++, { ok: true, message: "ok" }),
        },
      },
    );
    assert.equal(code, 2);
    assert.equal(called, 0);
    assert.match(logs.join("\n"), /exploration-quota\.json ilegível/);
  });

  it("retomada não regrava stores globais (o ID antigo pode já ser de outra edição)", () => {
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, cliDeps()), 0);
    // Outra edição assume o ID antigo depois da troca (261109 → 261110 no mesmo dia).
    putData("intentional-errors.jsonl", readData("intentional-errors.jsonl") + '{"edition":"261110","detail":"da outra"}\n');
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, cliDeps()), 0);
    assert.match(readData("intentional-errors.jsonl"), /\{"edition":"261110","detail":"da outra"\}/);
  });

  it("avisa edition-lock vivo; tombstone e trava vencida não avisam", () => {
    const lockPath = join(fromDir(), "_internal", "edition-lock.json");
    const lock = { session_id: "s-1", host: "300", stage: 4, acquired_at: "2026-11-10T11:50:00.000Z", heartbeat_at: "2026-11-10T11:55:00.000Z" };
    write(lockPath, JSON.stringify(lock));
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, d), 0);
    assert.match(d.logs.join("\n"), /edition-lock vivo \(sessão s-1/);

    const now = Date.parse("2026-11-10T12:00:00.000Z");
    assert.ok(liveEditionLock(fromDir(), now));
    write(lockPath, JSON.stringify({ ...lock, released_at: "2026-11-10T11:58:00.000Z", completed_stage: 4 }));
    assert.equal(liveEditionLock(fromDir(), now), null);
    write(lockPath, JSON.stringify({ ...lock, heartbeat_at: "2026-11-10T10:00:00.000Z" }));
    assert.equal(liveEditionLock(fromDir(), now), null);
  });
});
