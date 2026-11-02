/**
 * test/shorts-corte-timer-authorization-11912.test.ts (#11912)
 *
 * O timer do corte avulso (`Diaria-Shorts-Cortes`, `scripts/shorts-corte-timer.ts`)
 * decidia publicar pela simples existência do `corte.json`, que o DRY-RUN do
 * `publish-shorts.ts --corte` grava. Com `publishing.shorts.corte_via_timer`
 * ligado, um dry-run "só pra ver" virava post público no `--at`, e um corte
 * abandonado gerava alarme `late` urgente. Decisão do editor (02/11/2026): vale
 * o "pode publicar" — só o `--publish --confirm-publish` grava a autorização
 * (`publish_confirmed_at`) e os destinos do `--only` usado; o timer só age com
 * ela e só nesses destinos. Sem rede, sem publicar nada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorteTimerAlarm, corteAlarmSeverity, cortePublishArgs, decideCorteTimerRun, runCorteTimerFor, type CorteTimerAlarmKey } from "../scripts/shorts-corte-timer.ts";
import {
  CORTE_SPEC_FILE,
  corteAuthorizedDestinations,
  parseCorteSpec,
  withCortePublishAuthorization,
  withoutCortePublishAuthorization,
  type CorteContentFingerprint,
  type CorteSpec,
} from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { SHORT_COVER_FILE } from "../scripts/lib/diaria/short-cover.ts";
import {
  corteRunAuthorizationError,
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
const authorized = (dests: "all" | string[]): CorteSpec => ({ ...BASE, publish_confirmed_at: "2026-11-02T20:00:00.000Z", publish_confirmed_destinations: dests, publish_confirmed_content: CONTENT });
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

describe("#11912 decideCorteTimerRun exige o 'pode publicar'", () => {
  it("corte só com dry-run (sem marcador): não publica no horário", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: BASE, registryRaws: [], now: at(10 * 60_000) });
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") assert.match(d.reason, /pode publicar/);
  });

  it("sem marcador, passadas 3 h do horário: nada de alarme late (corte nunca aprovado não está atrasado)", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: BASE, registryRaws: [], now: at(4 * 3_600_000) });
    assert.equal(d.kind, "skip");
  });

  it("com marcador: publica só os destinos do --only autorizado", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram", "youtube_shorts"]), registryRaws: [], now: at(10 * 60_000) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.deepEqual(d.pending, ["instagram"]);
    const all = decideCorteTimerRun({ config: CONFIG, spec: authorized("all"), registryRaws: [], now: at(10 * 60_000) });
    if (all.kind !== "publish") assert.fail(all.kind);
    assert.deepEqual(all.pending, ["linkedin_profile", "threads_profile", "instagram"]);
  });

  it("com marcador, o late continua saindo, mas só para os destinos autorizados", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["threads_profile"]), registryRaws: [], now: at(4 * 3_600_000) });
    assert.equal(d.kind, "late");
    if (d.kind === "late") assert.deepEqual(d.pending, ["threads_profile"]);
  });

  it("autorizado já registrado e o resto fora do --only: nada a fazer, com o motivo", () => {
    const raws = [{ path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: BASE.date, entries: [{ destination: "instagram", status: "published", id: "m", at: AT }] }) }];
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram"]), registryRaws: raws, now: at(4 * 3_600_000) });
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") assert.match(d.reason, /fora do "pode publicar".*linkedin_profile, threads_profile/);
  });
});

describe("#11912 marcador de autorização no corte.json", () => {
  it("mesmo conteúdo soma destinos; re-execução com subconjunto não regrava; nunca grava \"all\"", () => {
    const first = withCortePublishAuthorization(BASE, ["instagram"], CONTENT, "2026-11-02T20:00:00.000Z");
    assert.equal(first.changed, true);
    assert.deepEqual(corteAuthorizedDestinations(first.spec), ["instagram"]);
    assert.deepEqual(first.spec.publish_confirmed_content, CONTENT);
    const more = withCortePublishAuthorization(first.spec, ["linkedin_profile", "instagram"], CONTENT, "2026-11-02T21:00:00.000Z");
    assert.deepEqual(corteAuthorizedDestinations(more.spec), ["instagram", "linkedin_profile"]);
    assert.equal(withCortePublishAuthorization(more.spec, ["instagram"], CONTENT, "2026-11-03T11:10:00.000Z").changed, false);
    assert.equal(withCortePublishAuthorization(authorized("all"), ["instagram"], CONTENT, "x").changed, false, "leitura legada de \"all\" segue valendo");
    assert.equal(withCortePublishAuthorization(BASE, [], CONTENT, "x").changed, false, "--only vazio não autoriza nada");
  });

  it("conteúdo novo: a autorização não soma, vale só para os destinos desta confirmação", () => {
    const old = authorized(["instagram", "linkedin_profile"]);
    const next = withCortePublishAuthorization(old, ["threads_profile"], { video_sha256: sha("outro"), cover_sha256: null }, "2026-11-02T22:00:00.000Z");
    assert.equal(next.changed, true);
    assert.deepEqual(corteAuthorizedDestinations(next.spec), ["threads_profile"]);
    assert.equal(next.spec.publish_confirmed_content?.video_sha256, sha("outro"));
  });

  it("#11912 item 4: --publish sem --only grava a lista concreta dos destinos da config, nunca \"all\"", () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, undefined, KNOWN, AT, () => {});
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), [...KNOWN]);
    assert.deepEqual(readSpec(dir).publish_confirmed_content, CONTENT);
  });

  it("marcador malformado lança (nunca vira autorizado em silêncio)", () => {
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: "2026-11-02T20:00:00.000Z" }), "x.json"), /andam juntos/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: "ontem", publish_confirmed_destinations: "all" }), "x.json"), /ISO/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: AT, publish_confirmed_destinations: [] }), "x.json"), /lista de destinos/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...authorized(["instagram"]), publish_confirmed_content: { video_sha256: "abc", cover_sha256: null } }), "x.json"), /sha256/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_revoked_at: AT }), "x.json"), /publish_revoked_at e publish_revoked_destinations/);
    assert.deepEqual(corteAuthorizedDestinations(parseCorteSpec(JSON.stringify(authorized(["instagram"])), "x.json")), ["instagram"]);
  });

  it("dry-run idêntico mantém a autorização; dry-run que muda o plano derruba e registra a derrubada", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11912-"));
    writeFileSync(join(dir, BASE.video), "mp4");
    const values = { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) };
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    const read = () => readSpec(dir);
    assert.equal(corteAuthorizedDestinations(read()), null, "o dry-run grava o corte.json SEM autorização");
    recordCortePublishAuthorization(dir, "instagram", KNOWN, "2026-11-02T20:00:00.000Z", () => {});
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    assert.deepEqual(corteAuthorizedDestinations(read()), ["instagram"], "mesmo plano: a autorização segue");
    const logs: string[] = [];
    const revs: CorteRevocation[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: { title: "Outro título" }, positionalDate: "", log: (l) => logs.push(l), now: () => new Date(AT), onRevoked: (r) => revs.push(r) });
    assert.equal(corteAuthorizedDestinations(read()), null, "plano novo: o 'pode publicar' antigo não vale");
    assert.equal(read().publish_revoked_at, AT);
    assert.deepEqual(read().publish_revoked_destinations, ["instagram"]);
    assert.equal(read().publish_confirmed_content, undefined);
    assert.ok(logs.some((l) => /"pode publicar" caiu \(o plano do corte mudou \(title\)\)/.test(l)), logs.join("\n"));
    assert.deepEqual(revs, [{ at: AT, destinations: ["instagram"], reason: "o plano do corte mudou (title)" }], "a derrubada vai pro JSON da rodada");
  });

  it("--only com destino desconhecido: lança e nada é gravado (nem os destinos válidos da mesma lista)", () => {
    const dir = corteDir("corte-11912-only-");
    const before = readFileSync(join(dir, CORTE_SPEC_FILE), "utf8");
    const logs: string[] = [];
    assert.throws(() => recordCortePublishAuthorization(dir, "instagram,instagran", KNOWN, AT, (l) => logs.push(l)), /destino desconhecido: instagran/);
    assert.equal(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), before, "corte.json intacto");
    assert.equal(corteAuthorizedDestinations(parseCorteSpec(before, "corte.json")), null);
    assert.deepEqual(logs, []);
    // destino válido para a config da rodada: grava
    recordCortePublishAuthorization(dir, "facebook:diaria", KNOWN, AT, () => {});
    assert.deepEqual(corteAuthorizedDestinations(parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json")), ["facebook:diaria"]);
  });

  // Trava de FONTE (a ligação no `main` não roda em teste: o guard de publicação
  // proíbe executar o publish-shorts com --publish). Garante que a gravação vem
  // depois de TODAS as validações que abortam e antes do 1º envio.
  it("publish-shorts grava a autorização só depois das validações que abortam e antes do 1º envio", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
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
    assert.match(window, /knownDestinationIds\(shortsCfg\)/, "valida os nomes contra os destinos da config");
    assert.match(window, /return 2;/, "destino desconhecido aborta com exit 2");
  });
});

describe("#11912 runCorteTimerFor: dry-run -> nada; --publish confirmado -> só o --only", () => {
  const deps = (now: Date, calls: string[][], alarms: Array<{ destination: string; key: CorteTimerAlarmKey }>) => ({
    config: CONFIG,
    now,
    runScript: (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ results: [] }), stderr: "" };
    },
    notify: { cwd: "/nao-usado" },
    alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey) => {
      alarms.push({ destination, key });
      return true;
    },
  });

  it("corte só com dry-run: o timer não chama o publish nem alarma, no horário ou depois de 3 h", async () => {
    const dir = corteDir();
    for (const now of [at(10 * 60_000), at(4 * 3_600_000)]) {
      const calls: string[][] = [];
      const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
      assert.equal(await runCorteTimerFor(dir, false, deps(now, calls, alarms)), 0);
      assert.deepEqual([calls, alarms], [[], []]);
    }
  });

  it("depois do --publish confirmado com --only: o timer publica só esses destinos", async () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "instagram,linkedin_profile,youtube_shorts", KNOWN, "2026-11-02T20:00:00.000Z", () => {});
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--only") + 1], "linkedin_profile,instagram", "threads_profile ficou fora do --only autorizado");
  });
});

describe("#11912 item 1: trocar vídeo ou capa depois do 'pode publicar' não herda a autorização", () => {
  const deps = (now: Date, calls: string[][], alarms: Array<{ destination: string; key: CorteTimerAlarmKey }>) => ({
    config: CONFIG,
    now,
    runScript: (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ results: [] }), stderr: "" };
    },
    notify: { cwd: "/nao-usado" },
    alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey) => {
      alarms.push({ destination, key });
      return true;
    },
  });

  it("autorizado e depois o vídeo foi re-exportado no mesmo caminho: o timer não publica e alarma content-changed", async () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "instagram,linkedin_profile", KNOWN, AT, () => {});
    writeFileSync(join(dir, BASE.video), "mp4-reexportado");
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    assert.equal(await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms)), 0);
    assert.deepEqual(calls, [], "nada publicado");
    assert.deepEqual(alarms, [{ destination: "linkedin_profile", key: "content-changed" }, { destination: "instagram", key: "content-changed" }]);
    assert.equal(corteAlarmSeverity("content-changed"), "urgente");
    const body = buildCorteTimerAlarm({ spec: readSpec(dir), destination: "instagram", key: "content-changed", reason: "o vídeo do corte mudou" }).body;
    assert.match(body, /não é o arquivo aprovado/);
    assert.match(body, /--only instagram --publish --confirm-publish 261103/);
  });

  it("capa trocada (ou capa nova onde não havia) também barra o timer", async () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "threads_profile", KNOWN, AT, () => {});
    writeFileSync(join(dir, SHORT_COVER_FILE), "jpg-novo");
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.deepEqual([calls, alarms], [[], [{ destination: "threads_profile", key: "content-changed" }]]);
  });

  it("conteúdo igual ao aprovado: publica normalmente", async () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "threads_profile", KNOWN, AT, () => {});
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.equal(calls.length, 1);
    assert.ok(!alarms.some((a) => a.key === "content-changed"), JSON.stringify(alarms));
  });

  it("--cover com outra imagem derruba a autorização (e registra); com a mesma imagem, não", () => {
    const dir = corteDir();
    const cover = join(dir, "..", "capa.jpg");
    writeFileSync(cover, "jpg-a");
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {} });
    recordCortePublishAuthorization(dir, "instagram", KNOWN, AT, () => {});
    assert.equal(readSpec(dir).publish_confirmed_content?.cover_sha256, sha("jpg-a"));
    const revs: CorteRevocation[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {}, onRevoked: (r) => revs.push(r) });
    assert.deepEqual(corteAuthorizedDestinations(readSpec(dir)), ["instagram"], "mesma capa: segue autorizado");
    assert.equal(revs.length, 0);
    writeFileSync(cover, "jpg-b");
    prepareCorteRun({ slug: BASE.slug, dir, values: { cover }, positionalDate: "", log: () => {}, now: () => new Date(AT), onRevoked: (r) => revs.push(r) });
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null);
    assert.deepEqual(readSpec(dir).publish_revoked_destinations, ["instagram"]);
    assert.equal(revs.length, 1);
    assert.match(revs[0].reason, /a capa do corte mudou/);
  });

  it("--from-drive que baixa outro arquivo (sync depois do download) derruba; vídeo ausente não derruba", () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "instagram", KNOWN, AT, () => {});
    assert.ok(corteAuthorizedDestinations(syncCorteAuthorizationWithContent(dir, AT, { log: () => {} })), "mesmo arquivo: nada muda");
    writeFileSync(join(dir, BASE.video), "mp4-do-drive");
    const revs: CorteRevocation[] = [];
    const spec = syncCorteAuthorizationWithContent(dir, AT, { log: () => {}, onRevoked: (r) => revs.push(r) });
    assert.equal(corteAuthorizedDestinations(spec), null);
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null, "gravado");
    assert.match(revs[0].reason, /o vídeo do corte mudou/);
    const other = corteDir();
    recordCortePublishAuthorization(other, "instagram", KNOWN, AT, () => {});
    writeFileSync(join(other, BASE.video), "");
    const missing = join(other, "..", "sumiu.mp4");
    const s2 = { ...readSpec(other), video: missing };
    writeFileSync(join(other, CORTE_SPEC_FILE), JSON.stringify(s2));
    assert.ok(corteAuthorizedDestinations(syncCorteAuthorizationWithContent(other, AT, { log: () => {} })), "vídeo ausente nesta máquina: o timer alarma missing-video, não derruba");
  });

  it("corteContentFingerprint: sha256 do vídeo e da capa", () => {
    const dir = corteDir();
    assert.deepEqual(corteContentFingerprint(dir, readSpec(dir)), CONTENT);
    writeFileSync(join(dir, SHORT_COVER_FILE), "jpg");
    assert.deepEqual(corteContentFingerprint(dir, readSpec(dir)), { video_sha256: sha("mp4"), cover_sha256: sha("jpg") });
  });
});

describe("#11912 item 2: o filho do timer só confere a autorização, nunca concede", () => {
  it("cortePublishArgs passa --require-corte-authorization", () => {
    assert.ok(cortePublishArgs(BASE, ["instagram"]).includes("--require-corte-authorization"));
  });

  it("corteRunAuthorizationError: sem autorização, --only fora do autorizado, sem --only, conteúdo trocado", () => {
    assert.match(corteRunAuthorizationError(BASE, ["instagram"], CONTENT) ?? "", /sem o "pode publicar"/);
    assert.match(corteRunAuthorizationError({ ...BASE, publish_revoked_at: AT, publish_revoked_destinations: ["instagram"] }, ["instagram"], CONTENT) ?? "", /caiu em/);
    assert.match(corteRunAuthorizationError(authorized(["instagram"]), ["instagram", "threads_profile"], CONTENT) ?? "", /fora do "pode publicar".*threads_profile/);
    assert.match(corteRunAuthorizationError(authorized(["instagram"]), null, CONTENT) ?? "", /exige --only/);
    assert.match(corteRunAuthorizationError(authorized(["instagram"]), ["instagram"], { video_sha256: sha("x"), cover_sha256: null }) ?? "", /vídeo do corte mudou/);
    assert.equal(corteRunAuthorizationError(authorized(["instagram", "threads_profile"]), ["threads_profile"], CONTENT), null);
  });

  // Trava de FONTE: o guard de publicação proíbe executar o publish-shorts com --publish.
  it("main: com a flag confere e sai com 2; a gravação do 'pode publicar' fica no else (nunca com a flag)", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const main = src.slice(src.indexOf("async function main(): Promise<number>"));
    const check = main.indexOf("if (corte && requireCorteAuth) {");
    const record = main.indexOf("recordCortePublishAuthorization(dir,");
    assert.ok(check > 0 && record > check);
    assert.match(main.slice(check, record), /corteRunAuthorizationError\(fresh, onlyList, corteContentFingerprint\(dir, fresh\)\)[\s\S]*return 2;[\s\S]*\} else if \(corte\) \{/);
    assert.match(main, /--require-corte-authorization só vale com --corte/);
    assert.match(main, /--require-corte-authorization só vale com --publish e sem mudar o corte/);
  });
});

describe("#11912 item 3: autorização derrubada com destinos pendentes vira alarme, e o --update-scheduled confirmado regrava", () => {
  const revokedSpec = (dests: string[]): CorteSpec => ({ ...BASE, publish_revoked_at: "2026-11-02T22:00:00.000Z", publish_revoked_destinations: dests });

  it("antes do horário espera; no horário alarma revoked (urgência normal) só para os autorizados pendentes", () => {
    const before = decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["instagram", "linkedin_profile"]), registryRaws: [], now: at(-60_000) });
    assert.equal(before.kind, "skip");
    if (before.kind === "skip") assert.match(before.reason, /alarma no horário/);
    const raws = [{ path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: BASE.date, entries: [{ destination: "linkedin_profile", status: "published", id: "u", at: AT }] }) }];
    const d = decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["instagram", "linkedin_profile"]), registryRaws: raws, now: at(10 * 60_000) });
    if (d.kind !== "revoked") assert.fail(d.kind);
    assert.deepEqual(d.pending, ["instagram"]);
    assert.equal(corteAlarmSeverity("revoked"), "acao");
    assert.match(buildCorteTimerAlarm({ spec: BASE, destination: "instagram", key: "revoked", reason: d.reason }).body, /"pode publicar" de novo/);
    assert.equal(decideCorteTimerRun({ config: CONFIG, spec: revokedSpec(["linkedin_profile"]), registryRaws: raws, now: at(10 * 60_000) }).kind, "skip", "nada pendente: sem alarme");
    assert.equal(decideCorteTimerRun({ config: CONFIG, spec: BASE, registryRaws: [], now: at(10 * 60_000) }).kind, "skip", "nunca autorizado: sem alarme");
  });

  it("runCorteTimerFor: revoked alarma por destino e não publica", async () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "instagram,threads_profile", KNOWN, AT, () => {});
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {} });
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    const code = await runCorteTimerFor(dir, false, {
      config: CONFIG,
      now: at(10 * 60_000),
      runScript: (args: string[]) => (calls.push(args), { status: 0, stdout: "{}", stderr: "" }),
      notify: { cwd: "/nao-usado" },
      alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey) => (alarms.push({ destination, key }), true),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(alarms, [{ destination: "threads_profile", key: "revoked" }, { destination: "instagram", key: "revoked" }]);
  });

  it("--update-scheduled confirmado depois de corrigir o gancho: o 'pode publicar' volta para os mesmos destinos, com o conteúdo atual", () => {
    const dir = corteDir();
    recordCortePublishAuthorization(dir, "instagram,threads_profile", KNOWN, AT, () => {});
    prepareCorteRun({ slug: BASE.slug, dir, values: { hook: "Gancho corrigido." }, positionalDate: "", log: () => {} });
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null);
    const r = restoreCorteAuthorizationAfterUpdate(dir, "2026-11-02T23:00:00.000Z", KNOWN, () => {});
    assert.deepEqual(r, { restored: true, destinations: ["instagram", "threads_profile"] });
    const spec = readSpec(dir);
    assert.deepEqual(corteAuthorizedDestinations(spec), ["instagram", "threads_profile"]);
    assert.deepEqual(spec.publish_confirmed_content, CONTENT);
    assert.equal(spec.publish_revoked_at, undefined, "o registro de derrubada some");
    assert.equal(spec.hook, "Gancho corrigido.");
    assert.deepEqual(restoreCorteAuthorizationAfterUpdate(dir, AT, KNOWN, () => {}), { restored: false, reason: "a autorização continua valendo" });
    const never = corteDir();
    assert.equal(restoreCorteAuthorizationAfterUpdate(never, AT, KNOWN, () => {}).restored, false, "nunca autorizado: o --update-scheduled não concede");
  });

  // Trava de FONTE do fio no `runUpdateScheduled` (não executável: guard de publicação).
  it("runUpdateScheduled regrava só depois da saída do dry-run, e a derrubada sai no JSON", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function runUpdateScheduled("), src.indexOf("async function main(): Promise<number>"));
    const dry = fn.indexOf("if (!input.publish) {");
    const restore = fn.indexOf("restoreCorteAuthorizationAfterUpdate(");
    assert.ok(dry > 0 && restore > dry, "o dry-run do --update-scheduled não regrava");
    assert.match(fn, /dry_run: true, update_scheduled: true, aammdd, items, \.\.\.revokedOut/);
    assert.match(fn, /corte_authorization: corteAuthorization/);
    const main = src.slice(src.indexOf("async function main(): Promise<number>"));
    assert.match(main, /runUpdateScheduled\(\{[^}]*corteRevocations \}\)/);
    assert.match(main, /dry_run: true, \.\.\.plan, \.\.\.revokedOut\(\)/);
    assert.match(main, /dry_run: false, \.\.\.plan, results, summary, \.\.\.revokedOut\(\)/);
  });

  it("withoutCortePublishAuthorization: sem autorização preserva o registro anterior", () => {
    const prev = revokedSpec(["instagram"]);
    assert.equal(withoutCortePublishAuthorization(prev, "x").spec, prev);
    assert.equal(withoutCortePublishAuthorization(prev, "x").revoked, null);
  });
});
