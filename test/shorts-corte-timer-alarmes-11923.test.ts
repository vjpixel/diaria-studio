/**
 * #11923: alarmes do timer do corte não podem ser enganosos nem se perder em
 * falha transitória (OneDrive) — resíduo do review da #11917. Itens 1, 2, 3 e
 * 5 vieram na PR #11928; itens 4, 6, 7 e 8 no resíduo. Sem rede, sem publicar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  corteAlarmId,
  corteAlarmVariant,
  decideCorteTimerRun,
  interpretCorteTimerOutput,
  runCorteTimerFor,
  type CorteTimerDecision,
  type CorteTimerSideAlarm,
} from "../scripts/shorts-corte-timer.ts";
import {
  corteTimerChildRefusal,
  prepareCorteRun,
  readShortCover,
  recordCortePublishAuthorization,
  restoreCorteAuthorizationAfterUpdate,
} from "../scripts/publish-shorts.ts";
import { CORTE_SPEC_FILE, corteAuthorizedDestinations, parseCorteSpec, type CorteContentFingerprint, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { SHORT_COVER_FILE } from "../scripts/lib/diaria/short-cover.ts";

const keys = (refused: string) =>
  interpretCorteTimerOutput(2, JSON.stringify({ authorization_refused: refused, reason: "m" }), ["instagram"]).map((o) => (o.kind === "alarm" ? o.key : o.kind));

describe("#11923", () => {
  it("1: spec-unreadable vira chave de retry (crash), nunca revoked", () => {
    assert.deepEqual(keys("spec-unreadable"), ["crash"]);
  });

  it("3: motivo desconhecido cai em crash, não em revoked enganoso", () => {
    assert.deepEqual(keys("motivo-do-futuro"), ["crash"]);
    assert.deepEqual(keys("revoked"), ["revoked"]);
  });

  it("1: o filho recusa com spec-unreadable (e não revoked) quando reler o corte.json lança", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(src, /refusal = \{ refused: "spec-unreadable"/);
    assert.match(src, /"content-changed" \| "missing-content" \| "spec-unreadable"/);
  });

  it("5: restoreCorteAuthorizationAfterUpdate nunca lança (corte.json ilegível)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11923-"));
    writeFileSync(join(dir, "corte.json"), "{ json pela metade");
    const r = restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), new Set(["instagram"]), null, () => {});
    assert.equal(r.restored, false);
  });

  it("5: sem corte.json também não lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11923-"));
    const r = restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), new Set(), null, () => {});
    assert.equal(r.restored, false);
  });

  it("2: a variante do alarme que relê o corte é calculada em try/catch (fonte)", () => {
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(src, /let variant = rereads \? undefined[\s\S]*try \{[\s\S]*corteAlarmVariant\(o\.key[\s\S]*\} catch/);
  });
});

// ── Resíduo (itens 4, 6, 7, 8) ──────────────────────────────────────────────

const BASE: CorteSpec = { slug: "corte-extra", date: "261103", hhmm: "08:00", title: "Título do corte", hook: "Gancho do corte.", video: "corte-corte-extra.mp4" };
const AT = "2026-11-03T11:00:00.000Z"; // 08:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const CONFIG = {
  publishing: {
    shorts: {
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
    },
  },
};
const KNOWN = new Set(["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CONTENT: CorteContentFingerprint = { video_sha256: sha("mp4"), cover_sha256: null };
const readSpec = (dir: string) => parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
/** Pasta de corte com vídeo ("mp4") e corte.json do dry-run (sem autorização). */
function corteDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "corte-11923-")), BASE.slug);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, BASE.video), "mp4");
  prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
  return dir;
}
const alarmsOf = (d: CorteTimerDecision): CorteTimerSideAlarm[] => (d.kind === "wait" ? [] : d.alarms ?? []);
const grant = (dir: string, only: string) => recordCortePublishAuthorization(dir, only, KNOWN, corteContentFingerprint(dir, readSpec(dir)), AT, () => {});

describe("#11923 item 4: capa existente e ilegível não grava o 'pode publicar'", () => {
  it("readShortCover devolve unreadable quando a capa existe e a leitura falha", () => {
    const dir = corteDir();
    mkdirSync(join(dir, SHORT_COVER_FILE)); // diretório no lugar do jpg: stat ok (size > 0), a leitura lança
    const cover = readShortCover(dir);
    assert.equal(cover.bytes, null);
    assert.equal(typeof cover.unreadable, "string");
  });

  it("capa ausente segue sem unreadable", () => {
    assert.equal(readShortCover(corteDir()).unreadable, undefined);
  });

  it("recordCortePublishAuthorization recusa com coverUnreadable e não toca o corte.json", () => {
    const dir = corteDir();
    const before = readFileSync(join(dir, CORTE_SPEC_FILE), "utf8");
    assert.throws(
      () => recordCortePublishAuthorization(dir, "instagram", KNOWN, corteContentFingerprint(dir, readSpec(dir)), AT, () => {}, "EBUSY"),
      /capa do corte existe mas não pôde ser lida \(EBUSY\)/,
    );
    assert.equal(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), before);
    assert.equal(corteAuthorizedDestinations(readSpec(dir)), null);
  });

  it("o main repassa o unreadable da capa à gravação da autorização (fonte)", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(src, /recordCortePublishAuthorization\([^;]*shortCover\.unreadable\)/);
  });
});

