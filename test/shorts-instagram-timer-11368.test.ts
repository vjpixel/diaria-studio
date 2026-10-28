/**
 * test/shorts-instagram-timer-11368.test.ts (#11368)
 *
 * Endurecimentos P3 do timer do Reels no 300 (#11352/#11369): dedup do alarme
 * por motivo + causa, aviso do publish vira alarme, corte velho que sumiu do
 * Drive não é reaproveitado, `--now` no publish do timer, a consulta única ao
 * Drive depois do teto, o genérico ainda a caminho, erro do Drive que não
 * esconde alarme, o comando manual sem `--video` inexistente, e a ligação do
 * `runInstagramTimer` de ponta a ponta (Drive, publish e `gh`/e-mail falsos).
 * Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERIC_PENDING_ALARM_AFTER_MS,
  INSTAGRAM_CUT_SIDECAR_FILE,
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE,
  MISSING_VIDEO_ALARM_AFTER_MS,
  alarm,
  alarmId,
  alarmKeyOf,
  alarmSeverity,
  alarmSuppressed,
  buildInstagramTimerAlarm,
  chooseInstagramVideo,
  decideInstagramTimerRun,
  driveVerticalCheck,
  instagramPublishArgs,
  interpretInstagramTimerOutput,
  runInstagramTimer,
  type InstagramCutLookup,
  type InstagramTimerRunDeps,
} from "../scripts/shorts-instagram-timer.ts";
import { readShortsRegistryRaws } from "../scripts/lib/diaria/shorts-published-store.ts";
import { shortInstagramVideoFileName, shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = { facebook_pages: [], instagram: true, instagram_collaborators: ["vjpixel"], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE };
const CFG = { publishing: { shorts: SHORTS } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const H = 60 * 60_000;

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "shorts-ig-timer-11368-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n");
  return dir;
}

/** `gh` e e-mail falsos com estado (issue achada pelo marcador nas execuções seguintes). */
function fakeNotify() {
  const issues: { number: number; url: string; title: string; body: string; state: string }[] = [];
  const emails: string[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      const n = 900 + issues.length;
      issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, title: args[args.indexOf("--title") + 1] ?? "", body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
      return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
    }
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "edit" || args[1] === "reopen")) return { status: 0, stdout: "", stderr: "" };
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  const sendPush = async (m: { subject: string }) => {
    emails.push(m.subject);
    return { ok: true };
  };
  return { issues, emails, deps: { ghRun, sendPush, emailPolicy: "urgent_only" as const, log: () => true } };
}

const NONE: InstagramCutLookup = { kind: "none", reason: "nada" };
const FOUND: InstagramCutLookup = { kind: "found", fileId: "abcdefghijk", name: "Diaria comentada_Instagram_V3.mp4", modifiedTime: "2026-10-27T09:00:00.000Z" };

function runDeps(over: Partial<InstagramTimerRunDeps> & { now: Date }, notify = fakeNotify()) {
  const calls = { instagram: 0, generic: 0, scripts: [] as string[][] };
  const deps: InstagramTimerRunDeps = {
    config: CFG,
    lookupInstagramCut: () => NONE,
    lookupGenericVertical: () => NONE,
    runScript: () => {
      throw new Error("publish inesperado");
    },
    notify: notify.deps,
    ...over,
  };
  const wrapped: InstagramTimerRunDeps = {
    ...deps,
    lookupInstagramCut: () => {
      calls.instagram++;
      return deps.lookupInstagramCut();
    },
    lookupGenericVertical: () => {
      calls.generic++;
      return deps.lookupGenericVertical();
    },
    runScript: (args) => {
      calls.scripts.push(args);
      return deps.runScript(args);
    },
  };
  return { deps: wrapped, calls, notify };
}

