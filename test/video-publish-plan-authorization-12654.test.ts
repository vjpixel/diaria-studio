/**
 * test/video-publish-plan-authorization-12654.test.ts (#12654, caminho A)
 *
 * Autorização da publicação dos vídeos da edição vinculada ao SHA-256 de um
 * manifesto canônico do plano: grant (confirmação explícita + hash do plano
 * mostrado), consumo de uso único antes do 1º efeito externo, invalidação
 * comunicada pelo coordenador, releitura do registro antes do retry, task
 * one-shot só com autorização. Nenhum publisher roda de verdade: os CLIs
 * aqui só correm no caminho de recusa, em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHorizontalManifest,
  buildVerticalManifest,
  canonicalJson,
  commandMatchesOwner,
  destinationBindingSha256,
  diffManifests,
  planSha256,
  readVideoPlanSources,
  sha256File,
  sha256Hex,
  writeVideoPlanManifest,
  type VideoPlanManifest,
} from "../scripts/lib/diaria/video-publish-plan.ts";
import {
  authorizationStorePath,
  checkTaskAuthorization,
  consumeBeforeExternalEffects,
  consumeVideoPublishAuthorization,
  emptyAuthorizationStore,
  grantVideoPublishAuthorization,
  invalidateVideoPublishAuthorization,
  readAuthorizationStore,
  recordRegistryCheck,
  type VideoPublishAuthorization,
  type VideoPublishAuthorizationStore,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import { main as authorizeMain } from "../scripts/video-publish-authorize.ts";
import { main as registryStatusMain } from "../scripts/video-publish-registry-status.ts";
import { buildShortsPlanManifest, planShortsPublish, shortsMainPublishCommand, shortsRunDestinations } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ED = "261112";
const T0 = new Date("2026-11-11T22:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const CONFIRM = "pode publicar";

const media = { video_sha256: sha256Hex("video"), cover_sha256: sha256Hex("capa"), captions_sha256: sha256Hex("srt") };
const sources = { reviewed: sha256Hex("rev"), social: sha256Hex("soc"), roteiro: null, horizontal_link: null, edition_url: null };

function horizontal(over: Partial<Parameters<typeof buildHorizontalManifest>[0]> = {}): VideoPlanManifest {
  return buildHorizontalManifest({
    aammdd: ED,
    metadata: { title: "Ensinaram a IA e foram demitidos", description: "desc com link", tags: ["ia", "trabalho"] },
    schedule: { mode: "scheduled", publishAt: "2026-11-12T09:00:00.000Z" },
    privacy: "private",
    media,
    sources,
    command: `npx tsx scripts/publish-youtube.ts ${ED} --upload --confirm-publish ${ED}`,
    generatedAt: T0.toISOString(),
    ...over,
  });
}

const TASK_CMD = `npx tsx scripts/publish-shorts.ts ${ED} --only threads_profile --publish --confirm-publish ${ED}`;
const MAIN_CMD = `npx tsx scripts/publish-shorts.ts ${ED} --publish --confirm-publish ${ED}`;
/** Horário aprovado do Threads adiado (task one-shot): T0 + 17 h. */
const THREADS_AT = "2026-11-12T15:00:00.000Z";
const AFTER_THREADS = at(17 * 60 + 1);

/** Plano do vertical na aprovação: Shorts e Facebook saem na rodada; Threads adiado (task); LinkedIn pelo timer; X atrasado. */
function vertical(opts: { threadsAction?: "pending_schedule" | "publish"; horizontalLink?: string | null; sourcesOver?: Record<string, string | null>; caption?: string; mediaOver?: Partial<typeof media> } = {}): VideoPlanManifest {
  const threadsAction = opts.threadsAction ?? "pending_schedule";
  const caption = opts.caption ?? "legenda do Threads";
  return buildVerticalManifest({
    aammdd: ED,
    items: [
      { destination: "youtube_shorts", action: "publish", caption: "descrição do Short", title: "Título do Short", scheduledAt: null },
      { destination: "facebook", action: "publish", caption: "legenda do Facebook", scheduledAt: null },
      { destination: "threads_profile", action: threadsAction, caption, scheduledAt: threadsAction === "pending_schedule" ? THREADS_AT : null },
      { destination: "linkedin_profile", action: "skip_delegated" },
      { destination: "x", action: "skip_late" },
      { destination: "instagram", action: "skip_done" },
    ],
    owners:
      threadsAction === "pending_schedule"
        ? [
            { destination: "threads_profile", by: "agent-scheduled-task", command: TASK_CMD },
            { destination: "linkedin_profile", by: "timer-300", task: "Diaria-Shorts-LinkedIn-Profile" },
            { destination: "x", by: "agent", command: `npx tsx scripts/publish-shorts.ts ${ED} --only x --publish --now --confirm-publish ${ED}` },
          ]
        : [],
    destinationAt: (id) => (id === "youtube_shorts" ? "2026-11-12T09:30:00.000Z" : "2026-11-12T15:00:00.000Z"),
    horizontalLink: (id) => (id === "facebook" || id === "threads_profile" ? (opts.horizontalLink === undefined ? "https://youtu.be/abc" : opts.horizontalLink) : null),
    metadata: { title: "Título do Short", description: "descrição do Short" },
    media: { ...media, captions_sha256: null, ...(opts.mediaOver ?? {}) },
    sources: { ...sources, ...(opts.sourcesOver ?? {}) },
    publishCommand: `npx tsx scripts/publish-shorts.ts ${ED} --publish --confirm-publish ${ED}`,
  });
}

function granted(m: VideoPlanManifest, store: VideoPublishAuthorizationStore = emptyAuthorizationStore(ED), now = T0): VideoPublishAuthorizationStore {
  const r = grantVideoPublishAuthorization(store, { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now, isPidAlive: () => false });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.store;
}

function consume(store: VideoPublishAuthorizationStore, m: VideoPlanManifest, destinations: string[], now = at(5), edition = ED) {
  return consumeVideoPublishAuthorization(store, { edition, manifest: m, destinations, now, pid: 4242, by: "teste" });
}

