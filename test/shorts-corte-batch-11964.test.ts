/**
 * test/shorts-corte-batch-11964.test.ts — lote do corte avulso (review consolidado de 03/11/2026)
 *
 *   #11964: com `corte_via_timer`, a rodada manual (`--publish --confirm-publish`) e o
 *           timer do 300 publicavam o MESMO destino ao mesmo tempo (post duplicado);
 *   #11966: o timer rodava o publish-shorts sem teto, e o lock vence aos 90 min;
 *   #11965: o 2º corte do dia era bloqueado pelo vídeo já registrado do 1º;
 *   #11967: alarmes do timer sem variante de data (corte replanejado não avisava de novo);
 *   #11955: `--update-scheduled` no YouTube: a mensagem citava o escopo errado e a
 *           falha só no YouTube segurava o "pode publicar" dos outros destinos;
 *   #11944: resíduos do guard de pasta vigiada (caixa no Windows, aspas de shell, dono único).
 * Sem rede: publish-shorts, alarme e leitura de registro são injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_TIMER_CHILD_TIMEOUT_MS,
  buildCorteTimerAlarm,
  corteAlarmId,
  corteAlarmSeverity,
  corteAlarmVariant,
  corteCrashAlarmVariant,
  corteTimerTimeoutOutcomes,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import {
  corteRestoreBlockingFailures,
  nonCanonicalEditionDir,
  ownersContextAfterPublish,
  planShortsPublish,
  sameDayOtherRegisteredIdsFor,
  assignShortsDestinationOwners,
} from "../scripts/publish-shorts.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_TASK, checkCorteDir, corteBaseCommand, samePathOnPlatform, shellQuote, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { SHORTS_TIMER_LOCK_STALE_MS } from "../scripts/lib/diaria/vertical-download-guard.ts";
import { TIMER_LOCK_STALE_MS } from "../scripts/shorts-linkedin-profile-timer.ts";
import { explainYouTubeUploadError, youtubeScopeInsufficientMessage } from "../scripts/lib/diaria/youtube-upload.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SLUG = "tratar-ia-como-humano";
const AT = "2026-11-02T11:00:00.000Z"; // 08:00 BRT de 261102
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const MIN = 60_000;

const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: true,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  corte_via_timer: true,
};
const CONFIG = { publishing: { shorts } };
const base = {
  aammdd: "261102",
  reviewedMd: "",
  config: CONFIG,
  pages: [page("diaria")],
  instagramReady: true,
  published: { aammdd: "261102", entries: [] },
  video: { path: "/videos/corte.mp4", exists: true, sizeBytes: 10 },
  videoDurationSeconds: 50,
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
  youtubeApi: { ready: true } as const,
  corte: { slug: SLUG, hhmm: "08:00", title: "Tratar IA como humano", hook: "Por que dar nome ao chatbot muda o jeito que você usa." },
};
const TIMER_DESTS = ["linkedin_profile", "threads_profile", "instagram"];
const action = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d)?.action;

describe("#11964 rodada manual do corte não publica destino do timer na janela dele", () => {
  it("cenário da issue: --publish às 08:20 (12:20 da issue) — LinkedIn/Threads pessoais e Instagram ficam com o timer, nunca `publish`", () => {
    const p = planShortsPublish({ ...base, now: at(20 * MIN) });
    for (const d of TIMER_DESTS) {
      assert.equal(action(p, d), "skip_delegated", d);
      const owner = p.owners.find((o) => o.destination === d)!;
      assert.equal(owner.by, "timer-300", d);
      assert.equal(owner.task, CORTE_TIMER_TASK, d);
    }
    const item = p.items.find((i) => i.destination === "linkedin_profile")!;
    assert.match((item as { detail: string }).detail, /shorts-corte-timer\.ts --corte tratar-ia-como-humano/);
    // Os destinos que a API agenda/publica sozinha seguem saindo nesta rodada.
    assert.equal(action(p, "facebook:diaria"), "publish");
    assert.equal(action(p, "youtube_shorts"), "publish");
    // O repost da página espera o vídeo do perfil (que agora sai pelo timer).
    assert.equal(action(p, "linkedin_page_repost"), "skip_invalid");
  });

  it("--now na janela também delega (o timer pode estar publicando ao mesmo tempo)", () => {
    const p = planShortsPublish({ ...base, now: at(30 * MIN), forceNow: true });
    for (const d of TIMER_DESTS) assert.equal(action(p, d), "skip_delegated", d);
  });

  it("o filho do timer (--require-corte-authorization) é o único que publica na janela", () => {
    const p = planShortsPublish({ ...base, corte: { ...base.corte, timerRun: true }, now: at(20 * MIN), forceNow: true });
    for (const d of TIMER_DESTS) assert.equal(action(p, d), "publish", d);
  });

  it("começa 10 min antes do horário (quando a rodada já publicaria na hora); antes disso segue pending_schedule do timer", () => {
    const early = planShortsPublish({ ...base, now: at(-2 * 3_600_000) });
    for (const d of TIMER_DESTS) assert.equal(action(early, d), "pending_schedule", d);
    const near = planShortsPublish({ ...base, now: at(-5 * MIN) });
    for (const d of TIMER_DESTS) assert.equal(action(near, d), "skip_delegated", d);
  });

  it("passado o teto de 3 h o timer não publica mais: a rodada manual volta a ser dona (skip_late, e --now publica)", () => {
    const late = planShortsPublish({ ...base, now: at(MAX_FIRE_LATENESS_MS + 10 * MIN) });
    for (const d of ["linkedin_profile", "threads_profile"]) assert.equal(action(late, d), "skip_late", d);
    const now = planShortsPublish({ ...base, now: at(MAX_FIRE_LATENESS_MS + 10 * MIN), forceNow: true });
    for (const d of TIMER_DESTS) assert.equal(action(now, d), "publish", d);
  });

  it("sem corte_via_timer (ou fora de data/cortes/), nada muda: a rodada manual publica", () => {
    const off = planShortsPublish({ ...base, config: { publishing: { shorts: { ...shorts, corte_via_timer: false } } }, now: at(20 * MIN) });
    for (const d of TIMER_DESTS) assert.equal(action(off, d), "publish", d);
    const outside = planShortsPublish({ ...base, corteOutside: { dir: "/fora", warning: "fora" }, now: at(20 * MIN) });
    for (const d of TIMER_DESTS) assert.equal(action(outside, d), "publish", d);
  });

  it("o recálculo dos donos depois do publish mantém o timer do corte como dono do skip_delegated", () => {
    const p = planShortsPublish({ ...base, now: at(20 * MIN) });
    const owners = assignShortsDestinationOwners(p.items, ownersContextAfterPublish({ aammdd: "261102", now: at(20 * MIN), instagramBackend: "timer-300", corteViaTimer: true, corteSlug: SLUG }));
    for (const d of TIMER_DESTS) assert.equal(owners.find((o) => o.destination === d)?.task, CORTE_TIMER_TASK, d);
  });
});

const SPEC: CorteSpec = {
  slug: SLUG, date: "261102", hhmm: "08:00", title: "Tratar IA como humano", hook: "Gancho.", video: "corte.mp4",
  publish_confirmed_at: "2026-11-01T20:00:00.000Z",
  publish_confirmed_destinations: ["instagram", "linkedin_profile", "threads_profile"],
  publish_confirmed_content: { video_sha256: createHash("sha256").update("mp4").digest("hex"), cover_sha256: null },
};

describe("#11966 teto do filho do timer do corte", () => {
  it("o teto fica abaixo da idade de lock velho (senão outra execução publica junto com o filho travado)", () => {
    assert.equal(TIMER_LOCK_STALE_MS, SHORTS_TIMER_LOCK_STALE_MS);
    assert.ok(CORTE_TIMER_CHILD_TIMEOUT_MS < SHORTS_TIMER_LOCK_STALE_MS, `${CORTE_TIMER_CHILD_TIMEOUT_MS} < ${SHORTS_TIMER_LOCK_STALE_MS}`);
  });

  it("o spawn do filho leva timeout + SIGKILL (fonte)", () => {
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function runTsx("), src.indexOf("function runTsx(") + 700);
    assert.match(fn, /timeout: CORTE_TIMER_CHILD_TIMEOUT_MS/);
    assert.match(fn, /killSignal: "SIGKILL"/);
    assert.match(fn, /ETIMEDOUT/);
  });

  it("filho morto pelo teto vira alarme child-timeout por destino (conferir a conta), exit 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "corte-11966-"));
    const dir = join(root, SLUG);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(SPEC));
    writeFileSync(join(dir, SPEC.video), "mp4");
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    const code = await runCorteTimerFor(dir, false, {
      config: CONFIG,
      now: at(10 * MIN),
      runScript: () => ({ status: null, stdout: "", stderr: "travou no rupload", timedOut: true }),
      notify: { cwd: "/nao-usado" },
      alarm: async (_d, _s, destination, key) => {
        alarms.push({ destination, key });
        return true;
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(alarms.map((a) => a.key), ["child-timeout", "child-timeout", "child-timeout"]);
    assert.equal(corteAlarmSeverity("child-timeout"), "acao");
    const body = buildCorteTimerAlarm({ spec: SPEC, destination: "instagram", key: "child-timeout", reason: "x" }).body;
    assert.match(body, /NÃO poste de novo sem conferir/);
  });

  it("corteTimerTimeoutOutcomes cita o teto e o fim do stderr", () => {
    const [o] = corteTimerTimeoutOutcomes(["instagram"], "linha final");
    assert.equal(o.kind, "alarm");
    assert.match(o.detail, /75 min/);
    assert.match(o.detail, /linha final/);
  });
});

describe("#11967 variante de data em todo alarme do timer do corte", () => {
  const keys: CorteTimerAlarmKey[] = ["send-unknown", "published-unregistered", "account-check", "account-read-failed", "publish-failed", "credentials", "public-video", "invalid", "no-output", "crash", "child-timeout", "late", "missing-video"];
  it("cenário da issue: o mesmo motivo depois de replanejar a data muda o id (avisa de novo)", () => {
    const replanned: CorteSpec = { ...SPEC, date: "261105" };
    for (const k of keys) {
      const before = corteAlarmId("linkedin_profile", k, corteAlarmVariant(k, SPEC, null));
      const after = corteAlarmId("linkedin_profile", k, corteAlarmVariant(k, replanned, null));
      assert.notEqual(before, after, k);
      assert.equal(corteAlarmVariant(k, SPEC, null), "261102-08:00", k);
    }
  });

  it("o crash do main (sem plano conhecido) avisa uma vez por dia, não uma vez na vida do corte", () => {
    assert.equal(corteCrashAlarmVariant(new Date("2026-11-03T12:00:00Z")), "2026-11-03");
    assert.notEqual(corteCrashAlarmVariant(new Date("2026-11-03T12:00:00Z")), corteCrashAlarmVariant(new Date("2026-11-04T12:00:00Z")));
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(src, /"todos", "crash", [^\n]*corteCrashAlarmVariant\(deps\.now\)/);
  });

  it("revoked/content-changed seguem com as variantes próprias (data da queda, sha256)", () => {
    const revoked: CorteSpec = { ...SPEC, publish_revoked_at: "2026-11-02T09:00:00.000Z" };
    assert.equal(corteAlarmVariant("revoked", revoked, null), "2026-11-02T09:00:00.000Z");
    assert.equal(corteAlarmVariant("content-changed", SPEC, { video_sha256: "a".repeat(64), cover_sha256: null }), `${"a".repeat(12)}-sem-capa`);
  });
});

describe("#11965 o 2º corte do dia não é bloqueado pelo vídeo registrado do 1º", () => {
  function cortes(): string {
    const root = mkdtempSync(join(tmpdir(), "cortes-11965-"));
    for (const [slug, id] of [["corte-a", "ig-a"], ["corte-b", "ig-b"]]) {
      mkdirSync(join(root, slug), { recursive: true });
      writeFileSync(join(root, slug, CORTE_SPEC_FILE), JSON.stringify({ ...SPEC, slug, video: `${slug}.mp4` }));
      writeFileSync(join(root, slug, "registry.txt"), id);
    }
    return root;
  }
  const read = (dir: string, aammdd: string): ShortsPublishedFile => {
    const reg = join(dir, "registry.txt");
    if (!existsSync(reg)) return { aammdd, entries: [] };
    return { aammdd, entries: [{ destination: "instagram", status: "published", id: readFileSync(reg, "utf8"), at: AT }] } as ShortsPublishedFile;
  };

  it("corte B desconta o id do corte A (e o da edição), nunca o próprio", () => {
    const root = cortes();
    const edition = join(root, "edicao");
    mkdirSync(edition);
    writeFileSync(join(edition, "registry.txt"), "ig-edicao");
    const ids = sameDayOtherRegisteredIdsFor({ corteSlug: "corte-b", aammdd: "261102", destination: "instagram", editionDir: edition, cortesDir: root, warn: () => {}, read });
    assert.deepEqual(ids.sort(), ["ig-a", "ig-edicao"]);
  });

  it("na edição, segue descontando todos os cortes do dia (#11913)", () => {
    const root = cortes();
    const ids = sameDayOtherRegisteredIdsFor({ corteSlug: null, aammdd: "261102", destination: "instagram", editionDir: join(root, "nao-existe"), cortesDir: root, warn: () => {}, read });
    assert.deepEqual(ids.sort(), ["ig-a", "ig-b"]);
  });
});

describe("#11955 --update-scheduled no YouTube", () => {
  it("o 403 de escopo no videos.update nomeia o youtube.force-ssl, não o youtube.upload", () => {
    const msg = explainYouTubeUploadError(403, '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}', "update");
    assert.match(msg, /youtube\.force-ssl/);
    assert.match(msg, /videos\.update/);
    assert.doesNotMatch(msg, /sem o escopo youtube\.upload/);
    assert.match(youtubeScopeInsufficientMessage("insert"), /sem o escopo youtube\.upload/);
    assert.match(youtubeScopeInsufficientMessage("reread"), /youtube\.readonly/);
  });

  it("o PUT do updateScheduledVideo explica o erro com a etapa update (fonte)", () => {
    const src = readFileSync(new URL("../scripts/lib/diaria/youtube-upload.ts", import.meta.url), "utf8");
    assert.match(src, /if \(!put\.ok\) throw new Error\(explainYouTubeUploadError\(put\.status, await errorSnippet\(put\), "update"\)\)/);
  });

  it("falha só no YouTube não segura o 'pode publicar'; falha no Facebook segura", () => {
    assert.deepEqual(corteRestoreBlockingFailures([{ destination: "youtube_shorts", ok: false }, { destination: "facebook:diaria", ok: true }]), []);
    assert.deepEqual(corteRestoreBlockingFailures([{ destination: "youtube_shorts", ok: false }, { destination: "facebook:diaria", ok: false }]), ["facebook:diaria"]);
    assert.deepEqual(corteRestoreBlockingFailures([]), []);
  });
});

describe("#11944 resíduos do guard de pasta vigiada", () => {
  it("item 2: no Windows a comparação de caminho real ignora maiúsculas; no Linux, não", () => {
    assert.equal(samePathOnPlatform("C:\\Users\\X\\data\\cortes\\a", "c:\\users\\x\\data\\cortes\\a", "win32"), true);
    assert.equal(samePathOnPlatform("/home/X/a", "/home/x/a", "linux"), false);
    const id = (p: string) => p;
    // Caminhos POSIX para o teste rodar em qualquer SO; o que está sob teste é a comparação por plataforma.
    const win = checkCorteDir({ slug: "a", dir: "/Repo/Data/cortes/a", cortesRoot: "/repo/data/cortes", allowUnwatched: false, realpath: id, platform: "win32" });
    assert.deepEqual(win, { ok: true, outside: false });
    const linux = checkCorteDir({ slug: "a", dir: "/Repo/Data/cortes/a", cortesRoot: "/repo/data/cortes", allowUnwatched: false, realpath: id, platform: "linux" });
    assert.equal(linux.ok, false, "no Linux a caixa diferente é outra pasta");
    assert.equal(nonCanonicalEditionDir("/data/editions/2611/261102", "/DATA/editions/2611/261102", id, "win32"), undefined);
    assert.notEqual(nonCanonicalEditionDir("/data/editions/2611/261102", "/DATA/editions/2611/261102", id, "linux"), undefined);
  });

  it("item 4: caminho com $ e crase sai em aspas simples nos comandos de re-execução", () => {
    const dir = "/home/x/cortes/$HOME/`id`";
    assert.equal(shellQuote(dir), "'/home/x/cortes/$HOME/`id`'");
    assert.equal(shellQuote("it's"), `'it'"'"'s'`);
    assert.equal(corteBaseCommand("a", dir), `npx tsx scripts/publish-shorts.ts --corte a --edition-dir '/home/x/cortes/$HOME/\`id\`' --allow-unwatched-dir`);
    const owners = assignShortsDestinationOwners([{ destination: "linkedin_profile", mode: "api", action: "skip_late", detail: "x" }], ownersContextAfterPublish({ aammdd: "261102", now: at(0), instagramBackend: "timer-300", corteViaTimer: true, editionDirOverride: dir }));
    assert.ok(owners[0].command!.includes(`--edition-dir '${dir}' --allow-unwatched-dir`), owners[0].command);
  });

  it("item 1 (parte): o plano calcula os donos por ownersContextAfterPublish (fonte única)", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const plan = src.slice(src.indexOf("export function planShortsPublish("), src.indexOf("export async function uploadCoverOrFallback("));
    assert.match(plan, /const owners = assignShortsDestinationOwners\(\s*items,\s*ownersContextAfterPublish\(/);
  });
});
