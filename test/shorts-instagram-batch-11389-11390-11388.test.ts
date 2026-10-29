/**
 * test/shorts-instagram-batch-11389-11390-11388.test.ts
 *
 * Lote do Reels do Instagram de 27/10/2026:
 *  - #11389/#11381: vertical acima do teto da API na conta (50 s > 30 s da
 *    @diar.ia.br) é limite conhecido. O timer do 300 manda um lembrete único
 *    (`guided`) e nunca o alarme `late` por isso — antes do horário quando o
 *    corte já está no disco, e no lugar do `late` depois do teto de 3 h.
 *  - #11390: a rota à mão é @vjpixel autor com a @diar.ia.br colaboradora; o
 *    `--confirm-instagram` procura também no perfil do autor (o post do collab
 *    pendente não aparece na @diar.ia.br) e aceita `--url`.
 *  - #11388: legenda do Reels com o texto final do editor, sem o YouTube.
 * Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  buildInstagramTimerAlarm,
  instagramOverApiCap,
  runInstagramTimer,
  type InstagramTimerRunDeps,
} from "../scripts/shorts-instagram-timer.ts";
import {
  INSTAGRAM_CAPTION_FORMAT_MARKER,
  INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER,
  decideInstagramConfirm,
  decideInstagramConfirmAcrossAccounts,
  decideInstagramTimerAcrossAccounts,
  instagramTimerGate,
  instagramTimerPublishStep,
  instagramConfirmUrlEntry,
  type InstagramConfirmDecision,
} from "../scripts/publish-shorts.ts";
import {
  INSTAGRAM_CHROME_ROUTE,
  INSTAGRAM_REELS_CTA,
  buildReelsCaption,
  instagramChromeRouteText,
  shortInstagramVideoFileName,
  shortVideoFileName,
} from "../scripts/lib/diaria/short-video.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
// O teto da produção (#11281): @diar.ia.br 30 s, @vjpixel 40 s.
const SHORTS = {
  facebook_pages: [],
  instagram: true,
  instagram_author_page: null,
  instagram_collaborators: ["vjpixel"],
  instagram_api_max_seconds_by_account: { vjpixel: 40, diaria: 30 },
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: false,
  threads_profile: false,
  schedule: SCHEDULE,
};
const CFG = { publishing: { shorts: SHORTS } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const H = 60 * 60_000;

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "shorts-ig-11389-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n");
  return dir;
}

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

function runDeps(now: Date, durations: Record<string, number | null>, notify = fakeNotify()) {
  const scripts: string[][] = [];
  const reads: string[] = [];
  const deps: InstagramTimerRunDeps = {
    config: CFG,
    now,
    lookupInstagramCut: () => ({ kind: "none", reason: "nada" }),
    lookupGenericVertical: () => ({ kind: "none", reason: "nada" }),
    runScript: (args) => {
      scripts.push(args);
      throw new Error("publish inesperado");
    },
    notify: notify.deps,
    videoDurationSeconds: (p) => {
      reads.push(p);
      return durations[p] ?? null;
    },
  };
  return { deps, scripts, reads, notify };
}

const alarmState = (dir: string) => JSON.parse(readFileSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE), "utf8"));

describe("#11389: teto conhecido da API vira lembrete único, nunca late", () => {
  it("instagramOverApiCap usa o teto da conta autora (diar.ia.br 30 s): 50 s passa, 29 s cabe, duração ilegível cabe", () => {
    const over = instagramOverApiCap(CFG, 50);
    assert.equal(over.over, true);
    assert.match((over as { reason: string }).reason, /50\.0 s.*~30 s/);
    assert.deepEqual(instagramOverApiCap(CFG, 29), { over: false });
    assert.deepEqual(instagramOverApiCap(CFG, null), { over: false });
  });

  it("cenário de 261027: 11 h depois do horário com o corte de 50 s no disco — lembrete guided, nenhum alarme late", async () => {
    const dir = edition();
    try {
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const { deps, scripts, notify } = runDeps(at(11 * H), { [cut]: 50 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps), 0);
      assert.equal(scripts.length, 0, "não tenta publicar");
      assert.equal(notify.issues.length, 1);
      assert.match(notify.issues[0].title, /postar pelo Chrome/);
      assert.doesNotMatch(notify.issues[0].title, /\(late\)/);
      assert.deepEqual(alarmState(dir).alarmed, ["guided"]);
      // A execução seguinte (de hora em hora) não repete nem vira late.
      const again = runDeps(at(12 * H), { [cut]: 50 }, notify);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, again.deps), 0);
      assert.equal(notify.issues.length, 1);
      assert.equal(notify.emails.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depois do teto só com o vertical genérico acima do teto no disco: lembrete, sem late", async () => {
    const dir = edition();
    try {
      const generic = join(dir, shortVideoFileName(AAMMDD));
      writeFileSync(generic, "x");
      const { deps, notify } = runDeps(at(MAX_FIRE_LATENESS_MS + H), { [generic]: 49.9 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps), 0);
      assert.deepEqual(alarmState(dir).alarmed, ["guided"]);
      assert.ok(notify.issues.every((i) => !/\(late\)/.test(i.title)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depois do teto com vídeo que cabe: o late de sempre continua (não é limite conhecido)", async () => {
    const dir = edition();
    try {
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const { deps, notify } = runDeps(at(MAX_FIRE_LATENESS_MS + H), { [cut]: 25 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps), 0);
      assert.deepEqual(alarmState(dir).alarmed, ["late"]);
      assert.match(notify.issues[0].title, /\(late\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lembrete ANTECIPADO: antes do horário, com o corte acima do teto no disco, avisa uma vez e não relê o vídeo depois", async () => {
    const dir = edition();
    try {
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const first = runDeps(at(-3 * H), { [cut]: 50 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, first.deps), 0);
      assert.equal(first.scripts.length, 0);
      assert.equal(first.notify.issues.length, 1);
      assert.match(first.notify.issues[0].body, /às 08:00 BRT/);
      assert.match(first.notify.issues[0].body, /como @vjpixel \(autor\), com a @diar\.ia\.br como colaboradora/);
      const second = runDeps(at(-2 * H), { [cut]: 50 }, first.notify);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, second.deps), 0);
      assert.equal(second.reads.length, 0, "lembrete já entregue: não lê o vídeo de novo");
      assert.equal(first.notify.issues.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("antes do horário só o genérico no disco (o corte pode ainda chegar e caber): nada de lembrete", async () => {
    const dir = edition();
    try {
      const generic = join(dir, shortVideoFileName(AAMMDD));
      writeFileSync(generic, "x");
      const { deps, notify } = runDeps(at(-H), { [generic]: 50 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps), 0);
      assert.equal(notify.issues.length, 0);
      assert.equal(existsSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run antes do horário não abre lembrete", async () => {
    const dir = edition();
    try {
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const { deps, notify } = runDeps(at(-H), { [cut]: 50 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, true, deps), 0);
      assert.equal(notify.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corpo do lembrete: diz que não é falha, a rota do Chrome, o registro, e não oferece o comando da API", () => {
    const { subject, body } = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "guided", reason: "50 s > 30 s", videoArg: "data/x.mp4", verticalHhmm: "08:00" });
    assert.match(subject, /postar pelo Chrome às 08:00/);
    assert.match(body, /não é falha/);
    assert.match(body, /Passo B3b/);
    assert.ok(body.includes(instagramChromeRouteText()));
    assert.match(body, /--confirm-instagram/);
    assert.match(body, /uma vez por edição/);
    assert.doesNotMatch(body, /--publish/);
    assert.doesNotMatch(body, /como a autora/);
  });
});

const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros." };
const MARKERS = ["utm_campaign=261027", D1.title];
const EMPTY = { aammdd: AAMMDD, entries: [] };
const reel = (id: string, caption: string, timestamp = "2026-10-27T11:05:00+0000") => ({ id, caption, timestamp, media_product_type: "REELS", permalink: `https://www.instagram.com/reel/${id}/` });
const decideFrom = (data: unknown[]) => async (): Promise<InstagramConfirmDecision> =>
  decideInstagramConfirm({ published: EMPTY, media: { data }, sinceIso: "2026-10-27T03:00:00.000Z", markers: MARKERS, nowIso: "2026-10-27T20:00:00.000Z", expectedAtIso: AT });

describe("#11390: --confirm-instagram acha o Reels do collab pendente no perfil do autor", () => {
  const caption = buildReelsCaption({ platform: "instagram", d1: D1 });

  it("rota do Chrome: @vjpixel autor, @diar.ia.br colaboradora (o inverso da rota da API)", () => {
    assert.equal(INSTAGRAM_CHROME_ROUTE.authorUsername, "vjpixel");
    assert.equal(INSTAGRAM_CHROME_ROUTE.collaboratorUsername, "diar.ia.br");
    assert.equal(instagramChromeRouteText(), "como @vjpixel (autor), com a @diar.ia.br como colaboradora");
  });

  it("cenário de 261027: nada na conta da diar.ia.br, o Reels no perfil do @vjpixel → registra pelo perfil do autor", async () => {
    const r = await decideInstagramConfirmAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([reel("R1", caption)]) });
    assert.equal(r.account, "chrome-author");
    assert.equal(r.decision.kind, "register");
    assert.equal((r.decision as { entry: { url?: string } }).entry.url, "https://www.instagram.com/reel/R1/");
  });

  it("a conta da API resolve: o perfil do autor nem é lido", async () => {
    let read = false;
    const r = await decideInstagramConfirmAcrossAccounts({
      primary: decideFrom([reel("API1", caption)]),
      chromeAuthor: async () => {
        read = true;
        return decideFrom([])();
      },
    });
    assert.equal(r.account, "primary");
    assert.equal(r.decision.kind, "register");
    assert.equal(read, false);
  });

  it("ambíguo na conta da API não cai no perfil do autor (o editor escolhe o --media-id)", async () => {
    const r = await decideInstagramConfirmAcrossAccounts({
      primary: decideFrom([reel("A", caption), reel("B", caption, "2026-10-27T11:20:00+0000")]),
      chromeAuthor: decideFrom([reel("R1", caption)]),
    });
    assert.equal(r.account, "primary");
    assert.equal(r.decision.kind === "refuse" && r.decision.cause, "ambiguous");
  });

  it("perfil do autor sem credencial ou com leitura falha: devolve a recusa da conta da API com o motivo, nunca lança", async () => {
    const noCred = await decideInstagramConfirmAcrossAccounts({ primary: decideFrom([]), chromeAuthor: null, chromeAuthorUnavailable: "página vjpixel sem credencial" });
    assert.equal(noCred.decision.kind, "refuse");
    assert.match(noCred.fallbackNote ?? "", /sem credencial/);
    const failed = await decideInstagramConfirmAcrossAccounts({
      primary: decideFrom([]),
      chromeAuthor: async () => {
        throw new Error("GET /media 500");
      },
    });
    assert.equal(failed.decision.kind, "refuse");
    assert.match(failed.fallbackNote ?? "", /GET \/media 500/);
  });

  it("--url aceita o permalink do Reel (com ou sem usuário e query) e recusa o resto", () => {
    const ok = instagramConfirmUrlEntry("https://www.instagram.com/vjpixel/reel/DQabc_12-x/?igsh=xyz", "2026-10-27T20:00:00.000Z");
    assert.equal(ok.ok, true);
    const e = (ok as { entry: { destination: string; status: string; url?: string; id: string } }).entry;
    assert.equal(e.destination, "instagram");
    assert.equal(e.status, "published");
    assert.equal(e.url, "https://www.instagram.com/vjpixel/reel/DQabc_12-x/");
    assert.equal(instagramConfirmUrlEntry("https://instagram.com/p/ABC/", "2026-10-27T20:00:00.000Z").ok, true);
    for (const bad of ["https://www.instagram.com/vjpixel/", "http://www.instagram.com/reel/ABC/", "https://youtube.com/shorts/x", "reel/ABC"]) {
      assert.equal(instagramConfirmUrlEntry(bad, "2026-10-27T20:00:00.000Z").ok, false, bad);
    }
  });
});

describe("#11388: legenda do Reels com o texto final do editor", () => {
  it("Instagram: o CTA é a frase decidida, sem YouTube e sem 'Edição completa'", () => {
    const c = buildReelsCaption({ platform: "instagram", d1: D1 });
    assert.ok(c.includes("A diar.ia.br é a newsletter que resume as notícias de IA do dia em 5 minutos. Assine pelo link da bio."));
    assert.ok(c.includes(INSTAGRAM_REELS_CTA));
    assert.doesNotMatch(c, /youtube/i);
    assert.doesNotMatch(c, /Edição completa/);
  });

  it("o marcador de formato do --confirm-instagram acompanha a legenda nova e ainda reconhece a antiga", () => {
    const c = buildReelsCaption({ platform: "instagram", d1: D1 });
    assert.ok(c.includes(INSTAGRAM_CAPTION_FORMAT_MARKER));
    assert.equal(INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER, "youtube.com/@diariabr");
    // Legenda nova com título e gancho editados no Chrome: só a janela de horário + o formato.
    const edited = c.replace(D1.title, "Outro título").replace(D1.body, "Outro gancho.");
    const d = decideInstagramConfirm({ published: EMPTY, media: { data: [reel("N", edited)] }, sinceIso: "2026-10-27T03:00:00.000Z", markers: MARKERS, nowIso: "2026-10-27T20:00:00.000Z", expectedAtIso: AT });
    assert.equal(d.kind, "register");
    assert.equal(d.kind === "register" && d.matchedBy, "time-window");
  });
});

describe("fix do review do PR #11395: nenhum Reels duplicado pela API", () => {
  const caption = buildReelsCaption({ platform: "instagram", d1: D1 });

  it("P2 (1): gate do timer — nada na @diar.ia.br, o Reels à mão no perfil do @vjpixel (collab pendente) → registra e NÃO publica", async () => {
    const persisted: unknown[] = [];
    let published = 0;
    const step = await instagramTimerPublishStep({
      gate: () =>
        instagramTimerGate({
          decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([reel("VJ1", caption)]) }),
          persist: (e) => persisted.push(e),
        }),
      publish: async () => {
        published++;
        return "ok";
      },
    });
    assert.equal(step.kind, "already");
    assert.equal(published, 0);
    assert.equal(persisted.length, 1);
  });

  it("P2 (1): perfil do autor com Reels perto do horário sem marcador (só janela) → o gate bloqueia, não publica", async () => {
    const other = reel("VJ2", "Outro título\n\nOutro gancho.\n\n" + INSTAGRAM_CAPTION_FORMAT_MARKER);
    await assert.rejects(
      instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([other]) }), persist: () => {} }),
      /janela de horário/,
    );
  });

  it("P2 (1): leitura do perfil do autor que falha → fail-closed (read-failed), nunca publica", async () => {
    await assert.rejects(
      instagramTimerGate({
        decide: () =>
          decideInstagramTimerAcrossAccounts({
            primary: decideFrom([]),
            chromeAuthor: async () => {
              throw new Error("GET /media 500");
            },
          }),
        persist: () => {},
      }),
      (e: { failure?: string }) => e.failure === "read-failed",
    );
  });

  it("P2 (1): nada em nenhuma das contas → publica; perfil não consultável → segue a conta da API", async () => {
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([]) }), persist: () => {} }), { kind: "publish" });
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: null }), persist: () => {} }), { kind: "publish" });
  });

  it("P2 (2): lembrete antecipado entregue e o corte trocado por um que cabe → no horário o timer NÃO publica pela API", async () => {
    const dir = edition();
    try {
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const early = runDeps(at(-3 * H), { [cut]: 50 });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, early.deps), 0);
      assert.deepEqual(alarmState(dir).alarmed, ["guided"]);
      // O editor troca o corte por um de 25 s (cabe no teto); no horário o timer roda.
      const onTime = runDeps(at(10 * 60_000), { [cut]: 25 }, early.notify);
      onTime.deps.lookupInstagramCut = () => ({ kind: "none", reason: "nada" });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, onTime.deps), 0);
      assert.equal(onTime.scripts.length, 0, "não chama o publish-shorts depois do lembrete guided");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