describe("#11368 item 1: dedup do alarme por motivo + causa", () => {
  it("motivo de causa única: o id é a própria chave", () => {
    for (const k of ["late", "guided", "missing-video", "preflight-blocked"] as const) assert.equal(alarmId(k, "qualquer coisa"), k);
  });
  it("motivo que junta causas: causa diferente = id diferente; o mesmo erro com outro número = mesmo id", () => {
    const a = alarmId("publish-failed", "rupload 400: ProcessingFailedError");
    const b = alarmId("publish-failed", "GET /media 503");
    assert.notEqual(a, b);
    assert.match(a, /^publish-failed#[0-9a-f]{8}$/);
    assert.equal(alarmKeyOf(a), "publish-failed");
    assert.equal(alarmId("no-output", "publish-shorts.ts sem JSON (exit 1). Fim do stderr:\nlinha 1"), alarmId("no-output", "publish-shorts.ts sem JSON (exit 2). Fim do stderr:\noutra linha"));
    assert.equal(alarmId("crash", "o timer falhou: EBUSY em 12:03"), alarmId("crash", "o timer falhou: EBUSY em 13:07"));
  });
  it("estado com uma causa não suprime outra causa do mesmo motivo; late segue bloqueado por motivo 'não reposte'", () => {
    const a = alarmId("publish-failed", "rupload 400");
    const b = alarmId("publish-failed", "ProcessingFailedError: teto de duração");
    const state = JSON.stringify({ alarmed: [a] });
    assert.equal(alarmSuppressed(state, "publish-failed", a), true);
    assert.equal(alarmSuppressed(state, "publish-failed", b), false);
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: ["guided"] }), "late"), true);
  });
  it("de ponta a ponta: 2ª falha com causa distinta na mesma edição abre outra issue e manda e-mail; a mesma causa não repete", async () => {
    const dir = edition();
    try {
      const n = fakeNotify();
      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "rupload 400 (exit 1)", { at: AT }, n.deps), true);
      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "rupload 400 (exit 2)", { at: AT }, n.deps), true);
      assert.equal(n.issues.length, 1);
      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "ProcessingFailedError: acima do teto", { at: AT }, n.deps), true);
      assert.equal(n.issues.length, 2);
      assert.equal(n.emails.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11368 item 2: aviso do publish vira alarme acao (collab)", () => {
  const out = (r: object) => JSON.stringify({ dry_run: false, items: [], results: [{ destination: "instagram", ok: true, entry: { status: "published", id: "m1", url: "https://i/m1" }, ...r }] });
  it("publicado com warnings → alarme collab, acao, não falha; sem warnings → done", () => {
    const r = interpretInstagramTimerOutput(0, out({ warnings: ["o Instagram descartou o convite de collab da @vjpixel"] }));
    assert.deepEqual([r.kind, (r as { key: string }).key, (r as { failed: boolean }).failed], ["alarm", "collab", false]);
    assert.match(r.detail, /descartou o convite de collab/);
    assert.equal(alarmSeverity("collab"), "acao");
    assert.equal(interpretInstagramTimerOutput(0, out({})).kind, "done");
    assert.equal(interpretInstagramTimerOutput(0, out({ warnings: [] })).kind, "done");
  });
  it("já registrado (nada publicado nesta rodada) com warnings não alarma", () => {
    assert.equal(interpretInstagramTimerOutput(0, out({ alreadyRegistered: true, matchedBy: "marker", warnings: ["x"] })).kind, "done");
  });
  it("corpo do collab: no ar, não reposte, nunca --publish", () => {
    const b = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "collab", reason: "collab descartado", videoArg: "x.mp4" });
    assert.match(b.body, /NÃO reposte/);
    assert.doesNotMatch(b.body, /--publish/);
    assert.match(b.subject, /publicado com aviso/);
  });
});

