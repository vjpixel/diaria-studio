/**
 * test/shorts-corte-instagram-alarm-11911.test.ts (#11911)
 *
 * Em 02/11/2026 o corte avulso "Você ainda trata a IA como máquina?" saiu em 6
 * de 7 canais; o Reels do Instagram nunca saiu e ninguém foi avisado. Duas
 * portas do silêncio, as duas travadas aqui:
 *
 *  1. O plano rodou com `--edition-dir` fora de `data/editions/{AAMMDD}` e
 *     delegou o Instagram (e o LinkedIn/Threads pessoais) aos timers do 300,
 *     que só procuram a pasta canônica e pularam com "dia sem edição". Agora a
 *     pasta não canônica não delega nada, e o dono vira a re-execução com o
 *     mesmo `--edition-dir`.
 *  2. Os timers da edição registravam "dia sem edição" e saíam. Agora toda
 *     execução vigia os cortes de `data/cortes/` sem dono
 *     (`corte_via_timer: false`): destino sem registro 3 h depois do horário
 *     vira alarme ao editor, uma vez por corte e destino.
 *
 * Sem rede: `gh` e e-mail falsos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonCanonicalEditionDir, planShortsPublish } from "../scripts/publish-shorts.ts";
import {
  CORTE_WATCH_HORIZON_MS,
  buildCorteWatchAlarm,
  corteWatchAlarmStateFile,
  findCortesWithoutOwner,
  readCortes,
  watchCortesWithoutOwner,
} from "../scripts/lib/diaria/corte-owner-watch.ts";
import { CORTE_SPEC_FILE, shellQuote, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { runInstagramTimer, type InstagramTimerRunDeps } from "../scripts/shorts-instagram-timer.ts";
import { runThreadsTimer, type ThreadsTimerRunDeps } from "../scripts/shorts-threads-profile-timer.ts";
import { runLinkedinTimer, type LinkedinTimerRunDeps } from "../scripts/shorts-linkedin-profile-timer.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = {
  facebook_pages: ["diaria"],
  instagram: true,
  instagram_collaborators: ["vjpixel"],
  instagram_api_max_seconds_by_account: { diaria: null },
  linkedin_profile: true,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  corte_via_timer: false,
  schedule: SCHEDULE,
};
const CFG = { publishing: { shorts: SHORTS } };
const CFG_TIMER = { publishing: { shorts: { ...SHORTS, corte_via_timer: true } } };
// O corte de 02/11/2026: 08:00 BRT = 11:00Z.
const AT = Date.parse("2026-11-02T11:00:00.000Z");
const H = 3_600_000;
const SPEC: CorteSpec = { slug: "tratar-ia-como-humano", date: "261102", hhmm: "08:00", title: "Você ainda trata a IA como máquina?", hook: "Essa é a maior dificuldade que vejo nas pessoas.", video: "corte.mp4" };

/** O registro do corte de 02/11 como ficou: tudo menos o Instagram. */
const REGISTRY_WITHOUT_IG = JSON.stringify({
  aammdd: "261102",
  entries: [
    { destination: "youtube_shorts", id: "WEAmxrYpr1E", url: "https://youtube.com/shorts/WEAmxrYpr1E", at: "2026-11-02T00:22:59.001Z", status: "scheduled", scheduled_at: "2026-11-02T11:00:00.000Z" },
    { destination: "facebook:diaria", id: "2569120290250938", at: "2026-11-02T00:24:26.623Z", status: "scheduled", scheduled_at: "2026-11-02T11:00:00.000Z" },
    { destination: "threads_profile", id: "18073866029780573", url: "https://www.threads.com/@vjpixel/post/DfPKDCxj0Eu", at: "2026-11-02T11:05:13.065Z", status: "published", scheduled_at: null },
    { destination: "linkedin_profile", id: "urn:li:ugcPost:7522976804354301952", at: "2026-11-02T11:04:00.972Z", status: "published", scheduled_at: null },
  ],
});
const IG_ENTRY = JSON.stringify({ aammdd: "261102", entries: [{ destination: "instagram", id: "17993948052069984", url: "https://www.instagram.com/reel/DfPpQ7ajJs6/", at: "2026-11-02T15:38:05.841Z", status: "published", scheduled_at: null }] });

