/**
 * test/shorts-corte-timer-authorization-11912.test.ts (#11912)
 *
 * O timer do corte avulso (`Diaria-Shorts-Cortes`, `scripts/shorts-corte-timer.ts`)
 * decidia publicar pela simples existência do `corte.json`, que o DRY-RUN do
 * `publish-shorts.ts --corte` grava. Com `publishing.shorts.corte_via_timer`
 * ligado, um dry-run "só pra ver" virava post público no `--at`, e um corte
 * abandonado gerava alarme `late` urgente. Decisão do editor (02/11/2026): o
 * timer só publica o que o editor confirmou com "pode publicar" — destinos e
 * conteúdo exatos — e qualquer perda de autorização com destino pendente vira
 * ALARME, nunca silêncio. Sem rede, sem publicar nada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_TIMER_ALARM_STATE_FILE,
  buildCorteTimerAlarm,
  corteAlarm,
  corteAlarmId,
  corteAlarmSeverity,
  corteAlarmVariant,
  cortePublishArgs,
  decideCorteTimerRun,
  interpretCorteTimerOutput,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import {
  CORTE_SPEC_FILE,
  corteAuthorizedDestinations,
  corteContentCheck,
  corteRevokedDestinations,
  parseCorteSpec,
  planCorteAuthorizationRestore,
  withCortePublishAuthorization,
  withoutCortePublishAuthorization,
  type CorteContentFingerprint,
  type CorteSpec,
} from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint, corteContentFingerprintFromBytes } from "../scripts/lib/diaria/corte-content.ts";
import { SHORT_COVER_FILE } from "../scripts/lib/diaria/short-cover.ts";
import { nextAlarmState } from "../scripts/lib/diaria/shorts-timer-alarm-state.ts";
import {
  corteRequireAuthArgsError,
  corteRunAuthorizationError,
  corteRunSpecDrift,
  prepareCorteRun,
  recordCortePublishAuthorization,
  restoreCorteAuthorizationAfterUpdate,
  syncCorteAuthorizationWithContent,
  type CorteRevocation,
} from "../scripts/publish-shorts.ts";

const BASE: CorteSpec = { slug: "corte-extra", date: "261103", hhmm: "08:00", title: "Título do corte", hook: "Gancho do corte.", video: "corte-corte-extra.mp4" };
const AT = "2026-11-03T11:00:00.000Z"; // 08:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
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
  corte_via_timer: true,
};
const CONFIG = { publishing: { shorts } };
const KNOWN = new Set(["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CONTENT: CorteContentFingerprint = { video_sha256: sha("mp4"), cover_sha256: null };
const authorized = (dests: string[], extra: Partial<CorteSpec> = {}): CorteSpec => ({
  ...BASE,
  publish_confirmed_at: "2026-11-02T20:00:00.000Z",
  publish_confirmed_destinations: dests,
  publish_confirmed_content: CONTENT,
  ...extra,
});
const revokedSpec = (dests: string[], kind: "plan" | "content" = "plan", when = "2026-11-02T22:00:00.000Z"): CorteSpec => ({
  ...BASE,
  publish_revoked_at: when,
  publish_revoked_destinations: dests,
  publish_revoked_reason_kind: kind,
  ...(kind === "plan" ? { publish_revoked_content: CONTENT } : {}),
});
/** Pasta de corte com vídeo ("mp4") e corte.json gravado pelo dry-run (sem autorização). */
function corteDir(prefix = "corte-11912-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(root, BASE.slug);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, BASE.video), "mp4");
  prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
  return dir;
}
const readSpec = (dir: string) => parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
/** O `--publish --confirm-publish` humano: grava o "pode publicar" com a impressão digital do disco. */
const grant = (dir: string, only: string | undefined, now = AT) =>
  recordCortePublishAuthorization(dir, only, KNOWN, corteContentFingerprint(dir, readSpec(dir)), now, () => {});
const PUBLISHED = (dest: string) => [{ path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: BASE.date, entries: [{ destination: dest, status: "published", id: "m", at: AT }] }) }];
type Alarm = { destination: string; key: CorteTimerAlarmKey; variant?: string };
const deps = (now: Date, calls: string[][], alarms: Alarm[], stdout = JSON.stringify({ results: [] })) => ({
  config: CONFIG,
  now,
  runScript: (args: string[]) => {
    calls.push(args);
    return { status: 0, stdout, stderr: "" };
  },
  notify: { cwd: "/nao-usado" },
  alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey, _r: string, variant?: string) => {
    alarms.push({ destination, key, ...(variant ? { variant } : {}) });
    return true;
  },
});
const SRC = () => readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
const MAIN = () => {
  const src = SRC();
  return src.slice(src.indexOf("async function main(): Promise<number>"));
};

