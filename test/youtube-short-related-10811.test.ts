/**
 * test/youtube-short-related-10811.test.ts (#10811)
 *
 * Lógica pura do plano da task das 06:30 que vincula o horizontal como
 * "vídeo relacionado" do Short: resolução de IDs, decisões link/wait/skip/alert,
 * idempotência pelo registro `_internal/06-short-related.json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_SCHEDULED_TASKS, SCHEDULED_TASKS, renderDesktopScheduledTasksTable } from "../scripts/lib/scheduled-tasks.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_ID,
  brtInstant,
  brtTodayAammdd,
  buildShortRelatedAlert,
  buildShortRelatedRecord,
  decideShortRelatedPlan,
  isWeekdayEdition,
  parseShortRelatedRecord,
  resolveHorizontalId,
  resolveShortId,
  studioShortsListUrl,
  type ShortRelatedPlanInput,
} from "../scripts/lib/diaria/youtube-short-related.ts";
import type { YouTubeRecordSummary } from "../scripts/lib/diaria/youtube-video-link-gate.ts";

const H = "MMyBVHVQELI";
const S = "K3GqRK5gFds";
const ED = "261028"; // quarta-feira

function rec(over: Partial<YouTubeRecordSummary> = {}): YouTubeRecordSummary {
  return { videoId: H, url: `https://youtu.be/${H}`, state: "published", publishAt: null, sentinel: null, auditBlocked: null, path: "x", ...over };
}

function input(over: Partial<ShortRelatedPlanInput> = {}): ShortRelatedPlanInput {
  return {
    aammdd: ED,
    now: brtInstant(ED, "06:31"),
    editionExists: true,
    noVideo: false,
    horizontal: { id: H, source: "upload-record" },
    short: { id: S, source: "shorts-registry" },
    horizontalState: "published",
    shortAt: brtInstant(ED, "12:00"),
    record: null,
    ...over,
  };
}

describe("#10811 — resolução de IDs", () => {
  it("horizontal: registro do upload vence o 05-video-url.txt", () => {
    assert.deepEqual(resolveHorizontalId({ record: rec(), videoUrl: "https://youtu.be/AAAAAAAAAAA" }), { id: H, source: "upload-record" });
  });

  it("horizontal: registro em estado incerto cai no 05-video-url.txt", () => {
    const r = resolveHorizontalId({ record: rec({ sentinel: "in_progress", videoId: null }), videoUrl: `https://www.youtube.com/watch?v=${H}` });
    assert.deepEqual(r, { id: H, source: "video-url-file" });
  });

  it("horizontal: nada nos dois → null", () => {
    assert.equal(resolveHorizontalId({ record: null, videoUrl: null }), null);
  });

  it("Short: id cru do upload por API e URL do --mark guiado", () => {
    assert.deepEqual(
      resolveShortId({ aammdd: ED, entries: [{ destination: "youtube_shorts", status: "scheduled", id: S, at: "2026-10-27T10:00:00Z" }] }),
      { id: S, source: "shorts-registry" },
    );
    assert.deepEqual(
      resolveShortId({
        aammdd: ED,
        entries: [{ destination: "youtube_shorts", status: "published", id: `https://youtube.com/shorts/${S}`, url: `https://youtube.com/shorts/${S}`, at: "x" }],
      }),
      { id: S, source: "shorts-registry" },
    );
  });

  it("Short: send_unknown e destino ausente → null (listagem decide)", () => {
    assert.equal(
      resolveShortId({ aammdd: ED, entries: [{ destination: "youtube_shorts", status: "send_unknown", id: "send_unknown-x", at: "x" }] }),
      null,
    );
    assert.equal(resolveShortId({ aammdd: ED, entries: [{ destination: "instagram", status: "published", id: "1", at: "x" }] }), null);
    assert.equal(resolveShortId(null), null);
  });
});

describe("#10811 — datas", () => {
  it("dia útil × fim de semana", () => {
    assert.equal(isWeekdayEdition("261028"), true);
    assert.equal(isWeekdayEdition("261024"), false); // sábado
    assert.equal(isWeekdayEdition("261025"), false); // domingo
  });

  it("hoje em BRT vira o dia anterior antes das 03:00 UTC", () => {
    assert.equal(brtTodayAammdd(new Date("2026-10-28T02:59:00Z")), "261027");
    assert.equal(brtTodayAammdd(new Date("2026-10-28T09:30:00Z")), "261028");
  });

  it("brtInstant converte HH:MM BRT", () => {
    assert.equal(brtInstant("261028", "06:30").toISOString(), "2026-10-28T09:30:00.000Z");
  });

  it("URL do Studio é a lista de Shorts do canal certo", () => {
    assert.equal(studioShortsListUrl(), `https://studio.youtube.com/channel/${DIARIA_YOUTUBE_CHANNEL_ID}/videos/short`);
    assert.equal(DIARIA_YOUTUBE_CHANNEL_ID, "UCSsppeUnBy6q-4a5hsl5u0w");
  });
});

describe("#10811 — decisão", () => {
  it("horizontal público → link, com a URL do Studio", () => {
    const p = decideShortRelatedPlan(input());
    assert.equal(p.action, "link");
    assert.equal(p.horizontalId, H);
    assert.equal(p.shortId, S);
    assert.match(p.studioUrl, /\/videos\/short$/);
  });

  it("público depois do horário do Short ainda vincula", () => {
    const p = decideShortRelatedPlan(input({ now: brtInstant(ED, "13:00") }));
    assert.equal(p.action, "link");
    assert.match(p.reason, /depois do horário do Short/);
  });

  it("fim de semana → skip", () => {
    assert.equal(decideShortRelatedPlan(input({ aammdd: "261024", now: brtInstant("261024", "06:30") })).action, "skip");
  });

  it("sem pasta da edição → skip", () => {
    assert.equal(decideShortRelatedPlan(input({ editionExists: false })).action, "skip");
  });

  it("edição marcada sem vídeo → skip", () => {
    assert.equal(decideShortRelatedPlan(input({ noVideo: true })).action, "skip");
  });

  it("horizontal agendado antes do horário do Short → wait com retry", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "scheduled" }));
    assert.equal(p.action, "wait");
    assert.equal(p.retryAfterMinutes, 10);
  });

  it("horizontal não público depois do horário do Short → alert", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "12:00") }));
    assert.equal(p.action, "alert");
  });

  it("estado não conferido (API falhou) → wait antes do prazo, nunca link", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: null, stateError: "401" }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /401/);
  });

  it("Short ausente → wait, e alert depois do prazo", () => {
    assert.equal(decideShortRelatedPlan(input({ short: null })).action, "wait");
    assert.equal(decideShortRelatedPlan(input({ short: null, now: brtInstant(ED, "12:01") })).action, "alert");
  });

  it("horizontal ausente → wait", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontal: null })).action, "wait");
  });

  it("horário do Short desconhecido e horizontal não público → alert (sem prazo para esperar)", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontalState: "scheduled", shortAt: null })).action, "alert");
  });
});

describe("#10811 — idempotência pelo registro", () => {
  const linked = buildShortRelatedRecord({
    aammdd: ED, status: "linked", horizontalId: H, shortId: S, note: "Alterações salvas", now: new Date("2026-10-28T09:40:00Z"), previous: null,
  });

  it("já linked com os mesmos IDs → skip, sem precisar do estado", () => {
    const p = decideShortRelatedPlan(input({ record: linked, horizontalState: null }));
    assert.equal(p.action, "skip");
    assert.match(p.reason, /já vinculado/);
  });

  it("linked com outro horizontal (re-upload) → vincula de novo", () => {
    const p = decideShortRelatedPlan(input({ record: { ...linked, horizontalId: "ZZZZZZZZZZZ" } }));
    assert.equal(p.action, "link");
  });

  it("failed não bloqueia nova tentativa", () => {
    const failed = { ...linked, status: "failed" as const };
    assert.equal(decideShortRelatedPlan(input({ record: failed })).action, "link");
  });

  it("linked sem IDs é recusado", () => {
    assert.throws(() => buildShortRelatedRecord({ aammdd: ED, status: "linked", horizontalId: null, shortId: S, note: null, now: new Date(), previous: null }));
  });

  it("registro preserva o alertedAt anterior e o plano expõe alreadyAlerted", () => {
    const prev = { ...linked, status: "failed" as const, alertedAt: "2026-10-28T15:00:00Z" };
    const next = buildShortRelatedRecord({ aammdd: ED, status: "linked", horizontalId: H, shortId: S, note: null, now: new Date(), previous: prev });
    assert.equal(next.alertedAt, "2026-10-28T15:00:00Z");
    assert.equal(decideShortRelatedPlan(input({ record: prev })).alreadyAlerted, true);
  });

  it("parse: round-trip e recusa de registro de outra edição ou ilegível", () => {
    const raw = JSON.stringify(linked);
    assert.deepEqual(parseShortRelatedRecord(raw, ED), linked);
    assert.throws(() => parseShortRelatedRecord(raw, "261029"), /261028/);
    assert.throws(() => parseShortRelatedRecord("{", ED), /JSON inválido/);
    assert.throws(() => parseShortRelatedRecord(JSON.stringify({ ...linked, status: "ok" }), ED), /status inválido/);
  });
});

describe("#10811 — alerta", () => {
  it("texto cita a edição, os IDs e o caminho manual no Studio", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "12:30") }));
    const m = buildShortRelatedAlert(p, null);
    assert.match(m.subject, /261028/);
    assert.match(m.body, new RegExp(H));
    assert.match(m.body, new RegExp(S));
    assert.match(m.body, /Vídeo relacionado/);
  });
});

describe("#10811 — definição da task local (DESKTOP_SCHEDULED_TASKS)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const task = DESKTOP_SCHEDULED_TASKS.find((t) => t.taskId === "diaria-short-video-relacionado");

  it("existe, no Neo, dias úteis às 06:30, fora do registro systemd", () => {
    assert.ok(task);
    assert.equal(task.machine, "neo");
    assert.equal(task.cronExpression, "30 6 * * 1-5");
    assert.equal(SCHEDULED_TASKS.some((t) => t.name === task.taskId), false);
  });

  it("prompt é ponteiro para o roteiro, que existe e usa o script do plano", () => {
    assert.ok(task);
    assert.ok(task.prompt.includes(task.playbook));
    const playbook = readFileSync(resolve(ROOT, task.playbook), "utf8");
    for (const cmd of ["youtube-short-related-plan.ts --json", "--record linked", "--record failed", "--alert"]) {
      assert.ok(playbook.includes(cmd), `roteiro sem ${cmd}`);
    }
    assert.ok(playbook.includes(studioShortsListUrl().replace("https://studio.youtube.com", "")));
  });

  it("docs/scheduled-tasks-registry.md cita a task", () => {
    assert.ok(task);
    assert.ok(readFileSync(resolve(ROOT, "docs/scheduled-tasks-registry.md"), "utf8").includes(task.taskId));
  });

  it("listagem --desktop tem uma linha por task", () => {
    assert.equal(renderDesktopScheduledTasksTable().split("\n").length, DESKTOP_SCHEDULED_TASKS.length);
  });
});