const corteInput = (registry: string[]) => ({ dir: "/x", spec: SPEC, registryRaws: registry.map((raw, i) => ({ path: `r${i}.json`, raw })) });

function cortesRoot(registry: string | null = REGISTRY_WITHOUT_IG): { cortesDir: string; corteDir: string } {
  const cortesDir = mkdtempSync(join(tmpdir(), "cortes-11911-"));
  const corteDir = join(cortesDir, SPEC.slug);
  mkdirSync(join(corteDir, "_internal"), { recursive: true });
  writeFileSync(join(corteDir, CORTE_SPEC_FILE), JSON.stringify(SPEC, null, 2));
  if (registry !== null) writeFileSync(join(corteDir, "_internal", "06-shorts-published.json"), registry);
  return { cortesDir, corteDir };
}

/** `gh` e e-mail falsos com estado (a issue é achada pelo marcador nas execuções seguintes). */
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

/** Pasta da edição de um dia sem edição: nem `02-reviewed.md`. */
const noEditionDir = () => mkdtempSync(join(tmpdir(), "edicao-vazia-11911-"));

describe("#11911 porta 1: --edition-dir fora de data/editions não delega aos timers", () => {
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  const REVIEWED = "**DESTAQUE 1 | IA**\n\n**[Você ainda trata a IA como máquina?](https://diar.ia.br)**\n\nEssa é a maior dificuldade que vejo nas pessoas.\n\nPor que isso importa: muda o resultado.\n\n---\n";
  const base = {
    aammdd: "261102",
    reviewedMd: REVIEWED,
    config: CFG,
    pages: [page("diaria")],
    instagramReady: true,
    published: { aammdd: "261102", entries: [] },
    video: { path: "/home/x/diaria-cortes/261102/diaria-comentada-261102-short.mp4", exists: true, sizeBytes: 193_926_286 },
    videoDurationSeconds: 79.8,
    threadsPersonal: { ready: true } as const,
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    youtubeApi: { ready: true } as const,
    now: new Date(AT - 9 * H), // 23:00 BRT do dia anterior, como na rodada real
  };
  const OUT = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
  const item = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d)!;

  it("controle: na pasta canônica o Instagram, o LinkedIn e o Threads vão aos timers do 300", () => {
    const p = planShortsPublish(base);
    for (const d of ["instagram", "linkedin_profile", "threads_profile"]) assert.equal(item(p, d).action, "skip_delegated", d);
  });

  it("fora da pasta canônica: nada é delegado, o Instagram fica pendente com dono e comando com o --edition-dir", () => {
    const p = planShortsPublish({ ...base, editionDirOverride: OUT });
    for (const d of ["instagram", "linkedin_profile", "threads_profile"]) assert.notEqual(item(p, d).action, "skip_delegated", d);
    assert.equal(item(p, "instagram").action, "pending_schedule");
    const owner = p.owners.find((o) => o.destination === "instagram");
    assert.ok(owner, "o Instagram tem dono no plano");
    assert.equal(owner!.by, "agent-scheduled-task");
    assert.ok(owner!.command?.includes(`--edition-dir ${shellQuote(OUT)}`), owner!.command);
    assert.ok(owner!.command?.includes("--only instagram"), owner!.command);
    assert.ok(p.warnings.some((w) => w.includes("os timers do 300 não enxergam esta pasta") && w.includes("instagram") && w.includes("--corte SLUG")), p.warnings.join("\n"));
  });

  it("o aviso só cita o que o --only deixa no plano", () => {
    const p = planShortsPublish({ ...base, editionDirOverride: OUT, only: ["youtube_shorts"] });
    assert.ok(!p.warnings.some((w) => w.includes("não enxergam esta pasta")), p.warnings.join("\n"));
  });

  it("nonCanonicalEditionDir compara pelo caminho real (data/ é symlink pro OneDrive)", () => {
    const real = (p: string) => p.replace("/repo/data/", "/onedrive/data/");
    assert.equal(nonCanonicalEditionDir("/repo/data/editions/261102", "/repo/data/editions/261102", real), undefined);
    assert.equal(nonCanonicalEditionDir("/onedrive/data/editions/261102", "/repo/data/editions/261102", real), undefined);
    assert.equal(nonCanonicalEditionDir(OUT, "/repo/data/editions/261102", real), OUT);
  });
});