describe("#11912 decideCorteTimerRun exige o 'pode publicar'", () => {
  it("corte só com dry-run (sem marcador): não publica no horário", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: BASE, registryRaws: [], now: at(10 * 60_000) });
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") assert.match(d.reason, /pode publicar/);
  });

  it("sem marcador, passadas 3 h do horário: nada de alarme late (corte nunca aprovado não está atrasado)", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: BASE, registryRaws: [], now: at(4 * 3_600_000) });
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") assert.equal(d.alarms, undefined);
  });

  it("com marcador: publica só os destinos do --only autorizado", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram", "youtube_shorts"]), registryRaws: [], now: at(10 * 60_000) });
    if (d.kind !== "publish") assert.fail(d.kind);
    assert.deepEqual(d.pending, ["instagram"]);
    assert.equal(d.alarms, undefined);
  });

  it("com marcador, o late continua saindo, mas só para os destinos autorizados", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["threads_profile"]), registryRaws: [], now: at(4 * 3_600_000) });
    if (d.kind !== "late") assert.fail(d.kind);
    assert.deepEqual(d.pending, ["threads_profile"]);
  });

  it("autorizado já registrado e o resto fora do --only: nada a publicar, com o motivo", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram"]), registryRaws: PUBLISHED("instagram"), now: at(4 * 3_600_000) });
    if (d.kind !== "skip") assert.fail(d.kind);
    assert.match(d.reason, /fora do "pode publicar".*linkedin_profile, threads_profile/);
  });

  it("G: destino autorizado que a config não conhece vira alarme unknown-destination (nunca filtro silencioso); os válidos saem", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram", "tiktok_velho"]), registryRaws: [], now: at(10 * 60_000) });
    if (d.kind !== "publish") assert.fail(d.kind);
    assert.deepEqual(d.pending, ["instagram"]);
    assert.deepEqual(d.alarms?.map((a) => [a.destination, a.key]), [["tiktok_velho", "unknown-destination"]]);
    assert.equal(corteAlarmSeverity("unknown-destination"), "acao");
    assert.match(buildCorteTimerAlarm({ spec: BASE, destination: "tiktok_velho", key: "unknown-destination", reason: "x" }).body, /não existe na config atual/);
    const before = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram", "tiktok_velho"]), registryRaws: [], now: at(-60_000) });
    assert.equal(before.kind, "wait", "antes do horário, nem alarme");
  });

  it("B: autorização parcial convive com a derrubada; os derrubados pendentes alarmam revoked mesmo com o timer publicando os outros", () => {
    const spec: CorteSpec = { ...authorized(["instagram"]), ...revokedSpec(["linkedin_profile", "threads_profile"]), publish_confirmed_at: "2026-11-02T23:00:00.000Z", publish_confirmed_destinations: ["instagram"], publish_confirmed_content: CONTENT };
    const d = decideCorteTimerRun({ config: CONFIG, spec: parseCorteSpec(JSON.stringify(spec), "x"), registryRaws: PUBLISHED("threads_profile"), now: at(10 * 60_000) });
    if (d.kind !== "publish") assert.fail(d.kind);
    assert.deepEqual(d.pending, ["instagram"]);
    assert.deepEqual(d.alarms?.map((a) => [a.destination, a.key]), [["linkedin_profile", "revoked"]], "threads_profile já saiu: sem alarme");
  });
});

