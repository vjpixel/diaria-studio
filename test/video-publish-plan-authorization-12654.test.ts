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
  type VideoPublishAuthorizationStore,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import { main as authorizeMain } from "../scripts/video-publish-authorize.ts";
import { main as registryStatusMain } from "../scripts/video-publish-registry-status.ts";
import { shortsRunDestinations } from "../scripts/publish-shorts.ts";

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

/** Plano do vertical na aprovação: Shorts e Facebook saem na rodada; Threads adiado (task); LinkedIn pelo timer; X atrasado. */
function vertical(opts: { threadsAction?: "pending_schedule" | "publish"; horizontalLink?: string | null; sourcesOver?: Record<string, string | null>; caption?: string; mediaOver?: Partial<typeof media> } = {}): VideoPlanManifest {
  const threadsAction = opts.threadsAction ?? "pending_schedule";
  const caption = opts.caption ?? "legenda do Threads";
  return buildVerticalManifest({
    aammdd: ED,
    items: [
      { destination: "youtube_shorts", action: "publish", caption: "descrição do Short", title: "Título do Short" },
      { destination: "facebook", action: "publish", caption: "legenda do Facebook" },
      { destination: "threads_profile", action: threadsAction, caption },
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
  const r = grantVideoPublishAuthorization(store, { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now });
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
    assert.equal(destinationBindingSha256(atTask, "threads_profile"), destinationBindingSha256(vertical(), "threads_profile"));
    const task = consume(main.store, atTask, ["threads_profile"], at(600));
    assert.ok(task.ok, task.ok ? "" : task.error);
  });
  it("legenda do adiado mudou até a hora da task: recusa", () => {
    const store = granted(vertical());
    const r = consume(store, vertical({ threadsAction: "publish", caption: "legenda reescrita" }), ["threads_profile"], at(600));
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
      items: [{ destination: "x", action: "publish", caption: "texto do X" }],
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
    assert.equal(s2.authorizations[0].invalidated_kind, "superseded");
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
