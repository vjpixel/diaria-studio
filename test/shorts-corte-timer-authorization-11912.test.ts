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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCorteTimerRun, runCorteTimerFor, type CorteTimerAlarmKey } from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, corteAuthorizedDestinations, parseCorteSpec, withCortePublishAuthorization, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { prepareCorteRun, recordCortePublishAuthorization } from "../scripts/publish-shorts.ts";

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
const authorized = (dests: "all" | string[]): CorteSpec => ({ ...BASE, publish_confirmed_at: "2026-11-02T20:00:00.000Z", publish_confirmed_destinations: dests });

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
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(["instagram", "youtube"]), registryRaws: [], now: at(10 * 60_000) });
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
  it("soma destinos; sem --only vira all; o --only do timer (subconjunto) não regrava", () => {
    const first = withCortePublishAuthorization(BASE, ["instagram"], "2026-11-02T20:00:00.000Z");
    assert.equal(first.changed, true);
    assert.deepEqual(corteAuthorizedDestinations(first.spec), ["instagram"]);
    const more = withCortePublishAuthorization(first.spec, ["linkedin_profile", "instagram"], "2026-11-02T21:00:00.000Z");
    assert.deepEqual(corteAuthorizedDestinations(more.spec), ["instagram", "linkedin_profile"]);
    assert.equal(withCortePublishAuthorization(more.spec, ["instagram"], "2026-11-03T11:10:00.000Z").changed, false);
    assert.equal(corteAuthorizedDestinations(withCortePublishAuthorization(more.spec, null, "x").spec), "all");
    assert.equal(withCortePublishAuthorization(authorized("all"), ["instagram"], "x").changed, false);
    assert.equal(withCortePublishAuthorization(BASE, [], "x").changed, false, "--only vazio não autoriza nada");
  });

  it("marcador malformado lança (nunca vira autorizado em silêncio)", () => {
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: "2026-11-02T20:00:00.000Z" }), "x.json"), /andam juntos/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: "ontem", publish_confirmed_destinations: "all" }), "x.json"), /ISO/);
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...BASE, publish_confirmed_at: AT, publish_confirmed_destinations: [] }), "x.json"), /lista de destinos/);
    assert.deepEqual(corteAuthorizedDestinations(parseCorteSpec(JSON.stringify(authorized(["instagram"])), "x.json")), ["instagram"]);
  });

  it("dry-run idêntico mantém a autorização; dry-run que muda o plano derruba", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11912-"));
    const values = { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) };
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    const read = () => parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
    assert.equal(corteAuthorizedDestinations(read()), null, "o dry-run grava o corte.json SEM autorização");
    recordCortePublishAuthorization(dir, "instagram", "2026-11-02T20:00:00.000Z", () => {});
    prepareCorteRun({ slug: BASE.slug, dir, values, positionalDate: "", log: () => {} });
    assert.deepEqual(corteAuthorizedDestinations(read()), ["instagram"], "mesmo plano: a autorização segue");
    const logs: string[] = [];
    prepareCorteRun({ slug: BASE.slug, dir, values: { title: "Outro título" }, positionalDate: "", log: (l) => logs.push(l) });
    assert.equal(corteAuthorizedDestinations(read()), null, "plano novo: o 'pode publicar' antigo não vale");
    assert.ok(logs.some((l) => /autorização de publicação anterior caiu/.test(l)), logs.join("\n"));
  });

  it("publish-shorts grava a autorização só no --publish confirmado (depois da checagem da confirmação)", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const call = src.indexOf("recordCortePublishAuthorization(dir,");
    assert.ok(call > 0);
    const guard = src.lastIndexOf('if (corte && flags.has("publish") && !flags.has("update-scheduled") && !values["mark"])', call);
    assert.ok(guard > 0 && call - guard < 200, "a chamada fica dentro do if do --publish do corte");
    const confirm = src.lastIndexOf("publishConfirmationError({", call);
    assert.ok(confirm > 0 && confirm < guard, "a confirmação (#11741) é checada antes de gravar");
  });
});

describe("#11912 runCorteTimerFor: dry-run -> nada; --publish confirmado -> só o --only", () => {
  function corteDir(): string {
    const root = mkdtempSync(join(tmpdir(), "corte-timer-11912-"));
    const dir = join(root, BASE.slug);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, BASE.video), "mp4");
    prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
    return dir;
  }
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
    recordCortePublishAuthorization(dir, "instagram,linkedin_profile,youtube", "2026-11-02T20:00:00.000Z", () => {});
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--only") + 1], "linkedin_profile,instagram", "threads_profile ficou fora do --only autorizado");
  });
});