describe("#12654 manifesto canônico", () => {
  it("JSON canônico independe da ordem das chaves; ordem de array é conteúdo", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }));
    assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  });

  it("generated_at (timestamp do dry-run) é o único campo volátil: não muda o hash", () => {
    const a = horizontal();
    const b = horizontal({ generatedAt: "2030-01-01T00:00:00.000Z" });
    assert.equal(planSha256(a), planSha256(b));
    assert.deepEqual(diffManifests(a, b), []);
  });

  it("sha256File: lê o arquivo em blocos; ausente é null", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-12654-"));
    try {
      writeFileSync(join(dir, "v.mp4"), "abc");
      assert.equal(sha256File(join(dir, "v.mp4")), sha256Hex("abc"));
      assert.equal(sha256File(join(dir, "nada.mp4")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vertical: só entram destinos com efeito (skip_done fica fora; timer, atrasado e adiado entram)", () => {
    const ids = vertical().destinations.map((d) => d.id);
    assert.deepEqual(ids, ["youtube_shorts", "facebook", "threads_profile", "linkedin_profile", "x"]);
    assert.equal(vertical().destinations.find((d) => d.id === "x")!.content, null);
  });
});

describe("#12654 mutação de CADA campo do manifesto é recusada no publisher", () => {
  const base = horizontal();
  const mutations: Array<[string, VideoPlanManifest]> = [
    ["media.video_sha256", horizontal({ media: { ...media, video_sha256: sha256Hex("outro vídeo") } })],
    ["media.cover_sha256", horizontal({ media: { ...media, cover_sha256: sha256Hex("outra capa") } })],
    ["media.captions_sha256", horizontal({ media: { ...media, captions_sha256: null } })],
    ["metadata.title", horizontal({ metadata: { title: "Outro título", description: "desc com link", tags: ["ia", "trabalho"] } })],
    ["metadata.description", horizontal({ metadata: { title: "Ensinaram a IA e foram demitidos", description: "outra", tags: ["ia", "trabalho"] } })],
    ["metadata.tags", horizontal({ metadata: { title: "Ensinaram a IA e foram demitidos", description: "desc com link", tags: ["trabalho", "ia"] } })],
    ["destinations[youtube].at", horizontal({ schedule: { mode: "scheduled", publishAt: "2026-11-12T10:00:00.000Z" } })],
    ["destinations[youtube].content.privacy", horizontal({ privacy: "public" })],
  ];
  for (const [field, mutated] of mutations) {
    it(`${field}: hash do plano muda e o consumo recusa nomeando o campo`, () => {
      assert.notEqual(planSha256(mutated), planSha256(base));
      assert.ok(diffManifests(base, mutated).some((p) => p.startsWith(field)), `${field} ∉ ${diffManifests(base, mutated).join(",")}`);
      const r = consume(granted(base), mutated, ["youtube"]);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, /o plano mudou desde a aprovação/);
      assert.match(r.ok ? "" : r.error, new RegExp(field.replace(/[.[\]]/g, "\\$&")));
    });
  }
  it("timezone e schema também entram no hash", () => {
    assert.notEqual(planSha256({ ...base, timezone: "UTC" }), planSha256(base));
    assert.equal(consume(granted(base), { ...base, timezone: "UTC" }, ["youtube"]).ok, false);
  });
  it("edição dentro do manifesto: recusa (edição errada)", () => {
    const r = consume(granted(base), { ...base, edition: "261113" }, ["youtube"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /edição errada/);
  });
  it("owner/comando: muda o hash do plano aprovado, e a task com outro comando não é criada", () => {
    const v = vertical();
    const other = buildVerticalManifest({
      aammdd: ED,
      items: [{ destination: "threads_profile", action: "pending_schedule", caption: "legenda do Threads" }],
      owners: [{ destination: "threads_profile", by: "agent-scheduled-task", command: `${TASK_CMD} --now` }],
      destinationAt: () => "2026-11-12T15:00:00.000Z",
      horizontalLink: () => "https://youtu.be/abc",
      metadata: { title: "Título do Short", description: "descrição do Short" },
      media: { ...media, captions_sha256: null },
      sources,
      publishCommand: "x",
    });
    assert.notEqual(
      sha256Hex(canonicalJson(v.destinations.find((d) => d.id === "threads_profile")!.owner)),
      sha256Hex(canonicalJson(other.destinations[0].owner)),
    );
    const r = checkTaskAuthorization(granted(v), { part: "vertical", destination: "threads_profile", command: `${TASK_CMD} --now` });
    assert.equal(r.ok, false);
  });
  it("sem mutação: consome", () => {
    assert.equal(consume(granted(base), horizontal({ generatedAt: at(3).toISOString() }), ["youtube"]).ok, true);
  });
});

describe("#12654 grant: confirmação explícita vinculada ao hash", () => {
  const m = horizontal();
  it("confirmação ausente ou vazia: recusa", () => {
    for (const confirmation of ["", "   "]) {
      const r = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation, now: T0 });
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, /confirmação explícita/);
    }
  });
  it("hash diferente do mostrado ao editor: recusa", () => {
    const r = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: "0".repeat(64), confirmation: CONFIRM, now: T0 });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /não é o aprovado/);
  });
  it("edição errada (manifesto de outra edição): recusa", () => {
    const r = grantVideoPublishAuthorization(emptyAuthorizationStore("261113"), { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now: T0 });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /edição 261112, não da 261113/);
  });
  it("plano sem o vídeo não é aprovável", () => {
    const noVideo = horizontal({ media: { ...media, video_sha256: null } });
    const r = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: noVideo, planSha256: planSha256(noVideo), confirmation: CONFIRM, now: T0 });
    assert.equal(r.ok, false);
  });
  it("grava confirmação, hash e dono; timer do 300 e destino já feito ficam sem autorização", () => {
    const store = granted(vertical());
    const ids = store.authorizations.map((a) => a.destination).sort();
    assert.deepEqual(ids, ["facebook", "threads_profile", "x", "youtube_shorts"]);
    for (const a of store.authorizations) {
      assert.equal(a.confirmation, CONFIRM);
      assert.equal(a.plan_sha256, planSha256(vertical()));
      assert.equal(a.status, "active");
    }
  });
});