describe("#11368 item 3: corte velho que sumiu do Drive", () => {
  const paths = { instagramCutPath: "/e/ig.mp4", genericPath: "/e/short.mp4" };
  const sidecar = { fileId: "abcdefghijk", modifiedTime: "2026-10-27T09:00:00.000Z" };
  it("Drive sem corte e o do disco veio do Drive (sidecar): não reaproveita — genérico do disco, ou espera", () => {
    const g = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: sidecar, genericExists: true, lookup: NONE });
    assert.equal(g.kind, "use-local");
    assert.equal((g as { source: string }).source, "generic");
    assert.match((g as { note: string }).note, /abcdefghijk.*não é reaproveitado/);
    const w = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: sidecar, genericExists: false, lookup: NONE });
    assert.equal(w.kind, "wait");
    assert.equal((w as { alarm: string }).alarm, "missing-video");
  });
  it("corte do disco sem sidecar (posto à mão) segue valendo", () => {
    assert.equal((chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: NONE }) as { source: string }).source, "instagram-cut");
  });
  it("Drive com erro: usa o corte do disco marcado como não conferido", () => {
    const c = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: sidecar, genericExists: true, lookup: { kind: "error", reason: "401" } });
    assert.equal((c as { unverified?: boolean }).unverified, true);
    assert.equal(alarmSeverity("cut-unverified"), "acao");
  });
  it("de ponta a ponta: Drive com erro, Reels publicado com o corte do disco → alarme cut-unverified (acao), exit 0", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortInstagramVideoFileName(AAMMDD)), "ig");
      const ok = JSON.stringify({ dry_run: false, items: [], results: [{ destination: "instagram", ok: true, entry: { status: "published", id: "m1", url: "https://i/m1" } }] });
      const r = runDeps({ now: at(5 * 60_000), lookupInstagramCut: () => ({ kind: "error", reason: "Drive 500" }), runScript: () => ({ status: 0, stdout: ok, stderr: "" }) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.calls.scripts.length, 1);
      assert.equal(r.notify.issues.length, 1);
      assert.match(r.notify.issues[0]!.title, /cut-unverified/);
      assert.equal(r.notify.emails.length, 0, "acao não manda e-mail sob urgent_only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11368 item 5: --now no publish do timer", () => {
  it("instagramPublishArgs passa --now (e --from-drive no download)", () => {
    const local = instagramPublishArgs(AAMMDD, { kind: "use-local", path: "/e/ig.mp4", source: "instagram-cut" });
    assert.ok(local.includes("--now"));
    assert.ok(local.includes("--instagram-timer"));
    assert.ok(!local.includes("--from-drive"));
    const dl = instagramPublishArgs(AAMMDD, { kind: "download", path: "/e/ig.mp4", fileId: "abcdefghijk", name: "n", modifiedTime: null });
    assert.deepEqual(dl.slice(-2), ["--from-drive", "abcdefghijk"]);
    assert.ok(dl.includes("--now"));
  });
});

describe("#11368 item 7: cobertura", () => {
  it("cópia de conflito do registro do timer (06-shorts-published.instagram-timer-{máquina}.json) lida do disco: nada a fazer", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, "_internal", "06-shorts-published.instagram-timer-Neo.json"), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "instagram", status: "published", id: "m", at: AT }] }));
      const raws = readShortsRegistryRaws(dir);
      assert.ok(raws.some((r) => r.path.endsWith("06-shorts-published.instagram-timer-Neo.json")));
      const d = decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: raws, aammdd: AAMMDD, now: at(5 * 60_000), videoSeen: true });
      assert.equal(d.kind, "skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("modifiedTime nulo dos dois lados com o mesmo id: usa o corte do disco (não rebaixa a cada hora)", () => {
    const c = chooseInstagramVideo({
      instagramCutPath: "/e/ig.mp4",
      genericPath: "/e/short.mp4",
      instagramCutExists: true,
      cutSidecar: { fileId: "abcdefghijk", modifiedTime: null },
      genericExists: false,
      lookup: { kind: "found", fileId: "abcdefghijk", name: "n", modifiedTime: null },
    });
    assert.deepEqual(c, { kind: "use-local", path: "/e/ig.mp4", source: "instagram-cut" });
  });
});

