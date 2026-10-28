/**
 * #11421: timer do Reels sem a credencial da página `vjpixel` — o perfil do
 * autor da rota do Chrome (onde fica o Reels postado à mão com collab
 * pendente) não é consultável. Antes, o gate seguia a conta da API e
 * publicava: Reels duplicado em conta pública. Agora é fail-closed: não
 * publica e alarma `acao` uma vez por edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  alarmSeverity,
  alarmSuppressed,
  buildInstagramTimerAlarm,
  interpretInstagramTimerOutput,
  runInstagramTimer,
  type InstagramTimerRunDeps,
} from "../scripts/shorts-instagram-timer.ts";
import {
  decideInstagramConfirm,
  decideInstagramTimerAcrossAccounts,
  instagramTimerGate,
  instagramTimerPublishStep,
  type InstagramConfirmDecision,
} from "../scripts/publish-shorts.ts";
import { buildReelsCaption, shortInstagramVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z"; // 08:00 BRT, 2º dia do teste
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros." };
const MARKERS = ["utm_campaign=261027", D1.title];
const EMPTY = { aammdd: AAMMDD, entries: [] };
const reel = (id: string, caption: string) => ({ id, caption, timestamp: "2026-10-27T11:05:00+0000", media_product_type: "REELS", permalink: `https://www.instagram.com/reel/${id}/` });
const decideFrom = (data: unknown[]) => async (): Promise<InstagramConfirmDecision> =>
  decideInstagramConfirm({ published: EMPTY, media: { data }, sinceIso: "2026-10-27T03:00:00.000Z", markers: MARKERS, nowIso: "2026-10-27T20:00:00.000Z", expectedAtIso: AT });
const caption = buildReelsCaption({ platform: "instagram", aammdd: AAMMDD, d1: D1, editionUrl: "https://diar.ia.br/p/x" });

describe("#11421: gate do timer sem a credencial da página vjpixel", () => {
  it("nada na conta da API e o perfil do @vjpixel não consultável (sem credencial) → NÃO publica, falha author-unchecked", async () => {
    let published = 0;
    await assert.rejects(
      instagramTimerPublishStep({
        gate: () =>
          instagramTimerGate({
            decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: null, chromeAuthorUnavailable: "página vjpixel sem token" }),
            persist: () => {},
          }),
        publish: async () => {
          published++;
          return "ok";
        },
      }),
      (e: { name?: string; failure?: string; message?: string }) =>
        e.name === "InstagramTimerGateError" && e.failure === "author-unchecked" && /página vjpixel sem token/.test(e.message ?? ""),
    );
    assert.equal(published, 0);
  });

  it("sem credencial, mas a conta da API já tem o Reels → registra (a conta da API decide sozinha)", async () => {
    const persisted: unknown[] = [];
    const r = await instagramTimerGate({
      decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([reel("DI1", caption)]), chromeAuthor: null, chromeAuthorUnavailable: "sem token" }),
      persist: (e) => persisted.push(e),
    });
    assert.equal(r.kind, "already");
    assert.equal(persisted.length, 1);
  });

  it("com credencial: comportamento de antes (nada nas duas contas → publica; Reels no perfil do autor → registra)", async () => {
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([]) }), persist: () => {} }), { kind: "publish" });
    const r = await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: decideFrom([reel("VJ1", caption)]) }), persist: () => {} });
    assert.equal(r.kind, "already");
  });

  it("perfil do autor = a própria conta da API (sem motivo de indisponibilidade) → segue a conta da API e publica", async () => {
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), chromeAuthor: null }), persist: () => {} }), { kind: "publish" });
  });
});

describe("#11421: o timer lê author-unchecked como alarme acao, nunca 'publique'", () => {
  const out = (o: object) => JSON.stringify({ dry_run: false, items: [], ...o });
  const result = { destination: "instagram", ok: false, cause: "preflight", preflight: "author-unchecked", error: "o perfil do @vjpixel não foi conferido (sem token)" };

  it("preflight author-unchecked → chave author-unchecked, severidade acao", () => {
    const r = interpretInstagramTimerOutput(1, out({ results: [result] }));
    assert.equal(r.kind, "alarm");
    assert.equal((r as { key: string }).key, "author-unchecked");
    assert.equal(alarmSeverity("author-unchecked"), "acao");
  });

  it("corpo: postar pelo Chrome (collab) ou fornecer a credencial; nunca --publish", () => {
    const b = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "author-unchecked", reason: "sem token", videoArg: "x.mp4", deadlineHhmm: "11:00" });
    assert.match(b.body, /Chrome/);
    assert.match(b.body, /credencial da página vjpixel/);
    assert.match(b.body, /--confirm-instagram/);
    assert.doesNotMatch(b.body, /--publish/);
  });

  it("late (que manda publicar) não sai depois de author-unchecked", () => {
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: ["author-unchecked"] }), "late"), true);
  });

  it("execuções de hora em hora com a mesma falha: nada publicado, o alarme sai UMA vez", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-ig-11421-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n");
      const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
      writeFileSync(cut, "x");
      const issues: { number: number; url: string; title: string; body: string; state: string }[] = [];
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
      let runs = 0;
      const deps = (now: Date): InstagramTimerRunDeps => ({
        config: {
          publishing: {
            shorts: {
              facebook_pages: [],
              instagram: true,
              instagram_author_page: null,
              instagram_collaborators: ["vjpixel"],
              instagram_api_max_seconds_by_account: { vjpixel: 40, diaria: 30 },
              linkedin_profile: false,
              linkedin_page_repost: false,
              x: false,
              threads_profile: false,
              schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" },
            },
          },
        },
        now,
        lookupInstagramCut: () => ({ kind: "none", reason: "nada" }),
        lookupGenericVertical: () => ({ kind: "none", reason: "nada" }),
        // O publish-shorts.ts (mock): o gate recusou por author-unchecked, nada publicado.
        runScript: () => {
          runs++;
          return { status: 1, stdout: out({ results: [result] }), stderr: "" };
        },
        notify: { ghRun, sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true },
        videoDurationSeconds: () => 25,
      });
      await runInstagramTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 10 * 60_000)));
      await runInstagramTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 70 * 60_000)));
      assert.equal(runs, 2, "cada execução confere de novo (a credencial pode ter chegado)");
      assert.equal(issues.length, 1, "o alarme sai uma vez por edição");
      assert.match(issues[0]!.title, /author-unchecked/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["author-unchecked"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