describe("#11912 marcador de autorização no corte.json", () => {
  it("mesmo conteúdo soma destinos; re-execução com subconjunto não regrava; --only vazio não autoriza", () => {
    const first = withCortePublishAuthorization(BASE, ["instagram"], CONTENT, "2026-11-02T20:00:00.000Z");
    assert.equal(first.changed, true);
    assert.deepEqual(corteAuthorizedDestinations(first.spec), ["instagram"]);
    assert.deepEqual(first.spec.publish_confirmed_content, CONTENT);
    const more = withCortePublishAuthorization(first.spec, ["linkedin_profile", "instagram"], CONTENT, "2026-11-02T21:00:00.000Z");
    assert.deepEqual(corteAuthorizedDestinations(more.spec), ["instagram", "linkedin_profile"]);
    assert.equal(withCortePublishAuthorization(more.spec, ["instagram"], CONTENT, "2026-11-03T11:10:00.000Z").changed, false);
    assert.equal(withCortePublishAuthorization(BASE, [], CONTENT, "x").changed, false, "--only vazio não autoriza nada");
  });

  it("conteúdo novo: vale só para os destinos desta confirmação, e os antigos deixados de fora vão para a derrubada (content)", () => {
    const old = authorized(["instagram", "linkedin_profile"]);
    const next = withCortePublishAuthorization(old, ["threads_profile", "instagram"], { video_sha256: sha("outro"), cover_sha256: null }, "2026-11-02T22:00:00.000Z");
    assert.equal(next.changed, true);
    assert.deepEqual(corteAuthorizedDestinations(next.spec), ["threads_profile", "instagram"]);
    assert.equal(next.spec.publish_confirmed_content?.video_sha256, sha("outro"));
    assert.deepEqual(corteRevokedDestinations(next.spec), ["linkedin_profile"], "nunca esquecido em silêncio");
    assert.equal(next.spec.publish_revoked_reason_kind, "content");
    parseCorteSpec(JSON.stringify(next.spec), "x"); // válido
  });

  it("B: conceder um --only menor tira da derrubada só os concedidos; a derrubada some quando fica vazia", () => {
    const fell = withoutCortePublishAuthorization(authorized(["instagram", "linkedin_profile", "threads_profile"]), "2026-11-02T22:00:00.000Z", "plan").spec;
    const partial = withCortePublishAuthorization(fell, ["instagram"], CONTENT, "2026-11-02T23:00:00.000Z").spec;
    assert.deepEqual(corteAuthorizedDestinations(partial), ["instagram"]);
    assert.deepEqual(corteRevokedDestinations(partial), ["linkedin_profile", "threads_profile"]);
    assert.equal(partial.publish_revoked_at, "2026-11-02T22:00:00.000Z", "a data da queda não muda");
    assert.equal(partial.publish_revoked_reason_kind, "plan");
    parseCorteSpec(JSON.stringify(partial), "x");
    const full = withCortePublishAuthorization(partial, ["linkedin_profile", "threads_profile"], CONTENT, "2026-11-02T23:30:00.000Z").spec;
    assert.deepEqual(corteRevokedDestinations(full), []);
    assert.equal(full.publish_revoked_at, undefined);
    assert.equal(full.publish_revoked_reason_kind, undefined);
    assert.equal(full.publish_revoked_content, undefined);
  });

  it("queda sobre queda: soma destinos, a data é a da última (o alarme avisa de novo) e content vence plan", () => {
    const first = withoutCortePublishAuthorization(authorized(["instagram"]), "2026-11-02T22:00:00.000Z", "plan").spec;
    const regranted = withCortePublishAuthorization(first, ["threads_profile"], CONTENT, "2026-11-02T22:30:00.000Z").spec;
    const second = withoutCortePublishAuthorization(regranted, "2026-11-02T23:00:00.000Z", "content");
    assert.deepEqual(second.revoked, ["threads_profile"]);
    assert.deepEqual(corteRevokedDestinations(second.spec), ["instagram", "threads_profile"]);
    assert.equal(second.spec.publish_revoked_at, "2026-11-02T23:00:00.000Z");
    assert.equal(second.spec.publish_revoked_reason_kind, "content");
    assert.equal(second.spec.publish_revoked_content, undefined);
    assert.equal(withoutCortePublishAuthorization(revokedSpec(["instagram"]), "x", "plan").revoked, null, "sem autorização, nada a derrubar");
  });

  it("--publish sem --only grava a lista concreta dos destinos da config", () => {
    const dir = corteDir();
    grant(dir, undefined);
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), [...KNOWN]);
    assert.deepEqual(readSpec(dir).publish_confirmed_content, CONTENT);
  });

  it("G: marcador malformado lança (nunca vira autorizado em silêncio), inclusive o formato \"all\"", () => {
    const bad = (o: object, re: RegExp) => assert.throws(() => parseCorteSpec(JSON.stringify(o), "x.json"), re);
    bad({ ...BASE, publish_confirmed_at: "2026-11-02T20:00:00.000Z" }, /andam juntos/);
    bad({ ...BASE, publish_confirmed_at: "ontem", publish_confirmed_destinations: ["instagram"], publish_confirmed_content: CONTENT }, /ISO/);
    bad({ ...BASE, publish_confirmed_at: AT, publish_confirmed_destinations: "all", publish_confirmed_content: CONTENT }, /lista de destinos/);
    bad({ ...BASE, publish_confirmed_at: AT, publish_confirmed_destinations: [], publish_confirmed_content: CONTENT }, /lista de destinos/);
    bad({ ...BASE, publish_confirmed_at: AT, publish_confirmed_destinations: ["instagram"] }, /publish_confirmed_content obrigatório/);
    bad(authorized(["instagram"], { publish_confirmed_content: { video_sha256: null, cover_sha256: null } }), /publish_confirmed_content obrigatório/);
    bad(authorized(["instagram"], { publish_confirmed_content: { video_sha256: "abc", cover_sha256: null } }), /publish_confirmed_content obrigatório/);
    bad({ ...BASE, publish_revoked_at: AT, publish_revoked_destinations: ["instagram"] }, /andam juntos/);
    bad({ ...revokedSpec(["instagram"]), publish_revoked_destinations: "all" }, /lista de destinos/);
    bad({ ...revokedSpec(["instagram"]), publish_revoked_reason_kind: "talvez" }, /"plan" ou "content"/);
    bad({ ...revokedSpec(["instagram"]), publish_revoked_content: undefined }, /publish_revoked_content obrigatório/);
    bad({ ...revokedSpec(["instagram"], "content"), publish_revoked_content: CONTENT }, /só com publish_revoked_reason_kind "plan"/);
    bad({ ...authorized(["instagram"]), ...revokedSpec(["instagram"]), publish_confirmed_destinations: ["instagram"] }, /autorizado e derrubado ao mesmo tempo: instagram/);
    // Coexistência (destinos diferentes) é válida.
    const both = parseCorteSpec(JSON.stringify({ ...revokedSpec(["linkedin_profile"]), publish_confirmed_at: AT, publish_confirmed_destinations: ["instagram"], publish_confirmed_content: CONTENT }), "x.json");
    assert.deepEqual([corteAuthorizedDestinations(both), corteRevokedDestinations(both)], [["instagram"], ["linkedin_profile"]]);
  });

  it("dry-run idêntico mantém a autorização; mudar o plano derruba (plan); outro --video derruba (content)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11912-"));
    writeFileSync(join(dir, BASE.video), "mp4");
    const values = { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) };
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null, "o dry-run grava o corte.json SEM autorização");
    grant(dir, "instagram", "2026-11-02T20:00:00.000Z");
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), ["instagram"], "mesmo plano: a autorização segue");
    const logs: string[] = [];
    const revs: CorteRevocation[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: { title: "Outro título" }, positionalDate: "", log: (l) => logs.push(l), now: () => new Date(AT), onRevoked: (r) => revs.push(r) });
    const s = readSpec(dir);
    assert.equal(corteAuthorizedDestinations(s), null, "plano novo: o 'pode publicar' antigo não vale");
    assert.deepEqual([s.publish_revoked_at, s.publish_revoked_destinations, s.publish_revoked_reason_kind], [AT, ["instagram"], "plan"]);
    assert.deepEqual(s.publish_revoked_content, CONTENT, "a impressão digital aprovada fica para o restore conferir");
    assert.equal(s.publish_confirmed_content, undefined);
    assert.ok(logs.some((l) => /"pode publicar" caiu \(o plano do corte mudou \(title\)\)/.test(l)), logs.join("\n"));
    assert.deepEqual(revs, [{ at: AT, destinations: ["instagram"], reason: "o plano do corte mudou (title)", reason_kind: "plan" }], "a derrubada vai pro JSON da rodada");

    const other = corteDir();
    grant(other, "instagram");
    writeFileSync(join(other, "novo.mp4"), "mp4");
    prepareCorteRun({ slug: BASE.slug, dir: other, values: { video: join(other, "novo.mp4") }, positionalDate: "", log: () => {} });
    assert.equal(readSpec(other).publish_revoked_reason_kind, "content", "outro --video é outro conteúdo, mesmo com os mesmos bytes");
  });

  it("--only com destino desconhecido: lança e nada é gravado (nem os destinos válidos da mesma lista)", () => {
    const dir = corteDir("corte-11912-only-");
    const before = readFileSync(join(dir, CORTE_SPEC_FILE), "utf8");
    const logs: string[] = [];
    assert.throws(() => recordCortePublishAuthorization(dir, "instagram,instagran", KNOWN, CONTENT, AT, (l) => logs.push(l)), /destino desconhecido: instagran/);
    assert.equal(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), before, "corte.json intacto");
    assert.deepEqual(logs, []);
    assert.throws(() => recordCortePublishAuthorization(dir, "instagram", KNOWN, { video_sha256: null, cover_sha256: null }, AT, () => {}), /vídeo do corte ausente/);
    assert.equal(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), before);
    grant(dir, "facebook:diaria");
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), ["facebook:diaria"]);
  });

  // Trava de FONTE (a ligação no `main` não roda em teste: o guard de publicação
  // proíbe executar o publish-shorts com --publish). Garante que a gravação vem
  // depois de TODAS as validações que abortam e antes do 1º envio.
  it("publish-shorts grava a autorização só depois das validações que abortam e antes do 1º envio", () => {
    const src = SRC();
    const mainStart = src.indexOf("async function main(): Promise<number>");
    assert.ok(mainStart > 0);
    const call = src.indexOf("recordCortePublishAuthorization(dir,", mainStart);
    assert.ok(call > 0);
    assert.equal(src.indexOf("recordCortePublishAuthorization(dir,", call + 1), -1, "uma única chamada");
    const before = (needle: string, label: string) => {
      const i = src.indexOf(needle, mainStart);
      assert.ok(i > 0 && i < call, `${label} vem antes da gravação`);
    };
    before("publishConfirmationError({", "confirmação (#11741)");
    before("if (values[\"mark\"]) {", "--mark (sai sem gravar)");
    before("const scopeErr =", "escopo dos timers");
    before('if (flags.has("update-scheduled")) {', "--update-scheduled (sai sem gravar)");
    before("plan = planShortsPublish({", "plano (valida o --only contra a config)");
    before('if (!flags.has("publish")) {', "dry-run (sai sem gravar)");
    before("vídeo curto ausente em ${videoPath}`);\n    return 1;", "vídeo ausente");
    const firstSend = src.indexOf("for (const item of plan.items)", mainStart);
    assert.ok(firstSend > call, "a gravação vem antes do 1º envio (o timer depende dela)");
    const window = src.slice(call - 400, call + 300);
    assert.match(window, /knownDestinationIds\(shortsCfg\), corteContent,/, "valida os nomes e grava a impressão digital dos bytes da rodada");
    assert.match(window, /return 2;/, "destino desconhecido aborta com exit 2");
  });
});