describe("#11923 item 6: destino revogado e renomeado na config alarma unknown-destination", () => {
  it("no horário, o nome derrubado que a config não conhece alarma; o conhecido segue revoked", () => {
    const spec: CorteSpec = {
      ...BASE,
      publish_revoked_at: "2026-11-02T22:00:00.000Z",
      publish_revoked_destinations: ["tiktok_velho", "instagram"],
      publish_revoked_reason_kind: "plan",
      publish_revoked_content: CONTENT,
    };
    const d = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: [], now: at(10 * 60_000) });
    assert.equal(d.kind, "skip");
    assert.deepEqual(
      alarmsOf(d).map((a) => [a.destination, a.key]),
      [["tiktok_velho", "unknown-destination"], ["instagram", "revoked"]],
    );
  });

  it("nome autorizado E revogado não alarma duas vezes", () => {
    const spec: CorteSpec = {
      ...BASE,
      publish_confirmed_at: "2026-11-02T23:00:00.000Z",
      publish_confirmed_destinations: ["tiktok_velho", "instagram"],
      publish_confirmed_content: CONTENT,
      publish_revoked_at: "2026-11-02T22:00:00.000Z",
      publish_revoked_destinations: ["tiktok_velho"],
      publish_revoked_reason_kind: "content",
    };
    const d = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: [], now: at(10 * 60_000) });
    assert.deepEqual(alarmsOf(d).filter((a) => a.destination === "tiktok_velho").map((a) => a.key), ["unknown-destination"]);
  });
});

describe("#11923 item 7: late, missing-video e unknown-destination com variante", () => {
  it("replanejar para outra data muda o id de late e missing-video", () => {
    const moved: CorteSpec = { ...BASE, date: "261104" };
    for (const key of ["late", "missing-video"] as const) {
      const a = corteAlarmId("instagram", key, corteAlarmVariant(key, BASE, null));
      const b = corteAlarmId("instagram", key, corteAlarmVariant(key, moved, null));
      assert.notEqual(a, b, key);
      assert.equal(a, `instagram:${key}:261103-08:00`);
    }
  });

  it("unknown-destination leva a data da autorização (ou da queda)", () => {
    assert.equal(corteAlarmVariant("unknown-destination", { ...BASE, publish_confirmed_at: "X" }, null), "X");
    assert.equal(corteAlarmVariant("unknown-destination", { ...BASE, publish_revoked_at: "Y" }, null), "Y");
  });

  it("runCorteTimerFor passa a variante no late e no vídeo ausente", async () => {
    const dir = corteDir();
    grant(dir, "instagram");
    const alarms: Array<[string, string, string | undefined]> = [];
    const deps = (now: Date) => ({
      config: CONFIG,
      now,
      runScript: () => ({ status: 0, stdout: "{}", stderr: "" }),
      notify: { cwd: "/nao-usado" },
      alarm: async (_d: string, _s: CorteSpec, destination: string, key: string, _r: string, variant?: string) => {
        alarms.push([destination, key, variant]);
        return true;
      },
    });
    await runCorteTimerFor(dir, false, deps(at(4 * 3_600_000)));
    assert.deepEqual(alarms, [["instagram", "late", "261103-08:00"]]);
    alarms.length = 0;
    rmSync(join(dir, BASE.video));
    await runCorteTimerFor(dir, false, deps(at(10 * 60_000)));
    assert.deepEqual(alarms, [["instagram", "missing-video", "261103-08:00"]]);
  });
});

describe("#11923 item 8: alarmes do plano trocado", () => {
  const auth = (extra: Partial<CorteSpec> = {}): CorteSpec => ({
    ...BASE,
    publish_confirmed_at: "2026-11-02T20:00:00.000Z",
    publish_confirmed_destinations: ["instagram"],
    publish_confirmed_content: CONTENT,
    ...extra,
  });

  it("plano trocado no meio da rodada, com o novo já autorizado: replanned (não revoked)", () => {
    const r = corteTimerChildRefusal(auth({ title: "Título novo", publish_confirmed_at: "2026-11-03T10:00:00.000Z" }), auth(), ["instagram"], CONTENT);
    assert.equal(r?.refused, "replanned");
  });

  it("plano trocado sem autorização para o novo segue revoked; sem troca, a conferência de sempre", () => {
    const { publish_confirmed_at: _a, publish_confirmed_destinations: _d, publish_confirmed_content: _c, ...unauth } = auth({ title: "Título novo" });
    assert.equal(corteTimerChildRefusal(unauth, auth(), ["instagram"], CONTENT)?.refused, "revoked");
    assert.equal(corteTimerChildRefusal(auth(), auth(), ["instagram"], CONTENT), null);
  });

  it("o timer lê replanned como espera (sem alarme)", () => {
    assert.deepEqual(keys("replanned"), ["wait"]);
  });

  it("título e --cover na mesma rodada: a queda vira content (o alarme não diz só 'o plano mudou')", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    const cover = join(dirname(dir), "capa-nova.jpg");
    writeFileSync(cover, "jpg-novo");
    prepareCorteRun({ slug: BASE.slug, dir, values: { title: "Título novo", cover }, positionalDate: "", log: () => {}, now: () => at(0) });
    const spec = readSpec(dir);
    assert.equal(spec.publish_revoked_reason_kind, "content");
    assert.equal(spec.publish_revoked_content, undefined);
    assert.deepEqual(spec.publish_revoked_destinations, ["instagram"]);
    const d = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: [], now: at(10 * 60_000) });
    assert.match(alarmsOf(d)[0]?.reason ?? "",/o vídeo\/capa mudou/);
  });

  it("só o título: a queda continua plan", () => {
    const dir = corteDir();
    grant(dir, "instagram");
    prepareCorteRun({ slug: BASE.slug, dir, values: { title: "Título novo" }, positionalDate: "", log: () => {}, now: () => at(0) });
    assert.equal(readSpec(dir).publish_revoked_reason_kind, "plan");
  });
});
