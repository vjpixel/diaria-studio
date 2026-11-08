/**
 * test/linkedin-page-actions-11121-10983.test.ts
 *
 * Lado do script do repost da página (#11121) e do 1º comentário do D1 como
 * página (#10983), os dois pela fila do Worker `diaria-linkedin-cron`:
 *   - payloads (`scripts/lib/diaria/linkedin-page-actions.ts`);
 *   - tradução das respostas do Worker — em especial `linkedin_creds_missing`
 *     (Worker sem os segredos da página, #8816), que preserva o caminho
 *     guiado/manual com aviso;
 *   - `publish-shorts.ts` (`enqueuePageRepostViaWorker`) e a task
 *     `video-d1-link-watch` (`linkedinQueue`).
 * Regressão: antes, o repost era sempre guiado e o comentário do LinkedIn
 * sempre `manual`, mesmo com o token da página existindo.
 * Nenhuma rede real: o enqueue é injetado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LINKEDIN_D1_COMMENT_DELAY_MS,
  buildD1VideoCommentPayload,
  buildPageRepostPayload,
  d1LinkedInTextHint,
  d1VideoCommentIdempotencyKey,
  enqueuePageAction,
  linkedInPostUrnFrom,
  shortsPageRepostIdempotencyKey,
  type EnqueueFn,
} from "../scripts/lib/diaria/linkedin-page-actions.ts";
import { WorkerQueueError, type WorkerQueuePayload } from "../scripts/lib/worker-queue-client.ts";
import { enqueuePageRepostViaWorker, type ShortsPlanItem } from "../scripts/publish-shorts.ts";
import { VIDEO_LINK_APPLY_FILE, deadlineForEdition, runVideoD1LinkWatch, type VideoD1WatchDeps } from "../scripts/lib/diaria/video-d1-link-watch.ts";

const VIDEO_URL = "https://youtu.be/abcdefghijk";
const NOW = new Date("2026-11-09T10:00:00.000Z");

function recordingEnqueue(impl?: (p: WorkerQueuePayload) => Promise<{ key: string; scheduled_at: string; duplicate?: boolean }>) {
  const calls: WorkerQueuePayload[] = [];
  const fn: EnqueueFn = async (p) => {
    calls.push(p);
    return impl ? impl(p) : { key: `queue:${p.scheduled_at}:k`, scheduled_at: p.scheduled_at };
  };
  return { fn, calls };
}
const credsMissing = () =>
  Promise.reject(new WorkerQueueError(400, JSON.stringify({ error: "requer LINKEDIN_ACCESS_TOKEN", code: "linkedin_creds_missing" }), "linkedin_creds_missing"));

describe("linkedin-page-actions — payloads", () => {
  it("linkedInPostUrnFrom: id de post, URL feed/update, e nada além disso", () => {
    assert.equal(linkedInPostUrnFrom({ id: "urn:li:share:123" }), "urn:li:share:123");
    assert.equal(linkedInPostUrnFrom({ id: "x", url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:77/" }), "urn:li:ugcPost:77");
    assert.equal(linkedInPostUrnFrom({ id: "send_unknown-2026" }), null);
    assert.equal(linkedInPostUrnFrom({ url: "https://www.linkedin.com/feed/update/urn:li:activity:9/" }), null);
    assert.equal(linkedInPostUrnFrom(null), null);
  });

  it("comentário do D1: D1 + 5 min, alvo pela hora do D1, chave por edição e vídeo", () => {
    const p = buildD1VideoCommentPayload({ aammdd: "261109", videoUrl: VIDEO_URL, text: "Assista no YouTube: x", d1ScheduledAt: "2026-11-09T17:00:00-03:00", now: NOW });
    assert.equal(p.action, "comment");
    assert.equal(p.webhook_target, "diaria");
    assert.equal(p.channel, "linkedin");
    assert.equal(p.parent_destaque, "d1");
    assert.equal(p.parent_scheduled_at, "2026-11-09T20:00:00.000Z");
    assert.equal(p.scheduled_at, new Date(Date.parse("2026-11-09T20:00:00.000Z") + LINKEDIN_D1_COMMENT_DELAY_MS).toISOString());
    assert.equal(p.idempotency_key, d1VideoCommentIdempotencyKey("261109", VIDEO_URL));
    assert.equal(p.idempotency_key, "d1-video-comment-261109-abcdefghijk");
    assert.equal(p.target_post_urn, undefined);
  });

  it("regressão PR #12407: comentário do D1 leva a abertura do D1 (parent_text_hint) quando ela existe", () => {
    const base = { aammdd: "261109", videoUrl: VIDEO_URL, text: "t", d1ScheduledAt: "2026-11-09T17:00:00-03:00", now: NOW };
    assert.equal(buildD1VideoCommentPayload({ ...base, d1TextHint: "O Brasil ganhou uma lei de IA" }).parent_text_hint, "O Brasil ganhou uma lei de IA");
    assert.equal("parent_text_hint" in buildD1VideoCommentPayload(base), false);
    assert.equal("parent_text_hint" in buildD1VideoCommentPayload({ ...base, d1TextHint: null }), false);
  });

  it("d1LinkedInTextHint: 1ª linha do ## d1 de # Social, sem markdown/URL, cortada em palavra; curto demais = null", () => {
    const md = (d1: string) => `# Social\n\n## d1\n\n${d1}\n\n## d2\n\nOutro destaque qualquer com texto.\n`;
    assert.equal(
      d1LinkedInTextHint(md("O **Brasil** ganhou uma [lei de IA](https://x.test/a) hoje https://y.test\n\nPor que isso importa: ...")),
      "O Brasil ganhou uma lei de IA hoje",
    );
    const long = d1LinkedInTextHint(md(`${"palavra ".repeat(40)}fim`));
    assert.ok(long && long.length <= 120 && !long.endsWith(" "), String(long));
    assert.equal(d1LinkedInTextHint(md("Curto.")), null);
    assert.equal(d1LinkedInTextHint("# Outra\n\n## d1\n\nTexto longo o bastante para casar algo.\n"), null);
  });

  it("comentário do D1 que já saiu: agendado para daqui a 1 min, nunca no passado", () => {
    const p = buildD1VideoCommentPayload({ aammdd: "261109", videoUrl: VIDEO_URL, text: "t", d1ScheduledAt: "2026-11-09T06:00:00-03:00", now: NOW });
    assert.equal(p.scheduled_at, new Date(NOW.getTime() + 60_000).toISOString());
  });

  it("repost: texto vazio, alvo = post do perfil, horário da grade; chave por edição (e por corte)", () => {
    const p = buildPageRepostPayload({ aammdd: "261109", targetPostUrn: "urn:li:share:9", scheduledAt: "2026-11-09T18:00:00.000Z", now: NOW });
    assert.deepEqual(
      { text: p.text, action: p.action, channel: p.channel, target: p.target_post_urn, at: p.scheduled_at, destaque: p.destaque, key: p.idempotency_key },
      { text: "", action: "repost", channel: "linkedin", target: "urn:li:share:9", at: "2026-11-09T18:00:00.000Z", destaque: "shorts", key: "shorts-page-repost-261109" },
    );
    assert.equal(shortsPageRepostIdempotencyKey("261109", "meu corte/1"), "shorts-page-repost-261109-meu-corte-1");
    assert.throws(() => buildPageRepostPayload({ aammdd: "261109", targetPostUrn: "urn:li:activity:1", scheduledAt: "2026-11-09T18:00:00Z", now: NOW }));
  });
});

describe("linkedin-page-actions — enqueuePageAction", () => {
  const payload = buildPageRepostPayload({ aammdd: "261109", targetPostUrn: "urn:li:share:9", scheduledAt: "2026-11-09T18:00:00Z", now: NOW });

  it("na fila → queued (com duplicate quando o Worker reaproveitou a entry)", async () => {
    const r = await enqueuePageAction(async () => ({ key: "queue:a:b", scheduled_at: "x", duplicate: true }), payload);
    assert.deepEqual(r, { status: "queued", key: "queue:a:b", scheduled_at: "x", duplicate: true });
  });

  it("Worker sem os segredos da página → creds_missing citando o #8816", async () => {
    const r = await enqueuePageAction(credsMissing, payload);
    assert.equal(r.status, "creds_missing");
    assert.match((r as { detail: string }).detail, /#8816/);
  });

  it("409 already_fired → already_fired; 5xx e rede → failed ambíguo; 4xx → failed não ambíguo", async () => {
    const fired = await enqueuePageAction(() => Promise.reject(new WorkerQueueError(409, JSON.stringify({ error: "already_fired" }))), payload);
    assert.equal(fired.status, "already_fired");
    const five = await enqueuePageAction(() => Promise.reject(new WorkerQueueError(502, "bad gateway")), payload);
    assert.deepEqual([five.status, (five as { ambiguous: boolean }).ambiguous], ["failed", true]);
    const net = await enqueuePageAction(() => Promise.reject(new Error("fetch failed")), payload);
    assert.deepEqual([net.status, (net as { ambiguous: boolean }).ambiguous], ["failed", true]);
    const four = await enqueuePageAction(() => Promise.reject(new WorkerQueueError(400, "bad")), payload);
    assert.deepEqual([four.status, (four as { ambiguous: boolean }).ambiguous], ["failed", false]);
  });

  it("sem Worker nesta máquina → no_worker", async () => {
    assert.equal((await enqueuePageAction(null, payload)).status, "no_worker");
  });
});

describe("#11121 — publish-shorts: enqueuePageRepostViaWorker", () => {
  const guided: ShortsPlanItem = { destination: "linkedin_page_repost", mode: "guided", action: "guided", detail: "repost no Chrome", at: "2026-11-09T18:00:00.000Z" };
  const other: ShortsPlanItem = { destination: "x", mode: "guided", action: "guided", detail: "buffer" };
  const profile = { destination: "linkedin_profile", status: "published", id: "urn:li:share:7390", url: "https://www.linkedin.com/feed/update/urn:li:share:7390/" };

  it("com o Worker aceitando: repost na fila no horário do passo, registro scheduled e item skip_done", async () => {
    const { fn, calls } = recordingEnqueue();
    const out = await enqueuePageRepostViaWorker(fn, { aammdd: "261109", items: [other, guided], profileEntry: profile, now: NOW });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "repost");
    assert.equal(calls[0].target_post_urn, "urn:li:share:7390");
    assert.equal(calls[0].scheduled_at, "2026-11-09T18:00:00.000Z");
    assert.equal(out.entry?.destination, "linkedin_page_repost");
    assert.equal(out.entry?.status, "scheduled");
    assert.equal(out.entry?.id, "queue:2026-11-09T18:00:00.000Z:k");
    assert.deepEqual(out.items[1], { destination: "linkedin_page_repost", mode: "api", action: "skip_done" });
    assert.deepEqual(out.items[0], other, "outros destinos não mudam");
    assert.equal(out.warning, undefined);
  });

  it("Worker sem o token da página (#8816): passo guiado preservado, com aviso e sem registro", async () => {
    const out = await enqueuePageRepostViaWorker(credsMissing, { aammdd: "261109", items: [guided], profileEntry: profile, now: NOW });
    assert.equal(out.entry, undefined);
    const item = out.items[0] as Extract<ShortsPlanItem, { action: "guided" }>;
    assert.equal(item.action, "guided");
    assert.equal(item.at, guided.at);
    assert.match(item.detail, /^repost no Chrome \(fila do Worker: .*#8816/);
    assert.match(out.warning ?? "", /linkedin_page_repost: segue guiado/);
  });

  it("vídeo do perfil sem URN (send_unknown, --mark com URL estranha): guiado, sem chamar o Worker", async () => {
    const { fn, calls } = recordingEnqueue();
    const out = await enqueuePageRepostViaWorker(fn, { aammdd: "261109", items: [guided], profileEntry: { id: "send_unknown-x" }, now: NOW });
    assert.equal(calls.length, 0);
    assert.equal(out.items[0].action, "guided");
    assert.match(out.warning ?? "", /URN do vídeo do perfil/);
  });

  it("sem item guiado do repost: nada muda, nada chamado", async () => {
    const { fn, calls } = recordingEnqueue();
    const items: ShortsPlanItem[] = [{ destination: "linkedin_page_repost", mode: "guided", action: "skip_done" }];
    const out = await enqueuePageRepostViaWorker(fn, { aammdd: "261109", items, profileEntry: profile, now: NOW });
    assert.equal(calls.length, 0);
    assert.equal(out.items, items);
  });

  it("corte avulso: chave de idempotência própria (não colide com o repost da edição)", async () => {
    const { fn, calls } = recordingEnqueue();
    await enqueuePageRepostViaWorker(fn, { aammdd: "261109", items: [guided], profileEntry: profile, now: NOW, corteSlug: "corte-a" });
    assert.equal(calls[0].idempotency_key, "shorts-page-repost-261109-corte-a");
  });
});

describe("#10983 — video-d1-link-watch: comentário do D1 pela fila do Worker", () => {
  function edition(): string {
    const dir = mkdtempSync(join(tmpdir(), "li-page-comment-10983-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ videoId: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk", state: "draft" }));
    writeFileSync(
      join(dir, "_internal", "06-social-published.json"),
      JSON.stringify({ posts: [{ platform: "linkedin", destaque: "d1", subtype: "main", status: "scheduled", scheduled_at: "2026-10-23T20:00:00.000Z", url: null }] }),
    );
    return dir;
  }
  const fetch: VideoD1WatchDeps["fetch"] = async (url) => {
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (url.includes("/youtube/v3/videos")) return json({ items: [{ id: "abcdefghijk", status: { uploadStatus: "processed", privacyStatus: "public" } }] });
    throw new Error(`url inesperada: ${url}`);
  };
  const deps = (): VideoD1WatchDeps => ({ fetch, now: () => new Date("2026-10-23T09:05:00.000Z"), sleep: async () => {}, log: () => {} });
  const input = (dir: string, linkedinQueue: EnqueueFn | null | undefined) => ({
    aammdd: "261023",
    editionDir: dir,
    deadline: deadlineForEdition("261023") as Date,
    youtubeCreds: { clientId: "c", clientSecret: "s", refreshToken: "r", channelId: "UC" },
    facebook: null,
    ...(linkedinQueue !== undefined ? { linkedinQueue } : {}),
  });

  it("com a fila do Worker: enfileira o comentário como página e marca o LinkedIn applied (rodar de novo não repete)", async () => {
    const dir = edition();
    const { fn, calls } = recordingEnqueue();
    const out = await runVideoD1LinkWatch(deps(), input(dir, fn));
    assert.equal(out.status, "aplicado");
    if (out.status !== "aplicado") return;
    const li = out.results.find((r) => r.destination === "linkedin");
    assert.equal(li?.status, "applied");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "comment");
    assert.equal(calls[0].parent_scheduled_at, "2026-10-23T20:00:00.000Z");
    assert.equal(calls[0].parent_text_hint, undefined, "edição sem 03-social.md: só a janela de hora");
    assert.match(calls[0].text, /Assista no YouTube: https:\/\/youtu\.be\/abcdefghijk/);
    assert.equal(JSON.parse(readFileSync(join(dir, VIDEO_LINK_APPLY_FILE), "utf8")).destinations.linkedin.status, "applied");

    const again = await runVideoD1LinkWatch(deps(), input(dir, fn));
    assert.equal(again.status, "aplicado");
    assert.equal(calls.length, 1, "destino applied não é re-enfileirado");
  });

  it("regressão PR #12407: com 03-social.md, o enqueue leva a abertura do D1 para o Worker conferir o post", async () => {
    const dir = edition();
    writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nA Anthropic lançou um modelo novo nesta terça.\n\nPor que isso importa: ...\n", "utf8");
    const { fn, calls } = recordingEnqueue();
    const out = await runVideoD1LinkWatch(deps(), input(dir, fn));
    assert.equal(out.status, "aplicado");
    assert.equal(calls[0].parent_text_hint, "A Anthropic lançou um modelo novo nesta terça.");
  });

  it("Worker sem os segredos da página: LinkedIn segue manual com o motivo", async () => {
    const out = await runVideoD1LinkWatch(deps(), input(edition(), credsMissing));
    if (out.status !== "aplicado") return assert.fail(out.status);
    const li = out.results.find((r) => r.destination === "linkedin");
    assert.equal(li?.status, "manual");
    assert.match(li?.detail ?? "", /#8816/);
  });

  it("sem fila (null/ausente): comportamento anterior, manual", async () => {
    for (const q of [null, undefined]) {
      const out = await runVideoD1LinkWatch(deps(), input(edition(), q));
      if (out.status !== "aplicado") return assert.fail(out.status);
      assert.equal(out.results.find((r) => r.destination === "linkedin")?.status, "manual");
    }
  });
});