describe("#11368 comentário: Drive depois do teto, genérico a caminho, erro do Drive, comando manual", () => {
  it("driveVerticalCheck: o corte do Instagram já basta (sem 2ª consulta); só o genérico também; erro sem positivo = error", () => {
    let genericCalls = 0;
    const g = (l: InstagramCutLookup) => () => {
      genericCalls++;
      return l;
    };
    assert.deepEqual(driveVerticalCheck(FOUND, g(NONE)), { kind: "yes" });
    assert.equal(genericCalls, 0);
    assert.deepEqual(driveVerticalCheck(NONE, g(FOUND)), { kind: "yes" });
    assert.deepEqual(driveVerticalCheck(NONE, g(NONE)), { kind: "no" });
    assert.equal(driveVerticalCheck({ kind: "error", reason: "401" }, g(NONE)).kind, "error");
    assert.equal(driveVerticalCheck(NONE, g({ kind: "error", reason: "500" })).kind, "error");
    assert.deepEqual(driveVerticalCheck({ kind: "error", reason: "401" }, g(FOUND)), { kind: "yes" });
  });
  it("depois do teto num dia sem vertical: o Drive é consultado UMA vez por edição", async () => {
    const dir = edition();
    try {
      const late = at(MAX_FIRE_LATENESS_MS + H);
      const r1 = runDeps({ now: late });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r1.deps), 0);
      assert.deepEqual([r1.calls.instagram, r1.calls.generic], [1, 1]);
      assert.ok(existsSync(join(dir, INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE)));
      const r2 = runDeps({ now: at(MAX_FIRE_LATENESS_MS + 2 * H) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r2.deps), 0);
      assert.deepEqual([r2.calls.instagram, r2.calls.generic], [0, 0]);
      assert.equal(r1.notify.issues.length + r2.notify.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("depois do teto: só o _Instagram_ no Drive (nunca baixado) dispara o late", async () => {
    const dir = edition();
    try {
      const r = runDeps({ now: at(MAX_FIRE_LATENESS_MS + H), lookupInstagramCut: () => FOUND });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.calls.generic, 0);
      assert.equal(r.notify.issues.length, 1);
      assert.match(r.notify.issues[0]!.title, /\(late\)/);
      assert.ok(!existsSync(join(dir, INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("depois do teto com o Drive em erro: alarma late dizendo que não conferiu (nunca 'sem vertical' em silêncio) e não grava a consulta", async () => {
    const dir = edition();
    try {
      const r = runDeps({ now: at(MAX_FIRE_LATENESS_MS + H), lookupInstagramCut: () => ({ kind: "error", reason: "Drive 500" }) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.notify.issues.length, 1);
      assert.match(r.notify.issues[0]!.body, /Drive não respondeu/);
      assert.ok(!existsSync(join(dir, INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("late sem vídeo no disco nem sidecar: o corpo não oferece --publish com --video inexistente", async () => {
    const dir = edition();
    try {
      // O registro de outro destino mostra que o dia teve vertical; nenhum arquivo no disco.
      writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "facebook_profile", status: "published", id: "f", at: AT }] }));
      const r = runDeps({ now: at(MAX_FIRE_LATENESS_MS + H) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      const body = r.notify.issues[0]!.body;
      assert.doesNotMatch(body, /--publish --now --video/);
      assert.match(body, /não há vídeo do Instagram no disco do 300/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("late com só o genérico no disco: --video aponta o genérico", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "short");
      const r = runDeps({ now: at(MAX_FIRE_LATENESS_MS + H) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.match(r.notify.issues[0]!.body, new RegExp(`--video \\S*${shortVideoFileName(AAMMDD).replace(/\./g, "\\.")}`));
      assert.doesNotMatch(r.notify.issues[0]!.body, /--from-drive/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("late suprimido de ponta a ponta depois de um guided (nenhuma issue, nenhum e-mail)", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "short");
      writeFileSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE), JSON.stringify({ aammdd: AAMMDD, alarmed: ["guided"], emailPending: [] }));
      const r = runDeps({ now: at(MAX_FIRE_LATENESS_MS + H) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.notify.issues.length, 0);
      assert.equal(r.notify.emails.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sem corte e com o genérico no Drive ainda fora do disco: missing-video só depois de 2 h (o timer do LinkedIn baixa)", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "facebook_profile", status: "published", id: "f", at: AT }] }));
      const early = runDeps({ now: at(MISSING_VIDEO_ALARM_AFTER_MS + 5 * 60_000), lookupGenericVertical: () => FOUND });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, early.deps), 0);
      assert.equal(early.notify.issues.length, 0);
      const later = runDeps({ now: at(GENERIC_PENDING_ALARM_AFTER_MS + 5 * 60_000), lookupGenericVertical: () => FOUND });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, later.deps), 0);
      assert.equal(later.notify.issues.length, 1);
      assert.match(later.notify.issues[0]!.body, /ainda não chegou ao disco/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sem corte e o Drive em erro ao conferir o genérico: missing-video sai (erro não esconde o alarme)", async () => {
    const dir = edition();
    try {
      const r = runDeps({ now: at(MISSING_VIDEO_ALARM_AFTER_MS + 5 * 60_000), lookupGenericVertical: () => ({ kind: "error", reason: "Drive 500" }) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.notify.issues.length, 1);
      assert.match(r.notify.issues[0]!.title, /missing-video/);
      assert.match(r.notify.issues[0]!.body, /Drive não respondeu/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("no horário com o corte no disco igual ao do Drive: o publish recebe --now e nenhum alarme sai", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortInstagramVideoFileName(AAMMDD)), "ig");
      writeFileSync(join(dir, INSTAGRAM_CUT_SIDECAR_FILE), JSON.stringify({ fileId: "abcdefghijk", modifiedTime: "2026-10-27T09:00:00.000Z" }));
      const ok = JSON.stringify({ dry_run: false, items: [], results: [{ destination: "instagram", ok: true, entry: { status: "published", id: "m1", url: "https://i/m1" } }] });
      const r = runDeps({ now: at(5 * 60_000), lookupInstagramCut: () => FOUND, runScript: () => ({ status: 0, stdout: ok, stderr: "" }) });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, r.deps), 0);
      assert.equal(r.calls.scripts.length, 1);
      assert.ok(r.calls.scripts[0]!.includes("--now"));
      assert.equal(r.notify.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
