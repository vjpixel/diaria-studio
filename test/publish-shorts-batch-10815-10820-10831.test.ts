/**
 * test/publish-shorts-batch-10815-10820-10831.test.ts
 *
 * Lote shorts: upload resumable do Facebook (#10815), robustez do Instagram
 * com autora pessoal (#10820) e horário próprio do vertical, sem comentário
 * fixado (#10831). Nenhum teste toca rede (fetch falso).
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SHORT_SCHEDULE_RAW,
  loadShortScheduleConfig,
  resolveShortTime,
} from "../scripts/lib/diaria/short-video.ts";
import {
  checkInstagramCollaborators,
  planShortsPublish,
  publishFacebookReel,
  publishInstagramReel,
  resolveInstagramAuthor,
  uploadFacebookVideoResumable,
  wantsInstagram,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

// #10998: janela do cenário, independente do default e da config de produção.
const SCHEDULE = {
  rotation_times: ["06:30", "08:00", "12:00"],
  rotation_start: "2026-10-26",
  rotation_end: "2026-11-13",
  default_time: "12:00",
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Call = { url: string; body: any };
function fakeDeps(responses: Array<(c: Call) => any>, now = new Date("2026-10-22T12:00:00Z")): { deps: GraphDeps; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  let i = 0;
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      let body: any = null;
      if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
      else if (init?.body instanceof FormData) {
        body = {};
        for (const [k, v] of init.body) body[k] = typeof v === "string" ? v : `<blob ${(v as Blob).size}>`;
      } else if (init?.body) body = "<binary>";
      const call = { url, body };
      calls.push(call);
      const r = responses[i++];
      if (!r) throw new Error(`chamada inesperada: ${url}`);
      const { __http, ...json } = r(call);
      return new Response(JSON.stringify(json), { status: __http ?? 200 });
    },
    sleep: async () => {},
    now: () => now,
    log: (m) => logs.push(m),
  };
  return { deps, calls, logs };
}

const page: ResolvedFacebookPage = { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" };

function mp4(seconds: number, padding = 0): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(1000, 12);
  p.writeUInt32BE(seconds * 1000, 16);
  const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64]), p]);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 116, 0x6d, 0x6f, 0x6f, 0x76]), mvhd]);
  const ftyp = Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  if (!padding) return Buffer.concat([ftyp, moov]);
  const mdat = Buffer.alloc(8 + padding);
  mdat.writeUInt32BE(8 + padding, 0);
  mdat.write("mdat", 4, "latin1");
  return Buffer.concat([ftyp, mdat, moov]);
}

describe("#10815 Facebook /videos: upload resumable, nunca POST único", () => {
  it("arquivo grande sobe em blocos ditados pelo servidor; nenhuma chamada manda o arquivo inteiro em `source`", async () => {
    const file = mp4(114, 3000); // 1:54, como o vertical de 261022
    const n = file.length;
    const { deps, calls } = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "sess", start_offset: "0", end_offset: "1000" }),
      () => ({ start_offset: "1000", end_offset: "2000" }),
      () => ({ start_offset: "2000", end_offset: String(n) }),
      () => ({ start_offset: String(n), end_offset: String(n) }),
      () => ({ success: true }),
      () => ({ status: { video_status: "ready" } }),
    ]);
    const out = await publishFacebookReel(deps, page, "v25.0", file, "legenda", null);
    assert.equal(calls[0].body.upload_phase, "start");
    assert.equal(calls[0].body.file_size, String(n));
    const transfers = calls.filter((c) => c.body?.upload_phase === "transfer");
    assert.deepEqual(transfers.map((c) => c.body.start_offset), ["0", "1000", "2000"]);
    assert.deepEqual(transfers.map((c) => c.body.video_file_chunk), ["<blob 1000>", "<blob 1000>", `<blob ${n - 2000}>`]);
    assert.ok(calls.every((c) => !(c.body && "source" in c.body)), "POST único com o arquivo inteiro dava 413 (#10815)");
    const finish = calls.find((c) => c.body?.upload_phase === "finish")!;
    assert.equal(finish.body.upload_session_id, "sess");
    assert.equal(finish.body.description, "legenda");
    assert.equal(finish.body.published, undefined, "sem agendamento = publica");
    assert.equal(out.entry.id, "v1");
    assert.equal(out.entry.status, "published");
  });

  it("bloco com falha transitória é reenviado; falha persistente lança", async () => {
    const file = mp4(120);
    const n = file.length;
    const ok = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: String(n) }),
      () => ({ __http: 500, error: { message: "tmp" } }),
      () => ({ start_offset: String(n), end_offset: String(n) }),
      () => ({ success: true }),
    ]);
    assert.equal(await uploadFacebookVideoResumable(ok.deps, page, "v25.0", file, "x", null), "v1");
    assert.ok(ok.logs.some((l) => l.includes("tentando o bloco de novo")));
    const bad = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: String(n) }),
      () => ({ __http: 500, error: { message: "a" } }),
      () => ({ __http: 500, error: { message: "b" } }),
      () => ({ __http: 500, error: { message: "c" } }),
    ]);
    await assert.rejects(uploadFacebookVideoResumable(bad.deps, page, "v25.0", file, "x", null), /transfer 0-/);
  });

  it("servidor que não avança o offset, offsets inválidos ou start sem sessão LANÇAM (nunca loop infinito)", async () => {
    const file = mp4(120);
    const n = file.length;
    const stuck = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: "10" }),
      () => ({ start_offset: "0", end_offset: "10" }),
    ]);
    await assert.rejects(uploadFacebookVideoResumable(stuck.deps, page, "v25.0", file, "x", null), /não avançou/);
    const bogus = fakeDeps([() => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: String(n + 50) })]);
    await assert.rejects(uploadFacebookVideoResumable(bogus.deps, page, "v25.0", file, "x", null), /offsets inválidos/);
    const noSession = fakeDeps([() => ({ video_id: "v1" })]);
    await assert.rejects(uploadFacebookVideoResumable(noSession.deps, page, "v25.0", file, "x", null), /upload_session_id/);
    const noFinish = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: String(n) }),
      () => ({ start_offset: String(n), end_offset: String(n) }),
      () => ({}),
    ]);
    await assert.rejects(uploadFacebookVideoResumable(noFinish.deps, page, "v25.0", file, "x", null), /finish/);
  });

  it("finish agendado leva published=false e epoch em segundos", async () => {
    const file = mp4(120);
    const n = file.length;
    const { deps, calls } = fakeDeps([
      () => ({ video_id: "v1", upload_session_id: "s", start_offset: "0", end_offset: String(n) }),
      () => ({ start_offset: String(n), end_offset: String(n) }),
      () => ({ success: true }),
    ]);
    await uploadFacebookVideoResumable(deps, page, "v25.0", file, "x", "2026-10-22T15:00:00.000Z");
    assert.equal(calls[2].body.published, "false");
    assert.equal(calls[2].body.scheduled_publish_time, String(Date.parse("2026-10-22T15:00:00.000Z") / 1000));
  });
});

describe("#10820 Instagram com autora pessoal", () => {
  function seqFetch(seq: Array<{ json: any; status?: number }>): { deps: Pick<GraphDeps, "fetch">; urls: string[] } {
    const urls: string[] = [];
    return {
      deps: {
        fetch: async (url) => {
          urls.push(url);
          const r = seq[urls.length - 1];
          if (!r) throw new Error(`chamada inesperada: ${url}`);
          return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
        },
      },
      urls,
    };
  }
  const linked = { json: { instagram_business_account: { id: "1784", username: "vjpixel" } } };

  it("token que lê a conta mas não tem instagram_content_publish → NÃO pronto, nomeando o escopo", async () => {
    const { deps, urls } = seqFetch([linked, { json: { data: { scopes: ["pages_show_list", "instagram_basic"] } } }]);
    const a = await resolveInstagramAuthor(deps, "vjpixel", [page], "v25.0", { igUserId: "", token: "" });
    assert.equal(a.ready, false);
    assert.match((a as { reason: string }).reason, /instagram_content_publish/);
    assert.match(urls[1], /debug_token\?input_token=tok/);
  });

  it("com o escopo → pronto sem aviso; debug_token ilegível → pronto COM aviso (não bloqueia token válido)", async () => {
    const ok = await resolveInstagramAuthor(seqFetch([linked, { json: { data: { scopes: ["instagram_content_publish"] } } }]).deps, "vjpixel", [page], "v25.0", { igUserId: "", token: "" });
    assert.equal(ok.ready, true);
    assert.equal((ok as { warnings?: string[] }).warnings, undefined);
    const unk = await resolveInstagramAuthor(seqFetch([linked, { json: { error: { message: "no" } }, status: 400 }]).deps, "vjpixel", [page], "v25.0", { igUserId: "", token: "" });
    assert.equal(unk.ready, true);
    assert.match((unk as { warnings: string[] }).warnings[0], /não deu pra conferir/);
  });

  it("aviso de escopo não conferido aparece no plano", () => {
    const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo. Mais.\n\nPor que isso importa: sim.\n";
    const plan = planShortsPublish({
      aammdd: "261022",
      reviewedMd: reviewed,
      now: new Date("2026-10-22T20:00:00Z"),
      config: { publishing: { shorts: { facebook_pages: ["diaria", "vjpixel"], instagram: true, instagram_backend: "worker-r2", instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"], schedule: SCHEDULE } } },
      pages: [{ ...page, slug: "diaria" }, page],
      instagramReady: true,
      instagramWarnings: ["não deu pra conferir o escopo"],
      published: { aammdd: "261022", entries: [] },
      video: { path: "v.mp4", exists: true, sizeBytes: 1 },
      editionUrl: "https://diar.ia.br/p/x",
    });
    assert.ok(plan.warnings.includes("instagram: não deu pra conferir o escopo"));
  });

  it("página com token mas sem pageId → não pronto, sem chamar a Graph", async () => {
    const semId: ResolvedFacebookPage = { ...page, pageId: "", missing: ["FACEBOOK_VJPIXEL_PAGE_ID"] };
    const { deps, urls } = seqFetch([]);
    const a = await resolveInstagramAuthor(deps, "vjpixel", [semId], "v25.0", { igUserId: "", token: "" });
    assert.equal(a.ready, false);
    assert.match((a as { reason: string }).reason, /sem credencial \(FACEBOOK_VJPIXEL_PAGE_ID\)/);
    assert.equal(urls.length, 0);
    // Mesmo se `missing` vier vazio por algum caminho, pageId vazio não segue pra Graph.
    const inconsist = await resolveInstagramAuthor(deps, "vjpixel", [{ ...page, pageId: "" }], "v25.0", { igUserId: "", token: "" });
    assert.equal(inconsist.ready, false);
    assert.equal(urls.length, 0);
  });

  it("slug inválido em instagram_author_page LANÇA no plano (como facebook_pages); com Instagram desligado, não", () => {
    const reviewed = "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n";
    const base = {
      aammdd: "261022",
      reviewedMd: reviewed,
      now: new Date("2026-10-22T20:00:00Z"),
      pages: [{ ...page, slug: "diaria" }],
      instagramReady: false,
      published: { aammdd: "261022", entries: [] },
      video: { path: "v.mp4", exists: true, sizeBytes: 1 },
      editionUrl: "https://diar.ia.br/p/x",
    };
    const cfg = (instagram: boolean) => ({ publishing: { shorts: { schedule: SCHEDULE, facebook_pages: ["diaria"], instagram, instagram_author_page: "vjpixl" } } });
    assert.throws(() => planShortsPublish({ ...base, config: cfg(true) }), /instagram_author_page: página "vjpixl"/);
    assert.doesNotThrow(() => planShortsPublish({ ...base, config: cfg(false) }));
  });

  it("wantsInstagram: desligado, fora do --only ou já registrado → não resolve a autora", () => {
    const empty = { aammdd: "261022", entries: [] };
    const done = { aammdd: "261022", entries: [{ destination: "instagram", status: "published" as const, id: "1", at: "x" }] };
    assert.equal(wantsInstagram({ instagram: true }, null, empty), true);
    assert.equal(wantsInstagram({ instagram: true }, ["instagram"], empty), true);
    assert.equal(wantsInstagram({ instagram: false }, null, empty), false);
    assert.equal(wantsInstagram({ instagram: true }, ["facebook:diaria"], empty), false);
    assert.equal(wantsInstagram({ instagram: true }, null, done), false, "skip_done não precisa de chamada à Graph");
  });

  it("collab descartado vira aviso; collab presente não; falha de leitura avisa sem lançar", async () => {
    const dropped = await checkInstagramCollaborators(seqFetch([{ json: { data: [] } }]).deps, "m1", "t", "v25.0", ["diar.ia.br"]);
    assert.match(dropped[0], /descartado.*@diar\.ia\.br/);
    const kept = await checkInstagramCollaborators(seqFetch([{ json: { data: [{ username: "Diar.ia.br", invite_status: "Pending" }] } }]).deps, "m1", "t", "v25.0", ["diar.ia.br"]);
    assert.deepEqual(kept, []);
    const err = await checkInstagramCollaborators(seqFetch([{ json: { error: { message: "x" } }, status: 400 }]).deps, "m1", "t", "v25.0", ["diar.ia.br"]);
    assert.match(err[0], /não deu pra conferir/);
  });

  it("publishInstagramReel relê os collaborators e devolve o aviso no outcome", async () => {
    const { deps, calls } = fakeDeps([
      () => ({ id: "c1" }),
      () => ({ success: true }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m1" }),
      () => ({ permalink: "p" }),
      () => ({ data: [] }),
    ]);
    const out = await publishInstagramReel(deps, "1784", "tok", "v25.0", Buffer.from([0]), "legenda", ["diar.ia.br"]);
    assert.match(calls[5].url, /\/m1\/collaborators\?/);
    assert.match(out.warnings![0], /descartado/);
  });
});

describe("#10831 horário próprio do vertical", () => {
  const sched = loadShortScheduleConfig({ publishing: { shorts: { schedule: SCHEDULE } } });

  it("alterna 06:30/08:00/12:00 por dia corrido a partir de 261026 (segunda); fora da janela, default", () => {
    assert.equal(resolveShortTime(sched, "261026").hhmm, "06:30");
    assert.equal(resolveShortTime(sched, "261026").source, "rotation");
    assert.equal(resolveShortTime(sched, "261027").hhmm, "08:00");
    assert.equal(resolveShortTime(sched, "261028").hhmm, "12:00");
    assert.equal(resolveShortTime(sched, "261029").hhmm, "06:30");
    assert.equal(resolveShortTime(sched, "261102").hhmm, "08:00");
    assert.equal(resolveShortTime(sched, "261113").hhmm, "06:30");
    assert.equal(resolveShortTime(sched, "261113").source, "rotation");
    assert.deepEqual([resolveShortTime(sched, "261114").source, resolveShortTime(sched, "261114").hhmm], ["default", "12:00"]);
    // 261022 e 261023 (teste antigo 12:00/19:00) e 261021 ficam fora da janela nova
    assert.deepEqual([resolveShortTime(sched, "261023").source, resolveShortTime(sched, "261023").hhmm], ["default", "12:00"]);
    assert.equal(resolveShortTime(sched, "261021").source, "default");
  });

  it("15 dias úteis (261026 a 261113): cada horário sai 5 vezes e cai uma vez em cada dia da semana", () => {
    const porHorario: Record<string, number[]> = {};
    for (let d = new Date("2026-10-26T12:00:00Z"); d <= new Date("2026-11-13T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue; // só há edição de segunda a sexta
      const aammdd = d.toISOString().slice(2, 10).replace(/-/g, "");
      (porHorario[resolveShortTime(sched, aammdd).hhmm] ??= []).push(dow);
    }
    assert.deepEqual(Object.keys(porHorario).sort(), ["06:30", "08:00", "12:00"]);
    for (const dias of Object.values(porHorario)) {
      assert.equal(dias.length, 5);
      assert.deepEqual([...dias].sort(), [1, 2, 3, 4, 5]);
    }
  });

  it("nunca 06:00 (o horário do horizontal) em toda a janela do teste", () => {
    for (let d = 26; d <= 31; d++) assert.notEqual(resolveShortTime(sched, `2610${d}`).hhmm, "06:00");
    for (let d = 1; d <= 13; d++) assert.notEqual(resolveShortTime(sched, `2611${String(d).padStart(2, "0")}`).hhmm, "06:00");
  });

  it("config real é válida sem exigir um horário editorial específico", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const real = loadShortScheduleConfig(config);
    assert.ok(real.rotationTimes.length > 0);
  });

  it("#10998: horário vencedor fora da rotação vem da config injetada", () => {
    const config = { publishing: { shorts: { schedule: { ...SCHEDULE, default_time: "09:45" } } } };
    const pinned = loadShortScheduleConfig(config);
    assert.equal(resolveShortTime(pinned, "261116").hhmm, "09:45");
    assert.equal(resolveShortTime(sched, "261116").hhmm, "12:00");
    assert.equal(resolveShortTime(pinned, "261027").hhmm, "08:00");
  });

  it("config malformado LANÇA (estragaria o teste em silêncio)", () => {
    const mk = (schedule: unknown) => ({ publishing: { shorts: { schedule } } });
    assert.throws(() => loadShortScheduleConfig(mk(5)), /objeto/);
    assert.throws(() => loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, rotation_times: [] })), /rotation_times/);
    assert.throws(() => loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, rotation_times: ["7h"] })), /rotation_times/);
    assert.throws(() => loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, default_time: "25:00" })), /default_time/);
    assert.throws(() => loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, rotation_end: "2026-10-01" })), /antes de rotation_start/);
    assert.throws(() => loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, rotation_start: "2026-02-31" })), /não existe/);
    assert.equal(loadShortScheduleConfig(mk({ ...DEFAULT_SHORT_SCHEDULE_RAW, rotation_end: null })).rotationEnd, null);
  });

  it("plano agenda o Facebook no horário do vertical (261027 → 08:00 BRT = 11:00Z) e expõe shortTime pro passo guiado", () => {
    const reviewed = "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n";
    const plan = planShortsPublish({
      aammdd: "261027",
      reviewedMd: reviewed,
      now: new Date("2026-10-27T08:00:00Z"),
      config: { publishing: { shorts: { facebook_pages: ["diaria", "vjpixel"], instagram: true, instagram_backend: "worker-r2", instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"], schedule: SCHEDULE } } },
      pages: [{ ...page, slug: "diaria" }, page],
      instagramReady: true,
      published: { aammdd: "261027", entries: [] },
      video: { path: "v.mp4", exists: true, sizeBytes: 1 },
      editionUrl: "https://diar.ia.br/p/x",
    });
    assert.equal(plan.shortTime.hhmm, "08:00");
    assert.equal(plan.shortTime.at, "2026-10-27T11:00:00.000Z");
    const fb = plan.items.find((i) => i.destination === "facebook:diaria") as { scheduledAt: string | null };
    assert.equal(fb.scheduledAt, "2026-10-27T11:00:00.000Z");
    const ig = plan.items.find((i) => i.destination === "instagram") as { action: string; detail: string };
    assert.equal(ig.action, "pending_schedule");
    assert.match(ig.detail, /08:00 BRT/);
    assert.ok(!("pinnedComment" in plan.youtube), "sem comentário fixado (#10831)");
  });
});