describe("#11912 runCorteTimerFor: dry-run -> nada; --publish confirmado -> só o --only", () => {
  it("corte só com dry-run: o timer não chama o publish nem alarma, no horário ou depois de 3 h", async () => {
    const dir = corteDir();
    for (const now of [at(10 * 60_000), at(4 * 3_600_000)]) {
      const calls: string[][] = [];
      const alarms: Alarm[] = [];
      assert.equal(await runCorteTimerFor(dir, false, deps(now, calls, alarms)), 0);
      assert.deepEqual([calls, alarms], [[], []]);
    }
  });

  it("depois do --publish confirmado com --only: o timer publica só esses destinos", async () => {
    const dir = corteDir();
    grant(dir, "instagram,linkedin_profile,youtube_shorts", "2026-11-02T20:00:00.000Z");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--only") + 1], "linkedin_profile,instagram", "threads_profile ficou fora do --only autorizado");
  });

  it("B: concessão menor depois da queda publica o concedido E alarma os derrubados", async () => {
    const dir = corteDir();
    grant(dir, "instagram,linkedin_profile,threads_profile");
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {}, now: () => new Date("2026-11-02T22:00:00.000Z") });
    grant(dir, "instagram", "2026-11-02T23:00:00.000Z");
    assert.deepEqual(corteRevokedDestinations(readSpec(dir)), ["linkedin_profile", "threads_profile"], "o --only menor não apaga a derrubada dos outros");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.equal(calls[0][calls[0].indexOf("--only") + 1], "instagram");
    // (o stdout falso não traz resultado do instagram: o publish-failed dele é do fake, não do caso)
    assert.deepEqual(alarms.filter((a) => a.key === "revoked").map((a) => a.destination), ["linkedin_profile", "threads_profile"]);
  });
});