describe("#12654 consumo: uso único, antes do 1º efeito, tudo ou nada", () => {
  it("sem autorização (confirmação ausente): recusa", () => {
    const r = consume(emptyAuthorizationStore(ED), horizontal(), ["youtube"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /sem autorização/);
  });
  it("autorização já consumida: a 2ª execução recusa (uso único)", () => {
    const first = consume(granted(horizontal()), horizontal(), ["youtube"]);
    assert.ok(first.ok);
    assert.equal(first.store.authorizations[0].status, "consumed");
    assert.equal(first.store.authorizations[0].consumed_pid, 4242);
    const second = consume(first.store, horizontal(), ["youtube"], at(9));
    assert.equal(second.ok, false);
    assert.match(second.ok ? "" : second.error, /já foi consumida.*uso único/);
  });
  it("tudo ou nada: um destino sem autorização segura a rodada e nada é consumido", () => {
    const v = vertical();
    const store = granted(v);
    const r = consume(store, v, ["youtube_shorts", "linkedin_profile"]);
    assert.equal(r.ok, false);
    assert.ok(store.authorizations.every((a) => a.status === "active"));
  });
  it("aprovações independentes: o horizontal não autoriza o vertical e vice-versa", () => {
    const store = granted(horizontal());
    assert.equal(consume(store, vertical(), ["youtube_shorts"]).ok, false);
    const both = granted(vertical(), store);
    const inv = invalidateVideoPublishAuthorization(both, { part: "horizontal", reason: "rejeitada", now: at(1) });
    assert.equal(consume(inv.store, horizontal(), ["youtube"], at(2)).ok, false);
    assert.equal(consume(inv.store, vertical(), ["youtube_shorts", "facebook"], at(2)).ok, true);
  });
});

describe("#12654 vertical: task one-shot e link do horizontal", () => {
  it("o destino adiado sai na task com o MESMO plano (ação/dono mudam, conteúdo não)", () => {
    const main = consume(granted(vertical()), vertical(), ["youtube_shorts", "facebook"]);
    assert.ok(main.ok);
    const atTask = vertical({ threadsAction: "publish" });
    // A ação e o modo mudam (pending_schedule para X → publish na hora): a projeção crua difere...
    assert.notEqual(destinationBindingSha256(atTask, "threads_profile"), destinationBindingSha256(vertical(), "threads_profile"));
    // ...e a task antes de X é recusada (decisão B: só passa com o relógio em >= X).
    const early = consume(main.store, atTask, ["threads_profile"], at(600));
    assert.equal(early.ok, false);
    assert.match(early.ok ? "" : early.error, /só publica a partir de 2026-11-12T15:00/);
    const task = consume(main.store, atTask, ["threads_profile"], AFTER_THREADS);
    assert.ok(task.ok, task.ok ? "" : task.error);
  });
  it("legenda do adiado mudou até a hora da task: recusa", () => {
    const store = granted(vertical());
    const r = consume(store, vertical({ threadsAction: "publish", caption: "legenda reescrita" }), ["threads_profile"], AFTER_THREADS);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /content\.caption/);
  });
  it("URL do horizontal gerada depois da aprovação do vertical não muda o plano em silêncio", () => {
    const approvedWithout = vertical({ horizontalLink: null });
    const store = granted(approvedWithout);
    const r = consume(store, vertical({ horizontalLink: "https://youtu.be/novo" }), ["facebook"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /horizontal_link/);
    // Regenerado e aprovado de novo (sem consumo nem invalidação antes): consome.
    const re = granted(vertical({ horizontalLink: "https://youtu.be/novo" }), store, at(1));
    assert.equal(consume(re, vertical({ horizontalLink: "https://youtu.be/novo" }), ["facebook"], at(2)).ok, true);
  });
  it("destino sem texto no plano (skip_late) fica preso às fontes editoriais", () => {
    const store = granted(vertical());
    // Na execução (--only x --now) o texto já existe; o vínculo segue pelas fontes.
    const run = buildVerticalManifest({
      aammdd: ED,
      items: [{ destination: "x", action: "publish", caption: "texto do X", scheduledAt: null }],
      owners: [],
      destinationAt: () => "2026-11-12T15:00:00.000Z",
      horizontalLink: () => null,
      metadata: { title: "Título do Short", description: "descrição do Short" },
      media: { ...media, captions_sha256: null },
      sources,
      publishCommand: "x",
    });
    assert.ok(consume(store, run, ["x"]).ok);
    const changed = { ...run, sources: { ...sources, social: sha256Hex("03-social reescrito") } };
    const r = consume(store, changed, ["x"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /sources\.social/);
  });
  it("shortsRunDestinations: só publish/enqueue/buffer agem na rodada", () => {
    const items = [
      { destination: "a", mode: "api", action: "publish", caption: "", scheduledAt: null },
      { destination: "b", mode: "api", action: "pending_schedule", caption: "", scheduledAt: "x", detail: "" },
      { destination: "c", mode: "guided", action: "buffer", caption: "", scheduledAt: null, detail: "" },
      { destination: "d", mode: "api", action: "skip_done" },
    ] as Parameters<typeof shortsRunDestinations>[0];
    assert.deepEqual(shortsRunDestinations(items), ["a", "c"]);
  });
  it("shortsRunDestinations: o repost guiado entra só quando vai de fato à fila do Worker", () => {
    const repost = { destination: "linkedin_page_repost", mode: "guided", action: "guided", detail: "", at: "2026-11-12T16:00:00.000Z" };
    const profile = { destination: "linkedin_profile", mode: "api", action: "publish", caption: "", scheduledAt: null };
    const items = [repost] as Parameters<typeof shortsRunDestinations>[0];
    assert.deepEqual(shortsRunDestinations(items), [], "sem Worker: segue guiado, nenhuma escrita externa");
    assert.deepEqual(shortsRunDestinations(items, { repostViaWorker: true }), [], "sem a URN do perfil: não enfileira");
    assert.deepEqual(shortsRunDestinations(items, { repostViaWorker: true, profileUrnKnown: true }), ["linkedin_page_repost"]);
    assert.deepEqual(
      shortsRunDestinations([profile, repost] as Parameters<typeof shortsRunDestinations>[0], { repostViaWorker: true }),
      ["linkedin_profile", "linkedin_page_repost"],
      "o perfil sai nesta rodada: o repost vai à fila e consome a autorização dele",
    );
  });
});

describe("#12654 timer (task one-shot) só é criado com autorização", () => {
  it("sem autorização: não cria", () => {
    const r = checkTaskAuthorization(emptyAuthorizationStore(ED), { part: "vertical", destination: "threads_profile", command: TASK_CMD });
    assert.equal(r.ok, false);
  });
  it("com autorização ativa e o comando aprovado: cria", () => {
    assert.ok(checkTaskAuthorization(granted(vertical()), { part: "vertical", destination: "threads_profile", command: `  ${TASK_CMD}  ` }).ok);
  });
  it("dono aprovado não é task (destino da rodada principal): não cria", () => {
    const r = checkTaskAuthorization(granted(vertical()), { part: "vertical", destination: "facebook", command: TASK_CMD });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /não uma task one-shot/);
  });
  it("autorização invalidada ou consumida: não cria", () => {
    const inv = invalidateVideoPublishAuthorization(granted(vertical()), { part: "vertical", reason: "interrompida", now: at(1) }).store;
    assert.equal(checkTaskAuthorization(inv, { part: "vertical", destination: "threads_profile", command: TASK_CMD }).ok, false);
  });
});

describe("#12654 invalidação, rejeição e retry (caminho A)", () => {
  it("invalidação registrada derruba as ativas da parte e o publisher recusa", () => {
    const { store, invalidated } = invalidateVideoPublishAuthorization(granted(horizontal()), { part: "horizontal", reason: "chamada interrompida", now: at(1) });
    assert.deepEqual(invalidated.map((a) => a.destination), ["youtube"]);
    const r = consume(store, horizontal(), ["youtube"], at(2));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /invalidada .*chamada interrompida/);
  });
  it("rejeição ANTES de o processo começar (nenhuma ativa) também vira barreira de retry", () => {
    const { store, invalidated } = invalidateVideoPublishAuthorization(emptyAuthorizationStore(ED), { part: "vertical", reason: "editor disse não", now: at(1) });
    assert.equal(invalidated.length, 0);
    const r = grantVideoPublishAuthorization(store, { manifest: vertical(), planSha256: planSha256(vertical()), confirmation: CONFIRM, now: at(2) });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /releia o registro/);
  });
  it("retry depois de invalidação: exige registry-status gravado que cubra o evento", () => {
    const inv = invalidateVideoPublishAuthorization(granted(horizontal()), { part: "horizontal", reason: "rejeitada", now: at(10) }).store;
    const tryGrant = (s: VideoPublishAuthorizationStore) =>
      grantVideoPublishAuthorization(s, { manifest: horizontal(), planSha256: planSha256(horizontal()), confirmation: "pode publicar de novo", now: at(30) });
    assert.equal(tryGrant(inv).ok, false);
    // releitura com --since DEPOIS do evento não cobre a janela
    assert.equal(tryGrant(recordRegistryCheck(inv, { now: at(20), since: at(15).toISOString(), verdict: "nothing-since", registered: [] })).ok, false);
    // releitura antes do evento não vale
    assert.equal(tryGrant(recordRegistryCheck(inv, { now: at(5), since: at(0).toISOString(), verdict: "nothing-since", registered: [] })).ok, false);
    // ilegível: conferir as contas antes
    assert.equal(tryGrant(recordRegistryCheck(inv, { now: at(20), since: at(9).toISOString(), verdict: "unreadable", registered: [] })).ok, false);
    // o destino saiu (processo sobrevivente): nunca de novo
    const out = tryGrant(recordRegistryCheck(inv, { now: at(20), since: at(9).toISOString(), verdict: "registered-since", registered: ["youtube"] }));
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, /nunca publicar de novo/);
    // releitura certa: nova autorização
    const ok = tryGrant(recordRegistryCheck(inv, { now: at(20), since: at(9).toISOString(), verdict: "nothing-since", registered: [] }));
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    assert.equal(consume(ok.store, horizontal(), ["youtube"], at(31)).ok, true);
  });
  it("retry depois de consumo (execução que voltou interrompida) também exige a releitura", () => {
    const used = consume(granted(horizontal()), horizontal(), ["youtube"]);
    assert.ok(used.ok);
    const r = grantVideoPublishAuthorization(used.store, { manifest: horizontal(), planSha256: planSha256(horizontal()), confirmation: CONFIRM, now: at(20) });
    assert.equal(r.ok, false);
  });
  it("reaprovar antes de usar (plano mudou, nada executado) substitui sem exigir releitura", () => {
    const s1 = granted(horizontal());
    const changed = horizontal({ metadata: { title: "Outro", description: "d", tags: [] } });
    const s2 = granted(changed, s1, at(1));
    assert.equal(s2.authorizations.filter((a) => a.status === "active").length, 1);
    const first = s2.authorizations[0];
    assert.equal(first.status === "invalidated" ? first.invalidated_kind : first.status, "superseded");
    assert.equal(consume(s2, horizontal(), ["youtube"], at(2)).ok, false);
    assert.equal(consume(s2, changed, ["youtube"], at(2)).ok, true);
  });
});

