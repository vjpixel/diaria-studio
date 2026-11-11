/**
 * test/renumber-edition-12616.test.ts (#12616)
 *
 * - `scripts/renumber-edition.ts` + miolo em `scripts/lib/renumber-edition.ts`:
 *   troca de AAMMDD com borda numérica, `img-{de}-…` preservado, forense
 *   intocado, recusa de destino existente, retomada idempotente, passos
 *   remotos parados no 1º que falha. Tudo em tmpdir — nunca em `data/` real.
 * - `publish-kit-semanal-frio.ts`: semanal já agendada numa edição que deixou
 *   de ser de segunda (renumerada) acompanha o principal e re-sincroniza o
 *   conteúdo, em vez de sair com os IDs antigos (`not_monday`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRemoteSteps,
  planRenumber,
  readRenumberReport,
  renamedSegment,
  replaceEditionId,
} from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, type RenumberCliDeps } from "../scripts/renumber-edition.ts";
import { publishKitSemanalFrio, semanalSourceContentHash, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { buildTagFilter, type UpdateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import type { KitSemanalFrioPublished } from "../scripts/lib/kit-frio.ts";

describe("replaceEditionId / renamedSegment (#12616)", () => {
  it("troca só com borda numérica e preserva img-{de}-…", () => {
    const src =
      "edição 261109 /vote/261109/ utm_campaign=261109&x " +
      "20261109_150417.mp4 2612610910 img-261109-04-d1-2x1.jpg 2026-11-09";
    const r = replaceEditionId(src, "261109", "261110");
    assert.equal(
      r.text,
      "edição 261110 /vote/261110/ utm_campaign=261110&x " +
        "20261109_150417.mp4 2612610910 img-261109-04-d1-2x1.jpg 2026-11-09",
    );
    assert.equal(r.count, 3);
  });
  it("nome de arquivo", () => {
    assert.equal(renamedSegment("diaria-comentada-261109-short.mp4", "261109", "261110"), "diaria-comentada-261110-short.mp4");
    assert.equal(renamedSegment("20261109_150417.mp4", "261109", "261110"), null);
    assert.equal(renamedSegment("02-reviewed.md", "261109", "261110"), null);
  });
});

let root: string;
const FROM = "261109";
const TO = "261110";
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);

function put(rel: string, content: string | Buffer): void {
  const p = join(fromDir(), rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function seedEdition(): void {
  put("02-reviewed.md", "Edição 261109\n[vote](https://diar.ia.br/vote/261109/?utm_campaign=261109)\n");
  put("06-public-images.json", JSON.stringify({ d1: "https://eia.diar.ia.br/img/img-261109-04-d1-2x1.jpg" }));
  put("_internal/newsletter-final-kit.html", '<img src="https://eia.diar.ia.br/img/img-261109-04-d1-2x1.jpg"> jogar?edition=261109');
  put(
    "_internal/video-montagem/plan.json",
    JSON.stringify({ edition: "261109", path: "G:/Meu Drive/YouTube/261109/20261109_150417.mp4", id: "20261109_150417" }),
  );
  put("diaria-comentada-261109.srt", "1\n00:00:00,000 --> 00:00:01,000\nedição 261109\n");
  put("diaria-comentada-261109-short.mp4", Buffer.from([0, 1, 2, 0x32, 0x36, 0x31, 0x31, 0x30, 0x39, 0]));
  put("_internal/_forensic/swap-261109-0925-d1/x.json", '{"edition":"261109"}');
  put("_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"scheduled"}');
  put("_internal/site-page-published.json", '{"slug":"o-slug","published":true}');
  put("_internal/kit-semanal-frio-published.json", '{"broadcast_id":11,"status":"scheduled"}');
}

function cliDeps(codes: number[] = []): RenumberCliDeps & { logs: string[]; ran: string[][] } {
  const logs: string[] = [];
  const ran: string[][] = [];
  return {
    root,
    logs,
    ran,
    log: (m) => void logs.push(m),
    nowIso: () => "2026-11-10T12:00:00.000Z",
    runStep: (argv) => {
      ran.push(argv);
      return codes.shift() ?? 0;
    },
  };
}

describe("renumber-edition (#12616)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12616-"));
    seedEdition();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("dry-run (sem --apply) não escreve nada e lista os passos remotos com a pasta nova", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, d), 0);
    assert.ok(existsSync(fromDir()));
    assert.ok(!existsSync(toDir()));
    assert.match(readFileSync(join(fromDir(), "02-reviewed.md"), "utf8"), /261109/);
    const out = d.logs.join("\n");
    assert.match(out, /close-poll\.ts --edition 261110/);
    assert.match(out, /publish-kit-semanal-frio\.ts --edition-dir data\/editions\/2611\/261110 --push/);
    assert.doesNotMatch(out, /--edition-dir data\/editions\/2611\/261109/);
  });

  it("--apply: move a pasta, reescreve texto, renomeia .srt/.mp4, preserva img e forense, tira o cache de imagens", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0);
    assert.ok(!existsSync(fromDir()));
    const read = (rel: string) => readFileSync(join(toDir(), rel), "utf8");
    assert.equal(read("02-reviewed.md"), "Edição 261110\n[vote](https://diar.ia.br/vote/261110/?utm_campaign=261110)\n");
    const html = read("_internal/newsletter-final-kit.html");
    assert.match(html, /img-261109-04-d1-2x1\.jpg/, "objeto do R2 preservado");
    assert.match(html, /jogar\?edition=261110/);
    const plan = JSON.parse(read("_internal/video-montagem/plan.json"));
    assert.equal(plan.edition, "261110");
    assert.equal(plan.id, "20261109_150417", "nome do bruto no Drive intocado");
    assert.equal(plan.path, "G:/Meu Drive/YouTube/261110/20261109_150417.mp4");
    assert.match(read("diaria-comentada-261110.srt"), /edição 261110/);
    assert.ok(existsSync(join(toDir(), "diaria-comentada-261110-short.mp4")));
    assert.deepEqual([...readFileSync(join(toDir(), "diaria-comentada-261110-short.mp4"))].slice(3, 9), [0x32, 0x36, 0x31, 0x31, 0x30, 0x39], "binário intocado");
    assert.ok(!existsSync(join(toDir(), "06-public-images.json")));
    assert.match(read("_internal/_forensic/06-public-images.261109.json"), /img-261109/);
    assert.equal(read("_internal/_forensic/swap-261109-0925-d1/x.json"), '{"edition":"261109"}', "forense intocado");
    const report = readRenumberReport(toDir())!;
    assert.equal(report.from, FROM);
    assert.deepEqual(
      report.remote_steps.map((s) => `${s.id}:${s.status}`),
      [
        "upload-images-newsletter:pending",
        "upload-images-social:pending",
        "close-poll:pending",
        "kit-newsletter:pending",
        "site-page:pending",
        "kit-semanal-frio:pending",
      ],
    );
    assert.equal(report.preserved_img_refs, 1);
  });

  it("destino existente ⇒ recusa com exit 2, nada muda", () => {
    mkdirSync(toDir(), { recursive: true });
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2);
    assert.match(d.logs.join("\n"), /já existe/);
    assert.match(readFileSync(join(fromDir(), "02-reviewed.md"), "utf8"), /261109/);
  });

  it("origem ausente e destino sem relatório ⇒ recusa", () => {
    rmSync(fromDir(), { recursive: true });
    mkdirSync(toDir(), { recursive: true });
    const p = planRenumber(root, FROM, TO);
    assert.equal(p.ok, false);
  });

  it("--run-remote para no 1º passo que falha e a rodada seguinte retoma dali", () => {
    // O seed tem o Kit `scheduled`: sem --ack-scheduled o --run-remote é recusado (#12662).
    const d1 = cliDeps([0, 0, 3]);
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true, ackScheduled: true }, d1), 1);
    assert.equal(d1.ran.length, 3);
    assert.deepEqual(d1.ran[2], ["scripts/close-poll.ts", "--edition", TO]);
    const states = readRenumberReport(toDir())!.remote_steps.map((s) => s.status);
    assert.deepEqual(states, ["done", "done", "failed", "pending", "pending", "pending"]);

    const d2 = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true, ackScheduled: true }, d2), 0);
    assert.deepEqual(
      d2.ran.map((a) => a[0]),
      ["scripts/close-poll.ts", "scripts/publish-newsletter-kit.ts", "scripts/publish-edition-site-page.ts", "scripts/publish-kit-semanal-frio.ts"],
    );
    assert.deepEqual(d2.ran[2], ["scripts/publish-edition-site-page.ts", "--edition-dir", "data/editions/2611/261110", "--slug", "o-slug"]);
    assert.ok(readRenumberReport(toDir())!.remote_steps.every((s) => s.status === "done"));
  });

  it("virada de mês: 261130 → 261201 vai pra data/editions/2612/", () => {
    mkdirSync(join(root, "data", "editions", "2611", "261130"), { recursive: true });
    writeFileSync(join(root, "data", "editions", "2611", "261130", "02-reviewed.md"), "Edição 261130");
    assert.equal(runRenumberEdition({ from: "261130", to: "261201", apply: true, runRemote: false }, cliDeps()), 0);
    assert.equal(readFileSync(join(root, "data", "editions", "2612", "261201", "02-reviewed.md"), "utf8"), "Edição 261201");
  });

  it("passos dependentes de publicação só entram com o estado local", () => {
    rmSync(join(fromDir(), "_internal", "kit-semanal-frio-published.json"));
    rmSync(join(fromDir(), "_internal", "site-page-published.json"));
    const ids = buildRemoteSteps(root, "data/editions/2611/261109", FROM).map((s) => s.id);
    assert.deepEqual(ids, ["upload-images-newsletter", "upload-images-social", "close-poll", "kit-newsletter"]);
  });

  it("argumento inválido ⇒ exit 2", () => {
    assert.equal(runRenumberEdition({ from: "26110", to: TO, apply: false, runRemote: false }, cliDeps()), 2);
    assert.equal(runRenumberEdition({ from: FROM, to: FROM, apply: false, runRemote: false }, cliDeps()), 2);
    assert.equal(runRenumberEdition({ from: FROM, to: "261332", apply: false, runRemote: false }, cliDeps()), 2);
  });
});

describe("#12662 borda alfanumérica e edição já agendada", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-12662-"));
    seedEdition();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("REGRESSÃO: ID entre letras (hash hex, ID do YouTube/Drive) não é trocado", () => {
    const src = 'hash a1261109f etag=261109ab yt=dQ261109xY drive_1abc261109 key=queue:x-261109-d1 "261109" é261109';
    const r = replaceEditionId(src, "261109", "261110");
    assert.equal(r.text, 'hash a1261109f etag=261109ab yt=dQ261109xY drive_1abc261109 key=queue:x-261110-d1 "261110" é261109');
    assert.equal(r.count, 2);
    assert.equal(renamedSegment("thumb-a261109.jpg", "261109", "261110"), null);
    assert.equal(renamedSegment("diaria_261109_v2.srt", "261109", "261110"), "diaria_261110_v2.srt");
  });

  it("REGRESSÃO: Kit agendado ⇒ --run-remote recusado (exit 2, nada escrito), com o comando de reagendamento", () => {
    put("_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"scheduled","scheduled_at":"2026-11-09T09:00:00Z"}');
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 2);
    assert.equal(d.ran.length, 0, "nenhum passo remoto");
    assert.ok(existsSync(fromDir()) && !existsSync(toDir()), "parte local não rodou");
    const out = d.logs.join("\n");
    assert.match(out, /kit-newsletter @ 2026-11-09T09:00:00Z/);
    assert.match(out, /schedule-newsletter-kit\.ts --edition-dir data\/editions\/2611\/261110/);
    assert.match(out, /--ack-scheduled/);
  });

  it("REGRESSÃO: post social agendado na fila do Worker entra no aviso, com a key pro reagendamento", () => {
    put("_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"draft"}');
    // #12720 — semanal agendada também entra no aviso; aqui ela está fora da agenda.
    put("_internal/kit-semanal-frio-published.json", '{"broadcast_id":11,"status":"created_unverified"}');
    put(
      "_internal/06-social-published.json",
      JSON.stringify({
        posts: [
          { platform: "linkedin", destaque: "d1", subtype: "main", status: "scheduled", scheduled_at: "2026-11-09T12:15:00Z", worker_queue_key: "queue:2026-11-09T12:15:00.000Z:abc" },
          { platform: "facebook", destaque: "d2", status: "failed", scheduled_at: "2026-11-09T12:15:00Z" },
        ],
      }),
    );
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, d), 0, "dry-run só avisa");
    const out = d.logs.join("\n");
    assert.match(out, /ATENÇÃO: 1 envio/);
    assert.match(out, /social:linkedin\/d1 @ 2026-11-09T12:15:00Z/);
    assert.match(out, /reschedule-worker-queue-post\.ts --key "queue:2026-11-09T12:15:00.000Z:abc"/);
    assert.doesNotMatch(out, /facebook/);
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, cliDeps()), 2);
  });

  it("com --ack-scheduled segue com o aviso; sem nada agendado nem avisa", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true, ackScheduled: true }, d), 0);
    assert.ok(d.ran.length > 0);
    assert.match(d.logs.join("\n"), /ATENÇÃO/, "o aviso continua impresso");
  });

  it("sem nada agendado, --run-remote segue sem aviso", () => {
    put("_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"draft"}');
    put("_internal/kit-semanal-frio-published.json", '{"broadcast_id":11,"status":"created_unverified"}');
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 0);
    assert.doesNotMatch(d.logs.join("\n"), /ATENÇÃO/);
  });
});

describe("semanal de frio já agendada fora de segunda (#12616)", () => {
  const cfgFrioOn = {
    kit: {
      frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
      diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
    },
  };
  const SEND_AT = "2026-11-10T09:00:00.000Z";
  const OLD = { subject: "S", preview_text: "P", content: "<p>/vote/261109/</p>" };
  const NEW_CONTENT = "<p>/vote/261110/</p>";

  function deps(own: KitSemanalFrioPublished | null) {
    const updates: Array<{ id: number; input: UpdateBroadcastInput }> = [];
    const d: SemanalFrioPublishDeps = {
      log: () => {},
      nowIso: () => "2026-11-10T03:00:00Z",
      readMainState: () => ({ broadcast_id: 10, subject: "S", preview_text: "P", status: "scheduled", scheduled_at: SEND_AT }),
      readOwnState: () => own,
      writeOwnState: () => {},
      readPause: () => ({ paused: false }),
      findTagId: async () => 900,
      countTagMembers: async () => 5,
      getBroadcast: async (id) =>
        (id === 10
          ? { id, subject: "S", preview_text: "P", content: NEW_CONTENT, status: "scheduled", send_at: SEND_AT }
          : { id, subject: "S", preview_text: "P", content: "x", status: "scheduled", send_at: SEND_AT, subscriber_filter: buildTagFilter(900) }) as never,
      createBroadcast: async () => {
        throw new Error("não deveria criar fora de segunda");
      },
      scheduleBroadcast: async () => {},
      updateBroadcastContent: async (id, input) => void updates.push({ id, input }),
      deleteBroadcast: async () => {
        throw new Error("não deveria apagar");
      },
      raiseAlarm: () => {},
    };
    return { d, updates };
  }

  it("REGRESSÃO: edição renumerada pra terça com a semanal agendada ⇒ re-sincroniza o conteúdo (filtro explícito), não not_monday", async () => {
    const own: KitSemanalFrioPublished = {
      broadcast_id: 11,
      status: "scheduled",
      scheduled_at: SEND_AT,
      source_broadcast_id: 10,
      tag_id: 900,
      created_at: "2026-11-10T02:58:45Z",
      source_content_hash: semanalSourceContentHash(OLD),
    };
    const t = deps(own);
    const r = await publishKitSemanalFrio("/x/2611/261110", cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "content_synced");
    assert.equal(t.updates.length, 1);
    assert.equal(t.updates[0]!.id, 11);
    assert.deepEqual(t.updates[0]!.input.subscriber_filter, buildTagFilter(900));
    assert.ok(t.updates[0]!.input.content!.includes("/vote/261110/"));
  });

  it("fora de segunda e sem semanal ⇒ continua not_monday (não cria)", async () => {
    const r = await publishKitSemanalFrio("/x/2611/261110", cfgFrioOn, { push: true }, deps(null).d);
    assert.equal(r.status, "not_monday");
  });
});