describe("#11912: trocar vídeo ou capa depois do 'pode publicar' não herda a autorização", () => {
  it("autorizado e depois o vídeo foi re-exportado no mesmo caminho: o timer não publica e alarma content-changed", async () => {
    const dir = corteDir();
    grant(dir, "instagram,linkedin_profile");
    writeFileSync(join(dir, BASE.video), "mp4-reexportado");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    assert.equal(await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms)), 0);
    assert.deepEqual(calls, [], "nada publicado");
    assert.deepEqual(alarms.map((a) => [a.destination, a.key]), [["linkedin_profile", "content-changed"], ["instagram", "content-changed"]]);
    assert.equal(alarms[0].variant, `${sha("mp4-reexportado").slice(0, 12)}-sem-capa`, "E: o id leva o arquivo atual");
    assert.equal(corteAlarmSeverity("content-changed"), "urgente");
    const body = buildCorteTimerAlarm({ spec: readSpec(dir), destination: "instagram", key: "content-changed", reason: "o vídeo do corte mudou" }).body;
    assert.match(body, /não é o arquivo aprovado/);
    assert.match(body, /--only instagram --publish --confirm-publish 261103/);
  });

  it("capa nova onde não havia também barra o timer", async () => {
    const dir = corteDir();
    grant(dir, "threads_profile");
    writeFileSync(join(dir, SHORT_COVER_FILE), "jpg-novo");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.deepEqual([calls, alarms.map((a) => a.key)], [[], ["content-changed"]]);
  });

  it("D: capa aprovada ausente (cópia do OneDrive atrasada): o timer alarma missing-video, não content-changed, e nada é derrubado", async () => {
    const dir = corteDir();
    writeFileSync(join(dir, SHORT_COVER_FILE), "jpg");
    grant(dir, "threads_profile");
    writeFileSync(join(dir, SHORT_COVER_FILE), ""); // vazia = ausente, como no readShortCover
    assert.equal(corteContentCheck(readSpec(dir).publish_confirmed_content, corteContentFingerprint(dir, readSpec(dir))).kind, "missing");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.deepEqual([calls, alarms.map((a) => a.key)], [[], ["missing-video"]]);
    assert.match(buildCorteTimerAlarm({ spec: BASE, destination: "threads_profile", key: "missing-video", reason: "x" }).body, /ou a capa aprovada/);
    // #12837: pós-virada do data/ (#12359), a dica aponta o sync do Drive.
    assert.match(buildCorteTimerAlarm({ spec: BASE, destination: "threads_profile", key: "missing-video", reason: "x" }).body, /sync do Drive atrasado/);
    assert.deepEqual(corteAuthorizedDestinations(syncCorteAuthorizationWithContent(dir, AT, { log: () => {} })), ["threads_profile"], "capa ausente não revoga");
  });

  it("D: rodada sem --cover/--video/--from-drive não confere o disco (cópia defasada nunca derruba a autorização)", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    writeFileSync(join(dir, BASE.video), "mp4-parcial-do-onedrive");
    const revs: CorteRevocation[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: {}, positionalDate: "", log: () => {}, onRevoked: (r) => revs.push(r) });
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), ["instagram"]);
    assert.equal(revs.length, 0);
  });

  it("conteúdo igual ao aprovado: publica normalmente", async () => {
    const dir = corteDir();
    grant(dir, "threads_profile");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms, JSON.stringify({ results: [{ destination: "threads_profile", ok: true, entry: { destination: "threads_profile", status: "published", id: "t", at: AT } }] })));
    assert.equal(calls.length, 1);
    assert.deepEqual(alarms, []);
  });

  it("--cover com outra imagem derruba a autorização (content); com a mesma imagem, não", () => {
    const dir = corteDir();
    const cover = join(dir, "..", "capa.jpg");
    writeFileSync(cover, "jpg-a");
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {} });
    grant(dir, "instagram");
    assert.equal(readSpec(dir).publish_confirmed_content?.cover_sha256, sha("jpg-a"));
    const revs: CorteRevocation[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {}, onRevoked: (r) => revs.push(r) });
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), ["instagram"], "mesma capa: segue autorizado");
    assert.equal(revs.length, 0);
    writeFileSync(cover, "jpg-b");
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {}, now: () => new Date(AT), onRevoked: (r) => revs.push(r) });
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null);
    assert.deepEqual([readSpec(dir).publish_revoked_destinations, readSpec(dir).publish_revoked_reason_kind], [["instagram"], "content"]);
    assert.equal(revs.length, 1);
    assert.match(revs[0].reason, /a capa do corte mudou/);
  });

  it("--from-drive que baixa outro arquivo (sync depois do download) derruba; vídeo ausente não derruba", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    assert.ok(corteAuthorizedDestinations(syncCorteAuthorizationWithContent(dir, AT, { log: () => {} })), "mesmo arquivo: nada muda");
    writeFileSync(join(dir, BASE.video), "mp4-do-drive");
    const revs: CorteRevocation[] = [];
    const spec = syncCorteAuthorizationWithContent(dir, AT, { log: () => {}, onRevoked: (r) => revs.push(r) });
    assert.equal(corteAuthorizedDestinations(spec), null);
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null, "gravado");
    assert.match(revs[0].reason, /o vídeo do corte mudou/);
    assert.equal(revs[0].reason_kind, "content");
    const other = corteDir();
    grant(other, "instagram");
    writeFileSync(join(other, CORTE_SPEC_FILE), JSON.stringify({ ...readSpec(other), video: join(other, "..", "sumiu.mp4") }));
    assert.ok(corteAuthorizedDestinations(syncCorteAuthorizationWithContent(other, AT, { log: () => {} })), "vídeo ausente nesta máquina: o timer alarma missing-video, não derruba");
  });

  it("J: em main, o sync pós --from-drive vem depois do download e antes de ler o vídeo, e nunca no filho do timer", () => {
    const main = MAIN();
    const download = main.indexOf("await downloadDriveFileById(");
    const sync = main.indexOf("syncCorteAuthorizationWithContent(dir,");
    const read = main.indexOf("const file = videoExists ? readFileSync(videoPath) : null;");
    assert.ok(download > 0 && sync > download && read > sync, `ordem: download ${download} < sync ${sync} < leitura ${read}`);
    assert.match(main.slice(sync - 80, sync), /if \(corte && !requireCorteAuth\) corte = $/);
  });

  it("F: impressão digital dos bytes = a do disco; capa vazia = ausente; a capa sobe dos bytes já lidos", () => {
    const dir = corteDir();
    assert.deepEqual(corteContentFingerprint(dir, readSpec(dir)), CONTENT);
    writeFileSync(join(dir, SHORT_COVER_FILE), "jpg");
    assert.deepEqual(corteContentFingerprint(dir, readSpec(dir)), { video_sha256: sha("mp4"), cover_sha256: sha("jpg") });
    assert.deepEqual(corteContentFingerprintFromBytes(Buffer.from("mp4"), Buffer.from("jpg")), corteContentFingerprint(dir, readSpec(dir)));
    writeFileSync(join(dir, SHORT_COVER_FILE), "");
    assert.equal(corteContentFingerprint(dir, readSpec(dir)).cover_sha256, null);
    const main = MAIN();
    assert.match(main, /const corteContent = corte \? corteContentFingerprintFromBytes\(file, shortCover\.bytes\) : null;/);
    const upload = main.slice(main.indexOf("const uploadCover = async"), main.indexOf("for (const item of plan.items)"));
    assert.match(upload, /coverKey, coverBytes, "image\/jpeg"/);
    assert.doesNotMatch(upload, /readFileSync\(/, "a capa não é relida do disco depois da conferência");
  });
});

