/**
 * test/youtube-short-related-10811.test.ts (#10811)
 *
 * Lógica pura do plano da task que vincula o horizontal como "vídeo
 * relacionado" do Short: resolução de IDs, decisões link/wait/skip/alert,
 * erros permanentes × transitórios, idempotência pelo registro
 * `_internal/06-short-related.json`, o caminho do `--alert` e a definição da
 * task local.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_SCHEDULED_TASKS, SCHEDULED_TASKS, renderDesktopScheduledTasksTable } from "../scripts/lib/scheduled-tasks.ts";
import { loadShortScheduleConfig } from "../scripts/lib/diaria/short-video.ts";
import type { ExistingEditionVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_ID,
  SHORT_RELATED_GIVE_UP_MINUTES,
  acceptListingMatch,
  brtInstant,
  brtTodayAammdd,
  buildShortRelatedAlert,
  buildShortRelatedRecord,
  classifyYouTubeError,
  decideShortRelatedPlan,
  isWeekdayEdition,
  markAlerted,
  parseShortRelatedRecord,
  resolveHorizontalId,
  resolveLinkedRecordIds,
  resolveShortId,
  resolveYouTubeReadCredentials,
  runShortRelatedAlert,
  studioShortsListUrl,
  type ShortRelatedAlertDeps,
  type ShortRelatedPlanInput,
  type ShortRelatedRecord,
} from "../scripts/lib/diaria/youtube-short-related.ts";
import type { YouTubeRecordSummary } from "../scripts/lib/diaria/youtube-video-link-gate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const H = "MMyBVHVQELI";
const S = "K3GqRK5gFds";
const ED = "261028"; // quarta-feira
const TITLE = "Título do D1";

function rec(over: Partial<YouTubeRecordSummary> = {}): YouTubeRecordSummary {
  return { videoId: H, url: `https://youtu.be/${H}`, state: "published", publishAt: null, sentinel: null, auditBlocked: null, path: "x", ...over };
}

function input(over: Partial<ShortRelatedPlanInput> = {}): ShortRelatedPlanInput {
  return {
    aammdd: ED,
    now: brtInstant(ED, "06:06"),
    editionExists: true,
    noVideo: false,
    horizontal: { id: H, source: "upload-record" },
    short: { id: S, source: "shorts-registry" },
    horizontalState: "published",
    horizontalTitle: TITLE,
    shortAt: brtInstant(ED, "12:00"),
    record: null,
    ...over,
  };
}

const linked = buildShortRelatedRecord({
  aammdd: ED, status: "linked", horizontalId: H, shortId: S, note: "Alterações salvas", now: new Date("2026-10-28T09:40:00Z"), previous: null,
});

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

  it("listagem: marca da edição e título aceitos; dia com 1 candidato aceito; dia com 2 recusado", () => {
    const v = (matchedBy: ExistingEditionVideo["matchedBy"], extra: Partial<ExistingEditionVideo> = {}): ExistingEditionVideo => ({
      videoId: H, url: `https://youtu.be/${H}`, title: TITLE, matchedBy, publishedAt: null, status: null, ...extra,
    });
    assert.equal(acceptListingMatch(v("edition-tag"))?.videoId, H);
    assert.equal(acceptListingMatch(v("title"))?.videoId, H);
    const one = v("period");
    assert.equal(acceptListingMatch({ ...one, periodCandidates: [one] })?.videoId, H);
    assert.equal(acceptListingMatch({ ...one, periodCandidates: [one, v("period", { videoId: "ZZZZZZZZZZZ" })] }), null);
    assert.equal(acceptListingMatch(null), null);
  });
});

describe("#10811 — datas e credenciais", () => {
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

  it("#8237: .env do repo vence o GOOGLE_CLIENT_* injetado no ambiente; YOUTUBE_CHANNEL_ID não é exigido", () => {
    const r = resolveYouTubeReadCredentials(
      { GOOGLE_CLIENT_ID: "repo-id", GOOGLE_CLIENT_SECRET: "repo-secret", YOUTUBE_REFRESH_TOKEN: "rt" },
      { GOOGLE_CLIENT_ID: "app-id", GOOGLE_CLIENT_SECRET: "app-secret" },
    );
    assert.deepEqual(r.credentials, { clientId: "repo-id", clientSecret: "repo-secret", refreshToken: "rt" });
    assert.deepEqual(r.overridden, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });

  it("credencial ausente no .env cai no ambiente; ausente nos dois vai para missing", () => {
    const r = resolveYouTubeReadCredentials({}, { GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" });
    assert.equal(r.credentials, null);
    assert.deepEqual(r.missing, ["YOUTUBE_REFRESH_TOKEN"]);
  });

  it("classificação: rede/5xx transitório; credencial, 401/403 e quota permanentes", () => {
    for (const m of ["sem rede para renovar o token do YouTube: fetch failed", "YouTube API respondeu 503: backend", "fetch failed", "read ECONNRESET"]) {
      assert.equal(classifyYouTubeError(m), "transient", m);
    }
    for (const m of [
      "refresh token do YouTube inválido ou expirado — rode `npx tsx scripts/youtube-oauth-setup.ts` de novo",
      "o Google recusou o client OAuth (invalid_client/unauthorized_client)",
      "o YouTube recusou o token (401) — refaça o consentimento",
      "o YouTube recusou (403 forbidden, etapa reread)",
      "quota diária da YouTube Data API esgotada",
      "credenciais do YouTube ausentes (YOUTUBE_REFRESH_TOKEN)",
    ]) {
      assert.equal(classifyYouTubeError(m), "permanent", m);
    }
  });
});

describe("#10811 — decisão", () => {
  it("horizontal público com título → link, com a URL do Studio", () => {
    const p = decideShortRelatedPlan(input());
    assert.equal(p.action, "link");
    assert.equal(p.horizontalId, H);
    assert.equal(p.shortId, S);
    assert.match(p.studioUrl, /\/videos\/short$/);
  });

  it("público depois do horário do Short ainda vincula", () => {
    const p = decideShortRelatedPlan(input({ now: brtInstant(ED, "12:30") }));
    assert.equal(p.action, "link");
    assert.match(p.reason, /depois do horário do Short/);
  });

  it("público sem título lido → wait (o roteiro escolhe pelo título), nunca link", () => {
    const p = decideShortRelatedPlan(input({ horizontalTitle: null }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /título/);
  });

  it("fim de semana, sem pasta, sem vídeo → skip", () => {
    assert.equal(decideShortRelatedPlan(input({ aammdd: "261024", now: brtInstant("261024", "06:30") })).action, "skip");
    assert.equal(decideShortRelatedPlan(input({ editionExists: false })).action, "skip");
    assert.equal(decideShortRelatedPlan(input({ noVideo: true })).action, "skip");
  });

  it("horizontal agendado antes do horário do Short → wait sem alerta devido", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "scheduled" }));
    assert.equal(p.action, "wait");
    assert.equal(p.alertDue, false);
    assert.equal(p.retryAfterMinutes, 2);
  });

  it("horizontal em estado unknown (drift do agendamento) → wait", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontalState: "unknown" })).action, "wait");
  });

  it("depois do horário do Short e antes do prazo: wait com alertDue (avisa e continua tentando)", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "12:10") }));
    assert.equal(p.action, "wait");
    assert.equal(p.alertDue, true);
    assert.equal(p.giveUpAt, new Date(brtInstant(ED, "12:00").getTime() + SHORT_RELATED_GIVE_UP_MINUTES * 60_000).toISOString());
  });

  it("depois do prazo de desistência → alert", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "13:00") })).action, "alert");
  });

  it("erro transitório (rede/5xx) → wait antes do prazo, nunca link", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: null, stateError: "YouTube API respondeu 503: x" }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /503/);
  });

  it("erro permanente (credencial, invalid_grant, 401) → alert imediato, mesmo cedo e sem IDs", () => {
    for (const stateError of ["credenciais do YouTube ausentes (YOUTUBE_REFRESH_TOKEN)", "refresh token do YouTube inválido ou expirado", "o YouTube recusou o token (401)"]) {
      assert.equal(decideShortRelatedPlan(input({ horizontalState: null, stateError })).action, "alert", stateError);
    }
    assert.equal(decideShortRelatedPlan(input({ horizontal: null, short: null, horizontalState: null, stateError: "o YouTube recusou o token (401)" })).action, "alert");
  });

  it("Short ausente → wait; registro ilegível aparece no motivo", () => {
    const p = decideShortRelatedPlan(input({ short: null, resolveError: "06-shorts-published.json: JSON inválido" }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /JSON inválido/);
    assert.equal(decideShortRelatedPlan(input({ short: null, now: brtInstant(ED, "13:01") })).action, "alert");
  });

  it("horizontal ausente → wait", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontal: null })).action, "wait");
  });

  it("horizontal e Short com o MESMO id → alert, nunca link", () => {
    assert.equal(decideShortRelatedPlan(input({ short: { id: H, source: "channel-listing" } })).action, "alert");
  });

  it("horário do Short desconhecido e horizontal não público → alert (sem prazo para esperar)", () => {
    assert.equal(decideShortRelatedPlan(input({ horizontalState: "scheduled", shortAt: null })).action, "alert");
  });
});

describe("#10811 — idempotência pelo registro", () => {
  it("já linked com os mesmos IDs → skip, sem precisar do estado", () => {
    const p = decideShortRelatedPlan(input({ record: linked, horizontalState: null }));
    assert.equal(p.action, "skip");
    assert.equal(p.alreadyLinked, true);
  });

  it("linked, com horizontal não resolvido agora → skip", () => {
    assert.equal(decideShortRelatedPlan(input({ record: linked, horizontal: null })).action, "skip");
  });

  it("linked com outro horizontal ou outro Short (re-upload) → vincula de novo", () => {
    assert.equal(decideShortRelatedPlan(input({ record: { ...linked, horizontalId: "ZZZZZZZZZZZ" } })).action, "link");
    assert.equal(decideShortRelatedPlan(input({ record: { ...linked, shortId: "YYYYYYYYYYY" } })).action, "link");
  });

  it("failed não bloqueia nova tentativa", () => {
    const failed: ShortRelatedRecord = { ...linked, status: "failed" };
    assert.equal(decideShortRelatedPlan(input({ record: failed })).action, "link");
  });

  it("linked sem IDs é recusado (builder e parser)", () => {
    assert.throws(() => buildShortRelatedRecord({ aammdd: ED, status: "linked", horizontalId: null, shortId: S, note: null, now: new Date(), previous: null }));
    assert.throws(() => parseShortRelatedRecord(JSON.stringify({ ...linked, horizontalId: null }), ED), /exige os IDs/);
  });

  it("parse: round-trip; recusa outra edição, JSON ilegível, status inválido, at ausente, alertedAt não-string", () => {
    assert.deepEqual(parseShortRelatedRecord(JSON.stringify(linked), ED), linked);
    assert.throws(() => parseShortRelatedRecord(JSON.stringify(linked), "261029"), /261028/);
    assert.throws(() => parseShortRelatedRecord("{", ED), /JSON inválido/);
    assert.throws(() => parseShortRelatedRecord(JSON.stringify({ ...linked, status: "ok" }), ED), /status inválido/);
    const { at: _at, ...noAt } = linked;
    assert.throws(() => parseShortRelatedRecord(JSON.stringify(noAt), ED), /"at"/);
    assert.throws(() => parseShortRelatedRecord(JSON.stringify({ ...linked, alertedAt: 5 }), ED), /alertedAt/);
  });

  it("registro preserva o alertedAt anterior e o plano expõe alreadyAlerted", () => {
    const prev: ShortRelatedRecord = { ...linked, status: "failed", alertedAt: "2026-10-28T15:00:00Z" };
    const next = buildShortRelatedRecord({ aammdd: ED, status: "linked", horizontalId: H, shortId: S, note: null, now: new Date(), previous: prev });
    assert.equal(next.alertedAt, "2026-10-28T15:00:00Z");
    assert.equal(decideShortRelatedPlan(input({ record: prev })).alreadyAlerted, true);
  });

  it("markAlerted: sem anterior nasce 'alerted' (não 'failed'); com anterior só ganha alertedAt", () => {
    const now = new Date("2026-10-28T15:00:00Z");
    const fresh = markAlerted({ aammdd: ED, previous: null, horizontalId: H, shortId: null, note: "x", now });
    assert.equal(fresh.status, "alerted");
    assert.equal(fresh.alertedAt, now.toISOString());
    assert.deepEqual(parseShortRelatedRecord(JSON.stringify(fresh), ED), fresh);
    const failed: ShortRelatedRecord = { ...linked, status: "failed" };
    assert.deepEqual(markAlerted({ aammdd: ED, previous: failed, horizontalId: null, shortId: null, note: null, now }), { ...failed, alertedAt: now.toISOString() });
  });
});

describe("#10811 — --record linked", () => {
  it("plano link: usa os IDs do plano; IDs explícitos iguais passam", () => {
    const p = decideShortRelatedPlan(input());
    assert.deepEqual(resolveLinkedRecordIds(p, {}), { horizontalId: H, shortId: S });
    assert.deepEqual(resolveLinkedRecordIds(p, { horizontalId: H, shortId: S }), { horizontalId: H, shortId: S });
  });

  it("IDs explícitos divergentes do recalculado → recusado", () => {
    const p = decideShortRelatedPlan(input());
    assert.throws(() => resolveLinkedRecordIds(p, { horizontalId: "ZZZZZZZZZZZ", shortId: S }), /diverge/);
    assert.throws(() => resolveLinkedRecordIds(p, { horizontalId: H, shortId: "YYYYYYYYYYY" }), /diverge/);
  });

  it("plano não-link sem IDs explícitos → recusado; com IDs (API caiu no registro) → aceito", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: null, stateError: "fetch failed" }));
    assert.equal(p.action, "wait");
    assert.throws(() => resolveLinkedRecordIds(p, {}), /recusado/);
    assert.deepEqual(resolveLinkedRecordIds(p, { horizontalId: H, shortId: S }), { horizontalId: H, shortId: S });
  });

  it("skip de fim de semana recusa mesmo com IDs; 'já vinculado' aceita", () => {
    const weekend = decideShortRelatedPlan(input({ aammdd: "261024", now: brtInstant("261024", "06:30") }));
    assert.throws(() => resolveLinkedRecordIds(weekend, { horizontalId: H, shortId: S }), /recusado/);
    const already = decideShortRelatedPlan(input({ record: linked }));
    assert.deepEqual(resolveLinkedRecordIds(already, {}), { horizontalId: H, shortId: S });
  });
});

describe("#10811 — --alert (runShortRelatedAlert)", () => {
  function deps(over: Partial<ShortRelatedAlertDeps> = {}) {
    const sent: Array<{ subject: string; body: string }> = [];
    const written: ShortRelatedRecord[] = [];
    const d: ShortRelatedAlertDeps = {
      aammdd: ED,
      note: "horizontal não ficou público",
      now: new Date("2026-10-28T15:05:00Z"),
      computePlan: async () => decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "12:05") })),
      readRecord: () => null,
      send: async (m) => {
        sent.push(m);
        return { ok: true };
      },
      writeRecord: (r) => {
        written.push(r);
      },
      log: () => {},
      ...over,
    };
    return { d, sent, written };
  }

  it("envia e grava 'alerted' com alertedAt", async () => {
    const { d, sent, written } = deps();
    const out = await runShortRelatedAlert(d);
    assert.equal(out.kind, "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /segue tentando/);
    assert.equal(written[0].status, "alerted");
    assert.equal(written[0].alertedAt, "2026-10-28T15:05:00.000Z");
  });

  it("dedup: alertedAt anterior → não reenvia", async () => {
    const { d, sent } = deps({ readRecord: () => ({ ...linked, status: "failed", alertedAt: "2026-10-28T15:00:00Z" }) });
    assert.equal((await runShortRelatedAlert(d)).kind, "skipped");
    assert.equal(sent.length, 0);
  });

  it("plano lança (registro do Short corrompido etc.) → envia o corpo de fallback com o erro", async () => {
    const { d, sent } = deps({
      computePlan: async () => {
        throw new Error("06-shorts-published.json: JSON inválido");
      },
    });
    assert.equal((await runShortRelatedAlert(d)).kind, "sent");
    assert.match(sent[0].subject, /erro no plano/);
    assert.match(sent[0].body, /JSON inválido/);
    assert.match(sent[0].body, /videos\/short/);
  });

  it("registro do vínculo corrompido → envia sem dedup e não sobrescreve o arquivo", async () => {
    const { d, sent, written } = deps({
      readRecord: () => {
        throw new Error("06-short-related.json: JSON inválido");
      },
      computePlan: async () => {
        throw new Error("06-short-related.json: JSON inválido");
      },
    });
    const out = await runShortRelatedAlert(d);
    assert.equal(out.kind, "sent-not-recorded");
    assert.equal(sent.length, 1);
    assert.equal(written.length, 0);
  });

  it("falha do envio → send-failed, nada gravado", async () => {
    const { d, written } = deps({ send: async () => ({ ok: false, error: "invalid_grant" }) });
    const out = await runShortRelatedAlert(d);
    assert.deepEqual(out, { kind: "send-failed", error: "invalid_grant" });
    assert.equal(written.length, 0);
  });

  it("enviado mas a gravação falha → sent-not-recorded (não é falha do e-mail)", async () => {
    const { d, sent } = deps({
      writeRecord: () => {
        throw new Error("EPERM");
      },
    });
    const out = await runShortRelatedAlert(d);
    assert.equal(out.kind, "sent-not-recorded");
    assert.equal(sent.length, 1);
  });

  it("texto do alerta cita a edição, os IDs e o caminho manual no Studio", () => {
    const p = decideShortRelatedPlan(input({ horizontalState: "draft", now: brtInstant(ED, "13:30") }));
    const m = buildShortRelatedAlert(p, null);
    assert.match(m.subject, /261028/);
    assert.match(m.body, new RegExp(H));
    assert.match(m.body, new RegExp(S));
    assert.match(m.body, /Vídeo relacionado/);
    assert.match(m.body, /desistiu/);
  });
});

describe("#10811 — validação de argumentos do CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/youtube-short-related-plan.ts"), ...args], { encoding: "utf8", cwd: ROOT });

  it("--alert 261028 (data depois da flag) não vira modo plano em silêncio", () => {
    const r = run("--alert", "261028");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não leva valor/);
  });

  it("flag desconhecida, --record inválido e dois positionais → exit 2", () => {
    assert.equal(run("261028", "--alerta").status, 2);
    assert.equal(run("261028", "--record", "ok").status, 2);
    assert.equal(run("261028", "261029").status, 2);
  });
});

describe("#10811 — definição da task local (DESKTOP_SCHEDULED_TASKS)", () => {
  const task = DESKTOP_SCHEDULED_TASKS.find((t) => t.taskId === "diaria-short-video-relacionado");

  it("existe, no Neo, dias úteis às 06:05, fora do registro systemd", () => {
    assert.ok(task);
    assert.equal(task.machine, "neo");
    assert.equal(task.cronExpression, "5 6 * * 1-5");
    assert.equal(task.cronExpression.split(" ").length, 5);
    assert.equal(SCHEDULED_TASKS.some((t) => t.name === task.taskId), false);
  });

  it("o cron não colide com nenhum horário de rotação do Short (tem de rodar antes do mais cedo)", () => {
    assert.ok(task);
    const [min, hour] = task.cronExpression.split(" ").map(Number);
    const cfg = loadShortScheduleConfig(JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")));
    const earliest = Math.min(...[...cfg.rotationTimes, cfg.defaultTime].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))));
    assert.ok(hour * 60 + min < earliest, `task ${hour}:${min} não roda antes do Short mais cedo (${earliest} min)`);
  });

  it("prompt é ponteiro para o roteiro, que existe, usa o script do plano e o timeout de 600000", () => {
    assert.ok(task);
    assert.ok(task.prompt.includes(task.playbook));
    assert.match(task.prompt, /600000/);
    const playbook = readFileSync(resolve(ROOT, task.playbook), "utf8");
    for (const cmd of ["youtube-short-related-plan.ts --json", "--record linked --horizontal-id", "--record failed", "--alert", "600000"]) {
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