describe("#12654 CLIs (registro durável na pasta da edição)", () => {
  let dir: string;
  const logs: string[] = [];
  const errs: string[] = [];
  const io = (now: Date) => ({ log: (l: string) => logs.push(l), err: (l: string) => errs.push(l), now: () => now });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-12654-"));
    logs.length = 0;
    errs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("grant → check-task → invalidate → grant recusado → registry-status --record → grant ok", () => {
    const m = vertical();
    writeVideoPlanManifest(dir, m);
    const h = planSha256(m);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", h, "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    assert.ok(existsSync(authorizationStorePath(dir)));
    assert.equal(authorizeMain(["check-task", ED, "--part", "vertical", "--destination", "threads_profile", "--command", TASK_CMD, "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    assert.equal(authorizeMain(["invalidate", ED, "--part", "vertical", "--reason", "User rejected tool use", "--edition-dir", dir], io(at(10))), 0);
    assert.equal(authorizeMain(["check-task", ED, "--part", "vertical", "--destination", "threads_profile", "--command", TASK_CMD, "--edition-dir", dir], io(at(11))), 1);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", h, "--confirmation", CONFIRM, "--edition-dir", dir], io(at(12))), 1);
    assert.match(errs.join("\n"), /releia o registro/);

    // releitura gravada (registros vazios → nothing-since)
    const origErr = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    let code: number;
    try {
      assert.equal(registryStatusMain([ED, "--edition-dir", dir, "--record"], undefined, () => at(13)), 2, "--record sem --since é uso");
      code = registryStatusMain([ED, "--edition-dir", dir, "--since", at(9).toISOString(), "--record"], undefined, () => at(13));
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    assert.equal(code, 0);
    const store = readAuthorizationStore(dir, ED);
    assert.ok(store.events.some((e) => e.kind === "registry-check" && e.verdict === "nothing-since"));
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", h, "--confirmation", "sim, pode publicar", "--edition-dir", dir], io(at(14))), 0, errs.join("\n"));
  });

  it("grant sem manifesto do dry-run, sem --confirmation ou edição inválida: recusa/uso", () => {
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", "ab", "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 1);
    writeVideoPlanManifest(dir, horizontal());
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", planSha256(horizontal()), "--edition-dir", dir], io(T0)), 2);
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", planSha256(horizontal()), "--confirmation", "", "--edition-dir", dir], io(T0)), 1);
    assert.equal(authorizeMain(["grant", "2611", "--part", "horizontal"], io(T0)), 2);
  });

  it("consumeBeforeExternalEffects grava o consumo no disco e recusa registro ilegível (falha fechada)", () => {
    const m = horizontal();
    writeVideoPlanManifest(dir, m);
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", planSha256(m), "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 0);
    const r = consumeBeforeExternalEffects({ editionDir: dir, edition: ED, manifest: m, destinations: ["youtube"], now: at(1), by: "t" });
    assert.ok(r.ok);
    assert.equal(readAuthorizationStore(dir, ED).authorizations[0].status, "consumed");
    const again = consumeBeforeExternalEffects({ editionDir: dir, edition: ED, manifest: m, destinations: ["youtube"], now: at(2), by: "t" });
    assert.equal(again.ok, false);
    writeFileSync(authorizationStorePath(dir), "{ quebrado");
    const broken = consumeBeforeExternalEffects({ editionDir: dir, edition: ED, manifest: m, destinations: ["youtube"], now: at(3), by: "t" });
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? "" : broken.error, /ilegível/);
  });

  it("registro de outra edição na pasta: recusa", () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(authorizationStorePath(dir), JSON.stringify(emptyAuthorizationStore("261113")));
    assert.throws(() => readAuthorizationStore(dir, ED), /é da edição 261113/);
  });

  it("readVideoPlanSources: o link do horizontal entra nas fontes", () => {
    const before = readVideoPlanSources(dir);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://youtu.be/abc\n");
    const after = readVideoPlanSources(dir);
    assert.equal(before.horizontal_link, null);
    assert.equal(after.horizontal_link, sha256Hex("https://youtu.be/abc\n"));
  });
});