describe("#11912: o filho do timer só confere a autorização, nunca concede nem grava", () => {
  it("cortePublishArgs passa --require-corte-authorization", () => {
    assert.ok(cortePublishArgs(BASE, ["instagram"]).includes("--require-corte-authorization"));
  });

  it("J: corteRequireAuthArgsError — só com --corte e --publish, sem --update-scheduled nem flag que mude o corte", () => {
    const f = (...xs: string[]) => new Set(xs);
    const ok = { corte: "c" };
    assert.equal(corteRequireAuthArgsError(f("publish"), ok), null, "sem a flag: nada a conferir");
    assert.equal(corteRequireAuthArgsError(f("publish", "require-corte-authorization"), ok), null);
    assert.match(corteRequireAuthArgsError(f("publish", "require-corte-authorization"), {}) ?? "", /só vale com --corte/);
    assert.match(corteRequireAuthArgsError(f("require-corte-authorization"), ok) ?? "", /só vale com --publish/);
    assert.match(corteRequireAuthArgsError(f("publish", "update-scheduled", "require-corte-authorization"), ok) ?? "", /só vale com --publish e sem mudar o corte/);
    assert.match(corteRequireAuthArgsError(f("publish", "require-corte-authorization"), { ...ok, cover: "x.jpg" }) ?? "", /recebeu --cover/);
    assert.match(corteRequireAuthArgsError(f("publish", "require-corte-authorization"), { ...ok, "from-drive": "abc" }) ?? "", /recebeu --from-drive/);
    assert.match(corteRequireAuthArgsError(f("publish", "require-corte-authorization"), { ...ok, title: "t", hook: "h" }) ?? "", /recebeu --title, --hook/);
    assert.match(MAIN(), /const requireAuthArgsErr = corteRequireAuthArgsError\(flags, values\);/);
  });

  it("corteRunAuthorizationError: o motivo estruturado da recusa", () => {
    const r = (spec: CorteSpec, only: string[] | null, c = CONTENT) => corteRunAuthorizationError(spec, only, c);
    assert.equal(r(BASE, ["instagram"])?.refused, "revoked");
    assert.match(r(revokedSpec(["instagram"]), ["instagram"])?.reason ?? "", /caiu em/);
    assert.match(r(authorized(["instagram"]), ["instagram", "threads_profile"])?.reason ?? "", /fora do "pode publicar".*threads_profile/);
    assert.match(r(authorized(["instagram"]), null)?.reason ?? "", /exige --only/);
    assert.deepEqual(r(authorized(["instagram"]), ["instagram"], { video_sha256: sha("x"), cover_sha256: null })?.refused, "content-changed");
    assert.deepEqual(r(authorized(["instagram"], { publish_confirmed_content: { video_sha256: sha("mp4"), cover_sha256: sha("jpg") } }), ["instagram"])?.refused, "missing-content");
    assert.equal(r(authorized(["instagram", "threads_profile"]), ["threads_profile"]), null);
  });

  it("H: corteRunSpecDrift acusa o corte.json regravado no meio da rodada", () => {
    assert.deepEqual(corteRunSpecDrift(BASE, BASE), []);
    assert.deepEqual(corteRunSpecDrift({ ...BASE, hook: "outro", hhmm: "09:00" }, BASE), ["hook", "hhmm"]);
    assert.deepEqual(corteRunSpecDrift(authorized(["instagram"]), BASE), [], "a autorização não é plano");
  });

  it("C: prepareCorteRun readOnly não grava nada (nem a derrubada por conteúdo) e recusa mudar o corte", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    writeFileSync(join(dir, BASE.video), "mp4-trocado");
    const path = join(dir, CORTE_SPEC_FILE);
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    const spec = prepareCorteRun({ slug: BASE.slug, dir, values: {}, positionalDate: "", log: () => {}, readOnly: true });
    assert.deepEqual(corteAuthorizedDestinations(spec), ["instagram"]);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(statSync(path).mtimeMs, mtime);
    assert.throws(() => prepareCorteRun({ slug: BASE.slug, dir, values: { title: "x" }, positionalDate: "", log: () => {}, readOnly: true }), /não muda o corte \(title\)/);
    assert.equal(readFileSync(path, "utf8"), before);
    const fresh = mkdtempSync(join(tmpdir(), "corte-11912-ro-"));
    assert.throws(() => prepareCorteRun({ slug: BASE.slug, dir: fresh, values: { ...BASE, at: BASE.hhmm } as unknown as Record<string, string>, positionalDate: "", log: () => {}, readOnly: true }), /não registra corte/);
  });

  it("C: a recusa do filho vira o alarme certo, nunca no-output", () => {
    const out = (refused: string) => JSON.stringify({ dry_run: false, authorization_refused: refused, reason: "motivo" });
    const keys = (refused: string) => interpretCorteTimerOutput(2, out(refused), ["instagram", "threads_profile"]).map((o) => (o.kind === "alarm" ? o.key : o.kind));
    assert.deepEqual(keys("revoked"), ["revoked", "revoked"]);
    assert.deepEqual(keys("content-changed"), ["content-changed", "content-changed"]);
    assert.deepEqual(keys("missing-content"), ["missing-video", "missing-video"]);
  });

  it("C: runCorteTimerFor alarma a recusa do filho com a variante da queda de agora", async () => {
    const dir = corteDir();
    grant(dir, "instagram");
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    const code = await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms, JSON.stringify({ authorization_refused: "revoked", reason: "x" })));
    assert.equal(code, 1);
    assert.deepEqual(alarms, [{ destination: "instagram", key: "revoked", variant: AT }]);
  });

  // Trava de FONTE: o guard de publicação proíbe executar o publish-shorts com --publish.
  it("main: com a flag lê o corte só para conferir, recusa em JSON com exit 2; a gravação fica no else", () => {
    const main = MAIN();
    assert.match(main, /prepareCorteRun\(\{[^}]*readOnly: requireCorteAuth \}\)/);
    const check = main.indexOf("if (corte && corteContent && requireCorteAuth) {");
    const record = main.indexOf("recordCortePublishAuthorization(dir,");
    assert.ok(check > 0 && record > check);
    const block = main.slice(check, record);
    // #11923: drift + conferência da autorização vivem em corteTimerChildRefusal (testada no comportamento).
    assert.match(block, /corteTimerChildRefusal\(parseCorteSpec\([^)]*\), specPath\), corte, onlyList, corteContent\)/);
    assert.match(block, /authorization_refused: refusal\.refused/);
    assert.match(block, /return 2;[\s\S]*\} else if \(corte && corteContent\) \{/);
  });
});