describe("#11911 porta 2: findCortesWithoutOwner (puro)", () => {
  const find = (over: { config?: unknown; destination?: string; registry?: string[]; now?: number }) =>
    findCortesWithoutOwner({ config: over.config ?? CFG, destination: over.destination ?? "instagram", cortes: [corteInput(over.registry ?? [REGISTRY_WITHOUT_IG])], now: new Date(over.now ?? AT + 4 * H) });

  it("o corte de 02/11: Instagram fora do registro 4 h depois do horário, sem timer dono → achado", () => {
    const f = find({});
    assert.equal(f.length, 1);
    assert.equal(f[0].destination, "instagram");
    assert.match(f[0].reason, /instagram não está no registro do corte/);
    assert.match(f[0].reason, /corte_via_timer = false/);
  });

  it("destino registrado em qualquer arquivo do registro (ex.: o do timer) → nada", () => {
    assert.equal(find({ registry: [REGISTRY_WITHOUT_IG, IG_ENTRY] }).length, 0);
    assert.equal(find({ destination: "threads_profile" }).length, 0);
  });

  it("com corte_via_timer o dono é o Diaria-Shorts-Cortes (que alarma o late): nada aqui", () => {
    assert.equal(find({ config: CFG_TIMER }).length, 0);
  });

  it("dentro das 3 h do horário a re-execução ainda pode sair: nada; depois do horizonte de 48 h: nada", () => {
    assert.equal(find({ now: AT + MAX_FIRE_LATENESS_MS }).length, 0);
    assert.equal(find({ now: AT - H }).length, 0);
    assert.equal(find({ now: AT + CORTE_WATCH_HORIZON_MS + H }).length, 0);
  });

  it("destino desligado no config: nada", () => {
    assert.equal(find({ config: { publishing: { shorts: { ...SHORTS, instagram: false } } } }).length, 0);
  });

  it("registro ilegível lança (nunca vira 'faltando' nem 'registrado')", () => {
    assert.throws(() => find({ registry: ["{ não é json"] }));
  });

  it("o alarme manda conferir a conta antes e traz --mark e o comando de publicar com a confirmação do corte", () => {
    const { subject, body } = buildCorteWatchAlarm(find({})[0], "Diaria-Shorts-Instagram");
    assert.match(subject, /tratar-ia-como-humano.*instagram/);
    assert.ok(body.includes("Confira a conta antes"), body);
    assert.ok(body.includes("npx tsx scripts/publish-shorts.ts --corte tratar-ia-como-humano --mark instagram=URL"), body);
    assert.ok(body.includes("--only instagram --publish --now --confirm-publish 261102"), body);
  });
});

