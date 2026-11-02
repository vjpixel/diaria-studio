/**
 * test/publish-shorts-corte-11795.test.ts (#11795)
 *
 * Vídeo vertical AVULSO (corte fora de edição) pelo `publish-shorts.ts
 * --corte SLUG`. Em 01/11/2026 o corte "Tratar IA como humano" só saiu com
 * workarounds: `02-reviewed.md` sintético com DESTAQUE 1 falso, chave de R2 da
 * edição do dia, `--edition-url` só pra satisfazer o plano e horário caindo na
 * rotação do teste do #10831. Estes testes travam o caminho de primeira
 * classe: título/gancho explícitos, registro e R2 próprios, horário explícito
 * fora do teste, sem delegar aos timers do 300. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_FORBIDDEN_FLAGS,
  DIARIA_HOME_URL,
  assignShortsDestinationOwners,
  instagramReelRouteChoice,
  loadEditionDayGrid,
  parseShortsCliArgs,
  planShortsPublish,
  prepareCorteRun,
} from "../scripts/publish-shorts.ts";
import {
  CORTE_SPEC_FILE,
  corteBaseCommand,
  corteR2Key,
  corteShortTime,
  corteVideoPortabilityWarning,
  corteVideoRef,
  mergeCorteSpec,
  resolveCorteVideo,
  parseCorteSpec,
  validateCorteSlug,
} from "../scripts/lib/diaria/short-corte.ts";
import { planShortSlots, shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import { SHORT_COVER_FILE } from "../scripts/lib/diaria/short-cover.ts";
import { matchEditionVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  schedule: SCHEDULE,
};
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const CORTE = { slug: "tratar-ia-como-humano", hhmm: "08:00", title: "Tratar IA como humano", hook: "Por que dar nome ao chatbot muda o jeito que você usa. Segunda frase." };
const base = {
  aammdd: "261102",
  reviewedMd: "",
  config: { publishing: { shorts } },
  pages: [page("diaria")],
  instagramReady: true,
  published: { aammdd: "261102", entries: [] },
  video: { path: "/videos/Tratar IA como humano_V2.mp4", exists: true, sizeBytes: 10 },
  videoDurationSeconds: 50,
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
  youtubeApi: { ready: true } as const,
  corte: CORTE,
};
const BEFORE = new Date("2026-11-02T03:00:00Z"); // 00:00 BRT, antes das 08:00
const itemOf = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d) as any;

describe("#11795 planShortsPublish com corte avulso", () => {
  it("deriva título e gancho do corte, sem 02-reviewed.md nem D1", () => {
    const p = planShortsPublish({ ...base, now: BEFORE });
    assert.equal(p.youtube.title, "Tratar IA como humano #Shorts");
    assert.match(p.youtube.description, /^Por que dar nome ao chatbot muda o jeito que você usa\./);
    assert.equal(p.editionUrl, DIARIA_HOME_URL);
    assert.ok(p.premises.some((x) => x.includes('corte avulso "tratar-ia-como-humano"')), p.premises.join("\n"));
    assert.ok(!p.premises.some((x) => /derivado do título do D1/.test(x)));
  });

  it("horário explícito fora do teste do #10831 (261102 cairia na rotação)", () => {
    const p = planShortsPublish({ ...base, corte: { ...CORTE, hhmm: "19:30" }, now: BEFORE });
    assert.equal(p.shortTime.source, "explicit");
    assert.equal(p.shortTime.hhmm, "19:30");
    assert.ok(p.slots.length > 0);
    for (const s of p.slots) {
      assert.equal(s.rule, "explicit", `${s.destination}: ${s.rule}`);
      assert.equal(s.hhmm, "19:30");
      assert.doesNotMatch(s.premise, /teste de horário/);
    }
    assert.ok(!p.premises.some((x) => /teste de horário do vertical, dia/.test(x)), p.premises.join("\n"));
  });

  it("não delega aos timers do 300 (eles não enxergam a pasta do corte) e re-executa pelo comando do corte", () => {
    const p = planShortsPublish({ ...base, now: BEFORE });
    for (const d of ["linkedin_profile", "threads_profile", "instagram"]) {
      const item = itemOf(p, d);
      assert.notEqual(item.action, "skip_delegated", d);
      assert.equal(item.action, "pending_schedule", d);
      const owner = p.owners.find((o) => o.destination === d)!;
      assert.equal(owner.by, "agent-scheduled-task", d);
      assert.equal(owner.command, `npx tsx scripts/publish-shorts.ts --corte ${CORTE.slug} --only ${d} --publish`);
    }
  });

  it("#11825: passo guiado futuro do corte fica com o agente desta rodada, nunca com um comando que só imprime o plano", () => {
    const items = [{ destination: "facebook_profile", action: "guided", at: "2026-11-02T22:30:00.000Z" }] as any;
    const [owner] = assignShortsDestinationOwners(items, { aammdd: "261102", now: BEFORE, instagramViaTimer: false, baseCommand: corteBaseCommand("abc") });
    assert.equal(owner.by, "agent");
    assert.equal(owner.command, undefined);
    assert.match(owner.note, /2026-11-02T22:30/);
    const [edition] = assignShortsDestinationOwners(items, { aammdd: "261102", now: BEFORE, instagramViaTimer: false });
    assert.equal(edition.by, "agent-scheduled-task", "na edição a skill segue dona da re-execução");
    assert.equal(edition.command, "/diaria-publica-video 261102 --so vertical");
  });

  it("sem corte, a mesma config segue delegando (regressão do caminho da edição)", () => {
    const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://example.com/a)\n\nCorpo do D1. Mais.\n\nPor que isso importa: x.\n";
    const { corte: _omit, ...edition } = base;
    const p = planShortsPublish({ ...edition, reviewedMd: REVIEWED, editionUrl: "https://diar.ia.br/p/x", now: BEFORE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_delegated");
    assert.equal(itemOf(p, "instagram").action, "skip_delegated");
    assert.equal(p.shortTime.source, "rotation");
  });
});

describe("#11795 chaves e conferências próprias do corte", () => {
  it("chave de R2 do corte nunca é a do vertical da edição", () => {
    assert.equal(corteR2Key("tratar-ia-como-humano", "video"), "shorts/cortes/tratar-ia-como-humano.mp4");
    assert.equal(corteR2Key("tratar-ia-como-humano", "cover"), "shorts/cortes/tratar-ia-como-humano-cover.jpg");
    assert.notEqual(corteR2Key("x", "video"), `shorts/${shortVideoFileName("261102")}`);
  });

  it("Reels do corte usa o objeto do corte (o mesmo de X e Threads)", () => {
    const c = instagramReelRouteChoice({ authorPage: null, aammdd: "261102", videoPath: "/v/corte.mp4", file: Buffer.from("x"), corteVideoKey: corteR2Key("abc", "video") });
    assert.deepEqual(c, { route: "video_url", key: "shorts/cortes/abc.mp4", genericKey: null });
  });

  it("YouTube: com titleOnly, o Short da EDIÇÃO do mesmo dia não bloqueia o corte; o mesmo título sim", () => {
    const editionShort = { id: "ed1", snippet: { title: "Outra coisa 261102 #Shorts", description: "", publishedAt: "2026-11-02T11:00:00Z" }, status: { privacyStatus: "public" } };
    const sameDay = { id: "ed2", snippet: { title: "Sem marca #Shorts", description: "", publishedAt: "2026-11-02T12:00:00Z" }, status: { privacyStatus: "public" } };
    const criteria = { aammdd: "261102", title: "Tratar IA como humano #Shorts", kind: "short" as const };
    assert.notEqual(matchEditionVideo([editionShort, sameDay] as any, criteria), null, "sem titleOnly o Short da edição bloquearia");
    assert.equal(matchEditionVideo([editionShort, sameDay] as any, { ...criteria, titleOnly: true }), null);
    const dup = { id: "c1", snippet: { title: "Tratar IA como humano #Shorts", description: "" }, status: { privacyStatus: "private" } };
    assert.equal(matchEditionVideo([editionShort, dup] as any, { ...criteria, titleOnly: true })?.videoId, "c1");
  });

  it("planShortSlots com horário explícito não usa o rótulo do teste", () => {
    const slots = planShortSlots({
      aammdd: "261102",
      time: corteShortTime("08:00"),
      timeAt: "2026-11-02T11:00:00.000Z",
      destinations: [{ id: "facebook:diaria", kind: "facebook_page", mode: "api", slug: "diaria" } as any],
      cfg: { instagramAuthorPage: null },
      grid: [{ account: "facebook:diaria", at: "2026-11-02T11:10:00.000Z", label: "post" }],
    });
    assert.equal(slots[0].rule, "explicit");
    assert.match(slots[0].warning ?? "", /horário do corte/);
  });
});

describe("#11795 corte.json (registro próprio)", () => {
  it("1ª rodada sem os campos obrigatórios falha nomeando o que falta", () => {
    const r = mergeCorteSpec("abc", null, { title: "T" });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /date.*hhmm.*hook.*video/s);
  });

  it("flag vence o corte.json e só os campos mudados contam", () => {
    const existing = { slug: "abc", date: "261102", hhmm: "08:00", title: "T", hook: "H.", video: "/v.mp4" };
    const r = mergeCorteSpec("abc", existing, { title: "T2" });
    assert.ok(r.ok);
    assert.deepEqual((r as any).changed, ["title"]);
    assert.equal((r as any).spec.title, "T2");
    assert.deepEqual((mergeCorteSpec("abc", existing, {}) as any).changed, []);
  });

  it("slug inválido, corte.json de outro slug e JSON ilegível lançam/recusam", () => {
    assert.ok(validateCorteSlug("Tratar IA"));
    assert.equal(validateCorteSlug("tratar-ia"), null);
    const existing = { slug: "abc", date: "261102", hhmm: "08:00", title: "T", hook: "H.", video: "/v.mp4" };
    assert.equal(mergeCorteSpec("outro", existing, {}).ok, false);
    assert.throws(() => parseCorteSpec("{", "x.json"), /ilegível/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...existing, hhmm: "8h" }), "x.json"), /hhmm/);
  });

  it("prepareCorteRun grava a spec, copia a capa e a 2ª rodada só precisa do slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11795-"));
    const cover = join(dir, "..", `capa-${Date.now()}.jpg`);
    writeFileSync(cover, "jpg");
    const logs: string[] = [];
    const spec = prepareCorteRun({
      slug: "abc",
      dir,
      values: { date: "261102", at: "08:00", title: "Tratar IA como humano", hook: "Gancho.", video: "/videos/x.mp4", cover },
      positionalDate: "",
      log: (l) => logs.push(l),
    });
    assert.equal(spec.video, "/videos/x.mp4");
    assert.ok(existsSync(join(dir, CORTE_SPEC_FILE)));
    assert.equal(readFileSync(join(dir, SHORT_COVER_FILE), "utf8"), "jpg");
    const again = prepareCorteRun({ slug: "abc", dir, values: {}, positionalDate: "", log: (l) => logs.push(l) });
    assert.deepEqual(again, spec);
    assert.equal(logs.filter((l) => /registrado|atualizado/.test(l)).length, 1, logs.join("\n"));
    assert.throws(() => prepareCorteRun({ slug: "novo", dir: join(dir, "novo"), values: { title: "T" }, positionalDate: "", log: () => {} }), /incompleto/);
  });

  it("--from-drive sem --video baixa na pasta do corte", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11795-"));
    const spec = prepareCorteRun({ slug: "abc", dir, values: { at: "08:00", title: "T", hook: "H.", "from-drive": "1234567890abc" }, positionalDate: "261102", log: () => {} });
    assert.equal(spec.video, "corte-abc.mp4", "relativo à pasta do corte (data/ sincroniza entre máquinas, #11825)");
    assert.equal(resolveCorteVideo(dir, spec.video), join(dir, "corte-abc.mp4"));
    assert.equal(spec.date, "261102");
  });

  it("#11825: --from-drive numa rodada posterior nunca baixa por cima do vídeo original do editor", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11825-"));
    const original = "/editor/Cortes para as redes/original.mp4";
    prepareCorteRun({ slug: "abc", dir, values: { date: "261102", at: "08:00", title: "T", hook: "H.", video: original }, positionalDate: "", log: () => {} });
    const again = prepareCorteRun({ slug: "abc", dir, values: { "from-drive": "1234567890abc" }, positionalDate: "", log: () => {} });
    assert.equal(again.video, "corte-abc.mp4");
    assert.notEqual(resolveCorteVideo(dir, again.video), original);
    assert.equal(JSON.parse(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8")).video, "corte-abc.mp4");
  });

  it("#11825: --video e --from-drive juntos, e --date diferente do AAMMDD posicional, recusam", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11825-"));
    const values = { date: "261102", at: "08:00", title: "T", hook: "H." };
    assert.throws(() => prepareCorteRun({ slug: "abc", dir, values: { ...values, video: "/v.mp4", "from-drive": "1234567890abc" }, positionalDate: "", log: () => {} }), /OU --from-drive/);
    assert.throws(() => prepareCorteRun({ slug: "abc", dir, values: { ...values, video: "/v.mp4" }, positionalDate: "261103", log: () => {} }), /data ambígua/);
    assert.equal(prepareCorteRun({ slug: "abc", dir, values: { ...values, video: "/v.mp4" }, positionalDate: "261102", log: () => {} }).date, "261102");
  });

  it("#11825: vídeo dentro da pasta do corte vira relativo; fora dela segue absoluto e fora de data/ avisa", () => {
    const dir = join("/repo", "data", "cortes", "abc");
    assert.equal(corteVideoRef(dir, join(dir, "x.mp4")), "x.mp4");
    assert.equal(corteVideoRef(dir, "/videos/x.mp4"), "/videos/x.mp4");
    assert.equal(resolveCorteVideo(dir, "/videos/x.mp4"), "/videos/x.mp4");
    assert.equal(corteVideoPortabilityWarning(join(dir, "x.mp4"), "/repo/data"), null);
    assert.match(corteVideoPortabilityWarning("/videos/x.mp4", "/repo/data") ?? "", /fora de data\//);
  });
});

describe("#11795 CLI", () => {
  it("--corte dispensa o AAMMDD posicional; sem --corte ele segue obrigatório", () => {
    const r = parseShortsCliArgs(["--corte", "abc", "--publish"]);
    assert.ok(r.ok);
    assert.equal((r as any).aammdd, "");
    assert.equal(parseShortsCliArgs(["--publish"]).ok, false);
  });

  it("timers e --confirm-instagram ficam fora do corte", () => {
    assert.deepEqual([...CORTE_FORBIDDEN_FLAGS].sort(), ["confirm-instagram", "instagram-timer", "linkedin-timer", "threads-timer"]);
    assert.equal(corteBaseCommand("abc"), "npx tsx scripts/publish-shorts.ts --corte abc");
  });

  it("grade da edição do dia: pasta ausente é grade vazia", () => {
    assert.deepEqual(loadEditionDayGrid(join(tmpdir(), "nao-existe-11795"), "261102", null, [], () => {}), []);
  });
});