describe("#11912: autorização derrubada vira alarme, e o --update-scheduled confirmado só devolve o que foi confirmado", () => {
  it("antes do horário não alarma; no horário alarma revoked (urgência normal) só para os autorizados pendentes", () => {
    const before = decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["instagram", "linkedin_profile"]), registryRaws: [], now: at(-60_000) });
    if (before.kind !== "skip") assert.fail(before.kind);
    assert.match(before.reason, /alarma no horário/);
    assert.equal(before.alarms, undefined);
    const d = decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["instagram", "linkedin_profile"]), registryRaws: PUBLISHED("linkedin_profile"), now: at(10 * 60_000) });
    if (d.kind !== "skip") assert.fail(d.kind);
    assert.deepEqual(d.alarms?.map((a) => [a.destination, a.key]), [["instagram", "revoked"]]);
    assert.equal(corteAlarmSeverity("revoked"), "acao");
    const body = buildCorteTimerAlarm({ spec: BASE, destination: "instagram", key: "revoked", reason: d.alarms![0].reason }).body;
    assert.match(body, /"pode publicar" de novo/);
    assert.match(body, /Passadas 3 h do horário o timer não publica mais[\s\S]*--only instagram --publish --now --confirm-publish 261103[\s\S]*--mark instagram=URL/, "I: o que fazer depois de 3 h");
    const none = decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["linkedin_profile"]), registryRaws: PUBLISHED("linkedin_profile"), now: at(10 * 60_000) });
    assert.equal(none.kind === "skip" && none.alarms, undefined, "nada pendente: sem alarme");
  });

  it("runCorteTimerFor: revoked alarma por destino, com a data da queda no id, e não publica", async () => {
    const dir = corteDir();
    grant(dir, "instagram,threads_profile");
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {}, now: () => new Date("2026-11-02T22:00:00.000Z") });
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    assert.equal(await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms)), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(alarms, [
      { destination: "threads_profile", key: "revoked", variant: "2026-11-02T22:00:00.000Z" },
      { destination: "instagram", key: "revoked", variant: "2026-11-02T22:00:00.000Z" },
    ]);
  });

  it("E: a 2ª queda (ou o 2º arquivo trocado) tem outro id e avisa de novo; a mesma não repete", async () => {
    const t1 = corteAlarmId("instagram", "revoked", corteAlarmVariant("revoked", revokedSpec(["instagram"], "plan", "2026-11-02T22:00:00.000Z"), null));
    const t2 = corteAlarmId("instagram", "revoked", corteAlarmVariant("revoked", revokedSpec(["instagram"], "plan", "2026-11-03T09:00:00.000Z"), null));
    assert.notEqual(t1, t2);
    const c1 = corteAlarmVariant("content-changed", BASE, { video_sha256: sha("a"), cover_sha256: null });
    const c2 = corteAlarmVariant("content-changed", BASE, { video_sha256: sha("b"), cover_sha256: null });
    assert.notEqual(c1, c2);
    assert.equal(corteAlarmId("instagram", "late"), "instagram:late", "os outros motivos seguem com o id de sempre");
    // Mesma variante já avisada: não chama o notifyEditor (sem rede).
    const dir = corteDir();
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, CORTE_TIMER_ALARM_STATE_FILE), nextAlarmState(null, BASE.date, t1, { kind: "delivered" })!);
    assert.equal(await corteAlarm(dir, BASE, "instagram", "revoked", "x", { cwd: "/nao-usado" }, "2026-11-02T22:00:00.000Z"), true);
  });

  it("restore: queda plan volta para os mesmos destinos, com o conteúdo aprovado, e o registro some", () => {
    const dir = corteDir();
    grant(dir, "instagram,threads_profile");
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {} });
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null);
    const r = restoreCorteAuthorizationAfterUpdate(dir, "2026-11-02T23:00:00.000Z", KNOWN, null, () => {});
    assert.deepEqual(r, { restored: true, destinations: ["instagram", "threads_profile"] });
    const spec = readSpec(dir);
    assert.deepEqual(corteAuthorizedDestinations(spec), ["instagram", "threads_profile"]);
    assert.deepEqual(spec.publish_confirmed_content, CONTENT);
    assert.equal(spec.publish_revoked_at, undefined, "o registro de derrubada some");
    assert.equal(spec.hook, "Gancho corrigido.");
    assert.equal(restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, null, () => {}).restored, false, "nada derrubado: nada a restaurar");
    assert.equal(restoreCorteAuthorizationAfterUpdate(corteDir(), AT, KNOWN, null, () => {}).restored, false, "nunca autorizado: o --update-scheduled não concede");
  });

  it("restore: o --only da rodada intersecciona; o resto continua derrubado (e alarmando)", () => {
    const dir = corteDir();
    grant(dir, "instagram,threads_profile");
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {} });
    assert.deepEqual(restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, ["youtube_shorts", "instagram"], () => {}), { restored: true, destinations: ["instagram"] });
    assert.deepEqual([corteAuthorizedDestinations(readSpec(dir)), corteRevokedDestinations(readSpec(dir))], [["instagram"], ["threads_profile"]]);
    assert.equal(restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, ["youtube_shorts"], () => {}).restored, false, "--only sem nenhum derrubado");
  });

  it("restore: queda content (outra capa) nunca volta pelo --update-scheduled", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    const cover = join(dir, "..", "capa-nova.jpg");
    writeFileSync(cover, "jpg-novo");
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {} });
    const before = readFileSync(join(dir, CORTE_SPEC_FILE), "utf8");
    const r = restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, null, () => {});
    assert.equal(r.restored, false);
    if (!r.restored) assert.match(r.reason, /vídeo ou a capa mudou.*sem --update-scheduled/);
    assert.equal(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), before, "nada gravado");
  });

  it("restore: destinos fora da config, vídeo ausente e vídeo trocado depois da queda plan não restauram nem gravam", () => {
    assert.deepEqual(planCorteAuthorizationRestore(revokedSpec(["tiktok_velho"]), null, KNOWN), { ok: false, reason: "nenhum destino derrubado (tiktok_velho) está na config atual" });
    assert.deepEqual(planCorteAuthorizationRestore(revokedSpec(["tiktok_velho", "instagram"]), null, KNOWN), { ok: true, destinations: ["instagram"] });
    const dir = corteDir();
    grant(dir, "instagram");
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {} });
    const path = join(dir, CORTE_SPEC_FILE);
    const before = readFileSync(path, "utf8");
    writeFileSync(join(dir, BASE.video), "mp4-trocado-no-disco");
    const changed = restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, null, () => {});
    assert.equal(changed.restored, false);
    if (!changed.restored) assert.match(changed.reason, /o vídeo do corte mudou/);
    assert.equal(readFileSync(path, "utf8"), before);
    writeFileSync(path, JSON.stringify({ ...readSpec(dir), video: join(dir, "..", "sumiu.mp4") }));
    const gone = readFileSync(path, "utf8");
    const missing = restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, null, () => {});
    assert.equal(missing.restored, false);
    if (!missing.restored) assert.match(missing.reason, /vídeo do corte ausente/);
    assert.equal(readFileSync(path, "utf8"), gone, "vídeo ausente: não grava");
  });

  // Trava de FONTE do fio no `runUpdateScheduled` (não executável: guard de publicação).
  it("runUpdateScheduled: o dry-run avisa; com --publish, restaura DEPOIS das atualizações e só se todas deram certo, com o --only", () => {
    const src = SRC();
    const fn = src.slice(src.indexOf("async function runUpdateScheduled("), src.indexOf("async function main(): Promise<number>"));
    const dry = fn.indexOf("if (!input.publish) {");
    const exec = fn.indexOf("await executeScheduledUpdates(");
    const restore = fn.indexOf("restoreCorteAuthorizationAfterUpdate(");
    assert.ok(dry > 0 && exec > dry && restore > exec, "o restore vem depois das atualizações");
    assert.match(fn.slice(dry, exec), /planCorteAuthorizationRestore\([\s\S]*input\.only, known\)[\s\S]*regravaria o "pode publicar"[\s\S]*corte_authorization_restore_preview/);
    assert.match(fn.slice(exec), /corteRestoreBlockingFailures\(results\)[\s\S]*!blocking\.length\s*\?\s*restoreCorteAuthorizationAfterUpdate\(dir, [^,]+, known, input\.only,/); // #11955: só o YouTube falhando não segura
    assert.match(fn, /corte_authorization: corteAuthorization/);
    const main = MAIN();
    assert.match(main, /runUpdateScheduled\(\{[^}]*corteRevocations \}\)/);
    assert.match(main, /dry_run: true, \.\.\.plan, \.\.\.revokedOut\(\)/);
    assert.match(main, /dry_run: false, \.\.\.plan, results, summary, \.\.\.revokedOut\(\)/);
  });
});