describe("#12654 publishers recusam sem autorização, antes de credencial ou rede", () => {
  const ROOT = join(import.meta.dirname, "..");
  const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;
  it("publish-youtube --upload --confirm-publish com vídeo e sem grant: exit 2, nada enviado; dry-run grava o manifesto e imprime o hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-12654-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
      writeFileSync(join(dir, `diaria-comentada-${ED}.mp4`), "bytes do vídeo");
      const env = { ...process.env, YOUTUBE_REFRESH_TOKEN: "", YOUTUBE_CHANNEL_ID: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" };
      const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "publish-youtube.ts"), ED, "--edition-dir", dir, "--no-captions", ...args], { encoding: "utf8", cwd: ROOT, env });
      const up = cli(["--upload", "--confirm-publish", ED]);
      assert.equal(up.status, 2, up.stderr);
      assert.match(up.stderr, /recusada pela autorização do plano \(#12654\)/);
      assert.match(up.stderr, /Nada foi enviado/);
      assert.ok(!existsSync(join(dir, "_internal", "05-youtube-published.json")));

      const dry = cli(["--dry-run"]);
      assert.equal(dry.status, 0, dry.stderr);
      const out = JSON.parse(dry.stdout) as { plan_sha256: string; plan_manifest: VideoPlanManifest };
      assert.match(out.plan_sha256, /^[0-9a-f]{64}$/);
      const onDisk = JSON.parse(readFileSync(join(dir, "_internal", "video-publish-plan.horizontal.json"), "utf8")) as VideoPlanManifest;
      assert.equal(planSha256(onDisk), out.plan_sha256);
      assert.equal(onDisk.media.video_sha256, sha256Hex("bytes do vídeo"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12654 status desconhecido falha fechado (P1)", () => {
  it("autorização com status fora da união: o consumo recusa e nada é consumido", () => {
    const store = granted(horizontal());
    const bogus = { ...store, authorizations: store.authorizations.map((a) => ({ ...a, status: "bogus" }) as unknown as VideoPublishAuthorization) };
    const r = consume(bogus, horizontal(), ["youtube"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /estado desconhecido \("bogus"\)/);
  });
  it("registro em disco com status desconhecido: a leitura recusa (e o consumo também)", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-bogus-12654-"));
    try {
      const store = granted(horizontal());
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(authorizationStorePath(dir), JSON.stringify({ ...store, authorizations: store.authorizations.map((a) => ({ ...a, status: "bogus" })) }));
      assert.throws(() => readAuthorizationStore(dir, ED), /status "bogus"/);
      const r = consumeBeforeExternalEffects({ editionDir: dir, edition: ED, manifest: horizontal(), destinations: ["youtube"], now: at(1), by: "t" });
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, /indisponível.*bogus/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12654 barreira de retry: todos os eventos cobertos, instante legível, processo morto, mesma máquina", () => {
  const tryGrant = (s: VideoPublishAuthorizationStore, extra: Partial<Parameters<typeof grantVideoPublishAuthorization>[1]> = {}) =>
    grantVideoPublishAuthorization(s, { manifest: horizontal(), planSha256: planSha256(horizontal()), confirmation: CONFIRM, now: at(60), isPidAlive: () => false, ...extra });
  const check = (s: VideoPublishAuthorizationStore, now: number, since: number, over: Partial<Parameters<typeof recordRegistryCheck>[1]> = {}) =>
    recordRegistryCheck(s, { now: at(now), since: at(since).toISOString(), verdict: "nothing-since", registered: [], ...over });

  it("dois eventos: a releitura que cobre só o mais recente não basta; o --since vai até o mais antigo não coberto", () => {
    let s = invalidateVideoPublishAuthorization(granted(horizontal()), { part: "horizontal", reason: "rejeitada", now: at(10) }).store;
    s = invalidateVideoPublishAuthorization(s, { part: "horizontal", reason: "rejeitada de novo", now: at(30) }).store;
    const onlyRecent = tryGrant(check(s, 35, 25));
    assert.equal(onlyRecent.ok, false);
    assert.match(onlyRecent.ok ? "" : onlyRecent.error, new RegExp(`--since ${at(10).toISOString().replace(/[.]/g, "\\.")}`));
    assert.ok(tryGrant(check(s, 40, 5)).ok, "uma releitura com since até o mais antigo cobre os dois");
    assert.ok(tryGrant(check(check(s, 20, 9), 35, 25)).ok, "releituras separadas, cada evento coberto por uma");
  });
  it("evento com instante ilegível: recusa", () => {
    const s = invalidateVideoPublishAuthorization(emptyAuthorizationStore(ED), { part: "horizontal", reason: "x", now: at(10) }).store;
    const broken = { ...s, events: s.events.map((e) => ({ ...e, at: "lixo" })) };
    const r = tryGrant(check(broken, 20, 0));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /instante ilegível/);
  });
  it("processo que consumiu ainda vivo nesta máquina: o retry recusa; morto, autoriza", () => {
    const used = consume(granted(horizontal()), horizontal(), ["youtube"], at(5));
    assert.ok(used.ok);
    const s = check(used.store, 20, 4);
    const alive = tryGrant(s, { isPidAlive: (pid) => pid === 4242 });
    assert.equal(alive.ok, false);
    assert.match(alive.ok ? "" : alive.error, /processo 4242 .*ainda está vivo/);
    assert.ok(tryGrant(s).ok);
  });
  it("consumo gravado em outra máquina: o grant de retry roda nela", () => {
    const used = consume(granted(horizontal()), horizontal(), ["youtube"], at(5));
    assert.ok(used.ok);
    const r = tryGrant(check(used.store, 20, 4), { host: "outra-maquina" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /consumida na máquina .*roda nela/);
  });
  it("estado incerto (marcador pending) só passa com --override-uncertain; saída registrada nunca", () => {
    const s = invalidateVideoPublishAuthorization(granted(horizontal()), { part: "horizontal", reason: "interrompida", now: at(10) }).store;
    const uncertain = check(s, 20, 9, { verdict: "registered-since", registered: ["youtube"], uncertain: ["youtube"] });
    const without = tryGrant(uncertain);
    assert.equal(without.ok, false);
    assert.match(without.ok ? "" : without.error, /--override-uncertain/);
    const withOverride = tryGrant(uncertain, { overrideUncertain: "editor conferiu o Studio: nenhum vídeo da edição" });
    assert.ok(withOverride.ok, withOverride.ok ? "" : withOverride.error);
    assert.equal(withOverride.value[0].override_uncertain, "editor conferiu o Studio: nenhum vídeo da edição");
    const done = check(s, 20, 9, { verdict: "registered-since", registered: ["youtube"] });
    assert.equal(tryGrant(done, { overrideUncertain: "conferi" }).ok, false);
  });
});

describe("#12654 máquina e dono no consumo", () => {
  it("consumo em máquina diferente da do grant: recusa", () => {
    const r = consumeVideoPublishAuthorization(granted(horizontal()), { edition: ED, manifest: horizontal(), destinations: ["youtube"], now: at(5), by: "t", host: "outra" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /máquina .*lock do registro é por máquina/);
  });
  it("commandMatchesOwner: mesmo script e flags; --only do dono exato; dono sem --only aceita subconjunto; comando de skill cai na rodada principal", () => {
    const owner = (command?: string) => ({ by: "agent" as const, ...(command ? { command } : {}) });
    assert.equal(commandMatchesOwner(`${MAIN_CMD}`, owner(MAIN_CMD), "facebook"), null);
    assert.equal(commandMatchesOwner(`npx tsx /abs/path/scripts/publish-shorts.ts ${ED} --edition-dir /x --allow-unwatched-dir --publish --confirm-publish ${ED}`, owner(MAIN_CMD), "facebook"), null);
    assert.equal(commandMatchesOwner(`${MAIN_CMD} --only facebook`, owner(MAIN_CMD), "facebook"), null);
    assert.match(commandMatchesOwner(`${MAIN_CMD} --only x`, owner(MAIN_CMD), "facebook") ?? "", /não inclui facebook/);
    assert.match(commandMatchesOwner(`${MAIN_CMD} --now`, owner(MAIN_CMD), "facebook") ?? "", /flags/);
    assert.match(commandMatchesOwner(MAIN_CMD, owner(TASK_CMD), "threads_profile") ?? "", /--only/);
    assert.equal(commandMatchesOwner(MAIN_CMD, owner(`/diaria-publica-video ${ED} --so vertical`), "linkedin_page_repost", MAIN_CMD), null);
    assert.match(commandMatchesOwner(`npx tsx scripts/publish-youtube.ts ${ED} --upload`, owner(MAIN_CMD), "facebook") ?? "", /não é o do dono/);
  });
  it("consumo com o comando efetivo diferente do dono aprovado: recusa e nada é consumido", () => {
    const v = vertical();
    const store = granted(v);
    const r = consumeVideoPublishAuthorization(store, { edition: ED, manifest: v, destinations: ["facebook"], now: at(5), by: "t", command: `${MAIN_CMD} --now`, fallbackCommand: MAIN_CMD });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /flags do comando efetivo/);
    const ok = consumeVideoPublishAuthorization(store, { edition: ED, manifest: v, destinations: ["facebook"], now: at(5), by: "t", command: MAIN_CMD, fallbackCommand: MAIN_CMD });
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
  });
  it("destino com texto no plano: a recusa não lista sources.*", () => {
    const store = granted(vertical());
    const changed = vertical({ caption: "outra legenda", sourcesOver: { social: sha256Hex("03-social novo") } });
    const r = consume(store, changed, ["threads_profile"], AFTER_THREADS);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.ok ? "" : r.error, /sources\./);
    assert.match(r.ok ? "" : r.error, /content\.caption/);
  });
});

describe("#12654 mutação de campos do vertical", () => {
  const base = vertical();
  const cases: Array<[string, VideoPlanManifest, string]> = [
    ["media.video_sha256", vertical({ mediaOver: { video_sha256: sha256Hex("outro vertical") } }), "facebook"],
    ["media.cover_sha256", vertical({ mediaOver: { cover_sha256: sha256Hex("outra capa") } }), "facebook"],
    ["destinations[facebook].content.horizontal_link", vertical({ horizontalLink: "https://youtu.be/outro" }), "facebook"],
    ["destinations[threads_profile].content.caption", vertical({ caption: "outra legenda" }), "threads_profile"],
    ["metadata.title", { ...base, metadata: { ...base.metadata, title: "Outro título do Short" } }, "youtube_shorts"],
    ["metadata.description", { ...base, metadata: { ...base.metadata, description: "outra" } }, "youtube_shorts"],
    ["destinations[facebook].at", { ...base, destinations: base.destinations.map((d) => (d.id === "facebook" ? { ...d, at: "2026-11-12T18:00:00.000Z" } : d)) }, "facebook"],
    ["destinations[facebook].effective_at", { ...base, destinations: base.destinations.map((d) => (d.id === "facebook" ? { ...d, effective_at: "2026-11-12T18:00:00.000Z" } : d)) }, "facebook"],
  ];
  for (const [field, mutated, dest] of cases) {
    it(`${field}: o consumo de ${dest} recusa nomeando o campo`, () => {
      const r = consume(granted(base), mutated, [dest], AFTER_THREADS);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, new RegExp(field.replace(/[.[\]]/g, "\\$&")));
    });
  }
});

describe("#12654 estabilidade do binding com o planShortsPublish real (decisão B)", () => {
  const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo da OpenAI gastou o saldo de terceiros. O caso foi descoberto depois.

Por que isso importa: porque sim.
`;
  const AAMMDD = "261022";
  const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
  const shorts = { facebook_pages: [], instagram: false, linkedin_profile: true, linkedin_page_repost: false, x: true, threads_profile: false, tiktok: false, schedule: SCHEDULE };
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  const base = {
    aammdd: AAMMDD,
    reviewedMd: REVIEWED,
    config: { publishing: { shorts } },
    pages: [page("diaria")],
    instagramReady: false,
    published: { aammdd: AAMMDD, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar",
    threadsPersonal: { ready: true } as const,
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
  };
  const NIGHT = new Date("2026-10-22T01:00:00Z"); // 22:00 BRT de D-1
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bind-12654-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const manifestAt = (now: Date, extra: { only?: string[]; forceNow?: boolean } = {}) =>
    buildShortsPlanManifest(planShortsPublish({ ...base, now, ...(extra.only ? { only: extra.only } : {}), ...(extra.forceNow ? { forceNow: true } : {}) }), {
      editionDir: dir,
      videoBytes: Buffer.from("vertical"),
      coverBytes: Buffer.from("capa"),
    });
  const grantAt = (m: VideoPlanManifest) => {
    const r = grantVideoPublishAuthorization(emptyAuthorizationStore(AAMMDD), { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now: NIGHT, isPidAlive: () => false });
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r.store;
  };
  const consumeAt = (store: VideoPublishAuthorizationStore, m: VideoPlanManifest, dest: string, now: Date, command: string, forceNow = false) =>
    consumeVideoPublishAuthorization(store, { edition: AAMMDD, manifest: m, destinations: [dest], now, by: "t", command, fallbackCommand: shortsMainPublishCommand(AAMMDD), forceNow });

  it("LinkedIn pending_schedule aprovado → publish na task: passa só com o relógio em >= X", () => {
    const approved = manifestAt(NIGHT);
    const li = approved.destinations.find((d) => d.id === "linkedin_profile")!;
    assert.equal(li.action, "pending_schedule");
    assert.match(li.effective_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const store = grantAt(approved);
    const X = new Date(Date.parse(li.effective_at!));
    const taskCmd = li.owner.command!;
    const atX = new Date(X.getTime() + 60_000);
    const runAtX = manifestAt(atX, { only: ["linkedin_profile"] });
    assert.equal(runAtX.destinations.find((d) => d.id === "linkedin_profile")!.action, "publish");
    const ok = consumeAt(store, runAtX, "linkedin_profile", atX, taskCmd);
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    // 5 min antes de X o plano já sai "na hora" (limiar de 10 min), mas a task não passa.
    const early = new Date(X.getTime() - 5 * 60_000);
    const r = consumeAt(store, manifestAt(early, { only: ["linkedin_profile"] }), "linkedin_profile", early, taskCmd);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /só publica a partir de/);
  });

  it("LinkedIn aprovado agendado, atrasado depois e publicado com --now: recusa (decisão B)", () => {
    const approved = manifestAt(NIGHT);
    const store = grantAt(approved);
    const late = new Date("2026-10-22T20:00:00Z");
    assert.equal(manifestAt(late).destinations.find((d) => d.id === "linkedin_profile")!.action, "skip_late");
    const run = manifestAt(late, { only: ["linkedin_profile"], forceNow: true });
    // Pela projeção (decisão B), mesmo sem conferir o comando:
    const byMode = consumeVideoPublishAuthorization(store, { edition: AAMMDD, manifest: run, destinations: ["linkedin_profile"], now: late, by: "t", forceNow: true });
    assert.equal(byMode.ok, false);
    assert.match(byMode.ok ? "" : byMode.error, /--now recusado \(decisão B/);
    // E pelo dono: o --now não é o comando da task aprovada.
    const r = consumeAt(store, run, "linkedin_profile", late, `npx tsx scripts/publish-shorts.ts ${AAMMDD} --only linkedin_profile --publish --now --confirm-publish ${AAMMDD}`, true);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /flags do comando efetivo/);
  });

  it("X aprovado agendado (Buffer) e rodado com --now depois do horário: recusa pela decisão B, mesmo com o comando certo", () => {
    const approved = manifestAt(NIGHT);
    const x = approved.destinations.find((d) => d.id === "x")!;
    assert.equal(x.action, "buffer");
    assert.notEqual(x.effective_at, "now");
    const store = grantAt(approved);
    const later = new Date(Date.parse(x.effective_at!) + 60 * 60_000);
    const run = manifestAt(later, { only: ["x"], forceNow: true });
    assert.equal(run.destinations.find((d) => d.id === "x")!.effective_at, "now");
    const r = consumeAt(store, run, "x", later, shortsMainPublishCommand(AAMMDD), true);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /--now recusado \(decisão B/);
  });

  it("destino aprovado já atrasado (skip_late, sai na hora) aceita o --now do dono", () => {
    const late = new Date("2026-10-22T20:00:00Z");
    const approved = manifestAt(late);
    const li = approved.destinations.find((d) => d.id === "linkedin_profile")!;
    assert.equal(li.action, "skip_late");
    assert.equal(li.effective_at, "now");
    const store = grantVideoPublishAuthorization(emptyAuthorizationStore(AAMMDD), { manifest: approved, planSha256: planSha256(approved), confirmation: CONFIRM, now: late, isPidAlive: () => false });
    assert.ok(store.ok);
    const later = new Date(late.getTime() + 60_000);
    const r = consumeAt(store.store, manifestAt(later, { only: ["linkedin_profile"], forceNow: true }), "linkedin_profile", later, li.owner.command!, true);
    assert.ok(r.ok, r.ok ? "" : r.error);
  });
});

describe("#12654 tudo ou nada no disco e CLIs (only, invalidate all, schema)", () => {
  let dir: string;
  const errs: string[] = [];
  const io = (now: Date) => ({ log: () => {}, err: (l: string) => errs.push(l), now: () => now });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth2-12654-"));
    errs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("um destino sem autorização: o arquivo em disco fica byte a byte igual (nada consumido)", () => {
    const v = vertical();
    writeVideoPlanManifest(dir, v);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", planSha256(v), "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    const before = readFileSync(authorizationStorePath(dir), "utf8");
    const r = consumeBeforeExternalEffects({ editionDir: dir, edition: ED, manifest: v, destinations: ["youtube_shorts", "linkedin_profile"], now: at(5), by: "t" });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(authorizationStorePath(dir), "utf8"), before);
    assert.ok(readAuthorizationStore(dir, ED).authorizations.every((a) => a.status === "active"));
  });

  it("grant --only autoriza só os destinos pedidos; --only fora dos autorizáveis recusa", () => {
    const v = vertical();
    writeVideoPlanManifest(dir, v);
    const h = planSha256(v);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", h, "--confirmation", CONFIRM, "--only", "linkedin_profile", "--edition-dir", dir], io(T0)), 1);
    assert.match(errs.join("\n"), /--only fora dos destinos autorizáveis/);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", h, "--confirmation", CONFIRM, "--only", "facebook,x", "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    assert.deepEqual(readAuthorizationStore(dir, ED).authorizations.map((a) => a.destination).sort(), ["facebook", "x"]);
  });

  it("invalidate --part all derruba as ativas das duas partes", () => {
    const v = vertical();
    const hz = horizontal();
    writeVideoPlanManifest(dir, v);
    writeVideoPlanManifest(dir, hz);
    assert.equal(authorizeMain(["grant", ED, "--part", "vertical", "--plan-sha256", planSha256(v), "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", planSha256(hz), "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 0, errs.join("\n"));
    assert.equal(authorizeMain(["invalidate", ED, "--part", "all", "--reason", "editor disse não", "--edition-dir", dir], io(at(1))), 0);
    const s = readAuthorizationStore(dir, ED);
    assert.ok(s.authorizations.length >= 5);
    assert.ok(s.authorizations.every((a) => a.status === "invalidated"));
  });

  it("invalidate que não grava: exit 1 e o aviso de autorização AINDA ATIVA", () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(authorizationStorePath(dir), "{ quebrado");
    assert.equal(authorizeMain(["invalidate", ED, "--part", "vertical", "--reason", "interrompida", "--edition-dir", dir], io(at(1))), 1);
    assert.match(errs.join("\n"), /AINDA ATIVA.*Não chame o publisher/);
  });

  it("schema inválido: registro de autorização e manifesto do dry-run recusam", () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(authorizationStorePath(dir), JSON.stringify({ ...emptyAuthorizationStore(ED), schema: "outro/v9" }));
    assert.equal(authorizeMain(["status", ED, "--edition-dir", dir], io(T0)), 1);
    assert.match(errs.join("\n"), /formato inesperado/);
    rmSync(authorizationStorePath(dir));
    writeFileSync(join(dir, "_internal", "video-publish-plan.horizontal.json"), JSON.stringify({ ...horizontal(), schema: "diaria-video-publish-plan/v0" }));
    assert.equal(authorizeMain(["grant", ED, "--part", "horizontal", "--plan-sha256", planSha256(horizontal()), "--confirmation", CONFIRM, "--edition-dir", dir], io(T0)), 1);
    assert.match(errs.join("\n"), /schema/);
  });
});

describe("#12654 escopo: corte e timers do 300 ficam fora da trava", () => {
  it("dono timer-300 nunca recebe autorização (decisão A)", () => {
    const store = granted(vertical());
    assert.ok(!store.authorizations.some((a) => a.destination === "linkedin_profile"));
  });
  it("publish-shorts: a trava só vale no modo edição da rodada principal (nem corte, nem rodada de timer)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "publish-shorts.ts"), "utf8");
    assert.match(src, /const planGated = !corte && writer === "main";/);
  });
});

describe("#12654 publish-shorts --publish por processo real (sem rede)", () => {
  const ROOT = join(import.meta.dirname, "..");
  const SED = "261112";
  const REVIEWED = `DESTAQUE 1 | SEGURANÇA

[IA ladra? O cofre que o modelo abriu](https://fonte.exemplo.com/artigo)

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa: porque sim.
`;
  // Credencial falsa só da página do Facebook (o destino que age); todo o resto vazio: sem Worker, R2, Instagram,
  // YouTube ou LinkedIn. A recusa vem antes de qualquer escrita externa; nenhum teste chega a uma API.
  const env = {
    ...process.env,
    DIARIA_LINKEDIN_CRON_URL: "", DIARIA_LINKEDIN_CRON_TOKEN: "", FACEBOOK_PAGE_ID: "123", FACEBOOK_PAGE_ACCESS_TOKEN: "fake",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "", INSTAGRAM_ACCESS_TOKEN: "", YOUTUBE_REFRESH_TOKEN: "", YOUTUBE_CHANNEL_ID: "",
    R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "", LINKEDIN_PERSONAL_ACCESS_TOKEN: "",
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ps-12654-"));
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
    writeFileSync(join(dir, `diaria-comentada-${SED}-short.mp4`), "bytes do vertical");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "publish-shorts.ts"), SED, "--edition-dir", dir, "--allow-unwatched-dir", ...args], { encoding: "utf8", cwd: ROOT, env });

  it("--publish confirmado e sem grant: exit 2, nada enviado, nenhum registro", () => {
    const r = cli(["--only", "facebook:diaria", "--publish", "--confirm-publish", SED]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /recusada pela autorização do plano \(#12654\): facebook:diaria: sem autorização/);
    assert.ok(!existsSync(join(dir, "_internal", "06-shorts-published.json")));
  });

  it("dry-run grava o manifesto do vertical; grant dele; vídeo trocado depois: --publish recusa nomeando o vídeo", () => {
    const dry = cli([]);
    assert.equal(dry.status, 0, dry.stderr);
    const out = JSON.parse(dry.stdout) as { plan_sha256: string };
    const onDisk = JSON.parse(readFileSync(join(dir, "_internal", "video-publish-plan.vertical.json"), "utf8")) as VideoPlanManifest;
    assert.equal(planSha256(onDisk), out.plan_sha256);
    assert.equal(onDisk.media.video_sha256, sha256Hex("bytes do vertical"));
    assert.ok(onDisk.destinations.some((d) => d.id === "facebook:diaria"));
    const io = { log: () => {}, err: () => {}, now: () => new Date() };
    assert.equal(authorizeMain(["grant", SED, "--part", "vertical", "--plan-sha256", out.plan_sha256, "--confirmation", CONFIRM, "--only", "facebook:diaria", "--edition-dir", dir], io), 0);
    writeFileSync(join(dir, `diaria-comentada-${SED}-short.mp4`), "OUTRO vertical");
    const r = cli(["--only", "facebook:diaria", "--publish", "--confirm-publish", SED]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /media\.video_sha256/);
    assert.equal(readAuthorizationStore(dir, SED).authorizations[0].status, "active", "recusa não consome");
  });
});