describe("#11911 porta 2: os timers da edição alarmam no dia sem edição", () => {
  it("Instagram: dia sem edição + corte sem o Reels → alarme urgente uma vez, e a 2ª execução não repete", async () => {
    const { cortesDir, corteDir } = cortesRoot();
    const notify = fakeNotify();
    const deps: InstagramTimerRunDeps = {
      config: CFG,
      now: new Date(AT + 4 * H),
      lookupInstagramCut: () => ({ kind: "none", reason: "nada" }),
      lookupGenericVertical: () => ({ kind: "none", reason: "nada" }),
      runScript: () => {
        throw new Error("publish inesperado");
      },
      notify: notify.deps,
      cortesDir,
    };
    const dir = noEditionDir();
    assert.equal(await runInstagramTimer("261102", dir, false, deps), 0);
    assert.equal(notify.issues.length, 1, "um alarme");
    assert.match(notify.issues[0].title, /tratar-ia-como-humano.*instagram/);
    assert.equal(notify.emails.length, 1, "urgente: o e-mail sai mesmo com urgent_only");
    assert.ok(existsSync(join(corteDir, corteWatchAlarmStateFile("instagram"))));
    assert.equal(await runInstagramTimer("261102", dir, false, deps), 0);
    assert.equal(notify.emails.length, 1, "não repete a cada hora");
  });

  it("Instagram: --dry-run só relata, sem alarme", async () => {
    const { cortesDir } = cortesRoot();
    const notify = fakeNotify();
    const deps: InstagramTimerRunDeps = {
      config: CFG,
      now: new Date(AT + 4 * H),
      lookupInstagramCut: () => ({ kind: "none", reason: "nada" }),
      lookupGenericVertical: () => ({ kind: "none", reason: "nada" }),
      runScript: () => {
        throw new Error("publish inesperado");
      },
      notify: notify.deps,
      cortesDir,
    };
    assert.equal(await runInstagramTimer("261102", noEditionDir(), true, deps), 0);
    assert.equal(notify.issues.length, 0);
  });

  it("Threads e LinkedIn: vigiam o próprio destino (o registro de 02/11 tem os dois: nada a avisar)", async () => {
    const { cortesDir } = cortesRoot();
    const notify = fakeNotify();
    const threads: ThreadsTimerRunDeps = {
      config: CFG,
      now: new Date(AT + 4 * H),
      lookupVertical: () => {
        throw new Error("Drive inesperado");
      },
      runScript: () => {
        throw new Error("publish inesperado");
      },
      notify: notify.deps,
      cortesDir,
    };
    const linkedin: LinkedinTimerRunDeps = {
      config: CFG,
      now: new Date(AT + 4 * H),
      runScript: () => {
        throw new Error("publish inesperado");
      },
      notify: notify.deps,
      cortesDir,
    };
    assert.equal(await runThreadsTimer("261102", noEditionDir(), false, threads), 0);
    assert.equal(await runLinkedinTimer("261102", noEditionDir(), false, linkedin), 0);
    assert.equal(notify.issues.length, 0);
  });

  it("Threads: corte sem o threads_profile no registro → alarme do Threads, não do Instagram", async () => {
    const { cortesDir } = cortesRoot(JSON.stringify({ aammdd: "261102", entries: [] }));
    const notify = fakeNotify();
    const threads: ThreadsTimerRunDeps = {
      config: CFG,
      now: new Date(AT + 4 * H),
      lookupVertical: () => {
        throw new Error("Drive inesperado");
      },
      runScript: () => {
        throw new Error("publish inesperado");
      },
      notify: notify.deps,
      cortesDir,
    };
    assert.equal(await runThreadsTimer("261102", noEditionDir(), false, threads), 0);
    assert.equal(notify.issues.length, 1);
    assert.match(notify.issues[0].title, /threads_profile/);
  });

  it("alarme que não sai (gh fora) deixa o exit em 1 e não grava estado (tenta de novo)", async () => {
    const { cortesDir, corteDir } = cortesRoot();
    const notify = fakeNotify();
    const broken = {
      ...notify.deps,
      ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh: rede fora" }),
    };
    const ok = await watchCortesWithoutOwner("instagram", false, { config: CFG, now: new Date(AT + 4 * H), cortesDir, notify: broken, checkTask: "t", log: () => {} });
    assert.equal(ok, false);
    assert.equal(existsSync(join(corteDir, corteWatchAlarmStateFile("instagram"))), false);
  });

  it("readCortes ignora pasta sem corte.json e cortesDir ausente", () => {
    const { cortesDir } = cortesRoot();
    mkdirSync(join(cortesDir, "rascunho"));
    assert.equal(readCortes(cortesDir).length, 1);
    assert.deepEqual(readCortes(join(cortesDir, "nao-existe")), []);
  });
});
