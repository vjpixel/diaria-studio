/**
 * test/shorts-instagram-timer-11265.test.ts (#11265, #10940)
 *
 * O Reels do Instagram sai pelo timer do 300 no horário do vertical, sem URL
 * pública (decisão do editor 27/10/2026: túnel descartado, R2 não habilitado):
 * config, delegação no plano do `/diaria-shorts`, escopo do `--instagram-timer`,
 * registro próprio do timer, decisão "age agora?", escolha do arquivo, leitura
 * da saída do publish-shorts, conferência da conta antes de publicar, alarme
 * e o par horário do teste ↔ tasks. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alreadyAlarmed,
  buildInstagramTimerAlarm,
  chooseInstagramVideo,
  decideInstagramTimerRun,
  interpretInstagramTimerOutput,
} from "../scripts/shorts-instagram-timer.ts";
import {
  INSTAGRAM_TIMER_DETAIL,
  SHORTS_BOOLEAN_FLAGS,
  instagramTimerPreflight,
  parseShortsCliArgs,
  planShortsPublish,
  publicVideoUnavailableReason,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { loadShortsConfig, shortInstagramVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import {
  SHORTS_INSTAGRAM_TIMER_LEDGER_FILE,
  instagramTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryPath,
  shortsRegistryWriterFor,
} from "../scripts/lib/diaria/shorts-published-store.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import platformConfig from "../platform.config.json" with { type: "json" };

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = { facebook_pages: [], instagram: true, instagram_collaborators: ["vjpixel"], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE };
const CFG = { publishing: { shorts: SHORTS } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";

describe("#11265 config publishing.shorts.instagram_backend", () => {
  it("default é timer-300 (no código e no platform.config.json)", () => {
    assert.equal(loadShortsConfig({}).instagramBackend, "timer-300");
    assert.equal(loadShortsConfig(CFG).instagramBackend, "timer-300");
    assert.equal(loadShortsConfig(platformConfig).instagramBackend, "timer-300");
  });
  it("worker-r2 continua aceito; valor desconhecido lança", () => {
    assert.equal(loadShortsConfig({ publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } }).instagramBackend, "worker-r2");
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...SHORTS, instagram_backend: "tunnel" } } }), /instagram_backend/);
  });
  it("sem R2, X/Threads dizem que o R2 não é usado em vez de cobrar os secrets", () => {
    assert.doesNotMatch(publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]), /R2_ACCOUNT_ID/);
    assert.match(publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]), /#11265/);
    assert.match(publicVideoUnavailableReason("worker-r2", ["R2_ACCOUNT_ID"]), /falta R2_ACCOUNT_ID/);
  });
});

describe("#11265 plano: o timer é o dono do Instagram", () => {
  const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque com uma frase. Outra frase.\n";
  const pages: ResolvedFacebookPage[] = [];
  const base: Omit<ShortsPlanInput, "now"> = {
    aammdd: AAMMDD,
    reviewedMd: reviewed,
    config: CFG,
    pages,
    instagramReady: true,
    published: { aammdd: AAMMDD, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    videoDurationSeconds: 20,
    editionUrl: "https://diar.ia.br/p/x",
  };
  const ig = (p: ReturnType<typeof planShortsPublish>) => p.items.find((i) => i.destination === "instagram")!;

  it("rodada do /diaria-shorts (sem --instagram-timer): skip_delegated, nunca fila do Worker nem R2", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-27T03:00:00Z") });
    assert.equal(ig(p).action, "skip_delegated");
    assert.equal((ig(p) as { detail: string }).detail, INSTAGRAM_TIMER_DETAIL);
    assert.ok(!p.warnings.some((w) => /R2|fila do Worker/.test(w)));
  });
  it("também depois do horário e acima do teto: quem publica (ou avisa) é o timer", () => {
    assert.equal(ig(planShortsPublish({ ...base, now: new Date("2026-10-27T12:00:00Z") })).action, "skip_delegated");
    assert.equal(ig(planShortsPublish({ ...base, now: new Date("2026-10-27T12:00:00Z"), videoDurationSeconds: 50 })).action, "skip_delegated");
  });
  it("rodada do timer antes do horário: pending_schedule (nada sai)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, now: new Date("2026-10-27T10:00:00Z") });
    assert.equal(ig(p).action, "pending_schedule");
    assert.equal((ig(p) as { scheduledAt: string }).scheduledAt, AT);
    assert.ok(p.premises.some((x) => x.startsWith(`instagram: timer do 300 publica depois de ${AT}`)));
  });
  it("rodada do timer depois do horário: publish na hora (upload resumível, sem URL pública)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(ig(p).action, "publish");
  });
  it("rodada do timer mais de 3 h depois: skip_late (não publica fora do horário do teste)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, now: new Date("2026-10-27T14:30:00Z") });
    assert.equal(ig(p).action, "skip_late");
    assert.equal(ig(planShortsPublish({ ...base, instagramTimer: true, forceNow: true, now: new Date("2026-10-27T14:30:00Z") })).action, "publish");
  });
  it("rodada do timer com o vertical acima do teto: passo guiado (o timer avisa o editor)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, videoDurationSeconds: 50, now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(ig(p).action, "guided");
  });
  it("backend worker-r2: o caminho antigo (fila do Worker) segue igual", () => {
    const cfg = { publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } };
    const p = planShortsPublish({ ...base, config: cfg, now: new Date("2026-10-27T03:00:00Z"), instagramQueue: { ready: true, account: "diaria" } });
    assert.equal(ig(p).action, "enqueue");
  });
});

describe("#11265 escopo do --instagram-timer e registro próprio", () => {
  it("só --only instagram (ou --mark instagram=URL); nunca com --linkedin-timer nem --confirm-instagram", () => {
    assert.equal(instagramTimerScopeError({ instagramTimer: false, only: null }), null);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, only: ["instagram"] }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: null })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: ["instagram", "facebook:diaria"] })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, linkedinTimer: true, only: ["instagram"] })!, /não combina com --linkedin-timer/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: ["instagram"], confirmInstagram: true })!, /não combina com --confirm-instagram/);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, only: null, markDestination: "instagram" }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: null, markDestination: "x" })!, /só aceita instagram/);
  });
  it("--instagram-timer é flag booleana do CLI", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes("instagram-timer"));
    const r = parseShortsCliArgs([AAMMDD, "--only", "instagram", "--publish", "--instagram-timer"]);
    assert.ok(r.ok && r.flags.has("instagram-timer"));
  });
  it("o timer grava no arquivo próprio; a leitura une os registros; outro destino ali é recusado", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-ig-timer-"));
    try {
      assert.equal(shortsRegistryWriterFor(false, true), "instagram-timer");
      assert.equal(shortsRegistryPath(dir, "instagram-timer"), join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE));
      const entry = { destination: "instagram", status: "published" as const, id: "m1", url: "https://www.instagram.com/reel/m1/", scheduled_at: null, at: AT };
      persistShortEntry(dir, AAMMDD, "instagram-timer", entry);
      assert.ok(readShortsRegistry(dir, AAMMDD).entries.some((e) => e.destination === "instagram" && e.id === "m1"));
      assert.throws(() => persistShortEntry(dir, AAMMDD, "instagram-timer", { ...entry, destination: "facebook:diaria" }), /registro do timer só aceita instagram/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11265 decideInstagramTimerRun (age agora?)", () => {
  const base = { config: CFG, reviewedExists: true, registryRaws: [] as Array<{ path: string; raw: string }>, aammdd: AAMMDD };
  const raw = (dest: string, status: string) => JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: dest, status, id: "x", at: "t" }] });

  it("antes do horário do vertical: espera", () => {
    assert.equal(decideInstagramTimerRun({ ...base, now: new Date("2026-10-27T10:59:00Z") }).kind, "wait");
  });
  it("no horário e até 3 h depois: publica", () => {
    assert.deepEqual(decideInstagramTimerRun({ ...base, now: new Date("2026-10-27T11:00:00Z") }), { kind: "publish", at: AT, hhmm: "08:00" });
    assert.equal(decideInstagramTimerRun({ ...base, now: new Date("2026-10-27T13:59:00Z") }).kind, "publish");
  });
  it("mais de 3 h depois sem registro: late (alarme, não publica)", () => {
    const d = decideInstagramTimerRun({ ...base, now: new Date("2026-10-27T14:01:00Z") });
    assert.equal(d.kind, "late");
  });
  it("instagram registrado em qualquer arquivo (principal, do timer, cópia de conflito), inclusive send_unknown: nada a fazer", () => {
    for (const path of ["_internal/06-shorts-published.json", SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, "_internal/06-shorts-published-Neo.json"]) {
      for (const status of ["published", "send_unknown", "scheduled"]) {
        const d = decideInstagramTimerRun({ ...base, registryRaws: [{ path, raw: raw("instagram", status) }], now: new Date("2026-10-27T11:05:00Z") });
        assert.equal(d.kind, "skip", `${path} ${status}`);
      }
    }
  });
  it("outro destino registrado não conta", () => {
    const d = decideInstagramTimerRun({ ...base, registryRaws: [{ path: "x.json", raw: raw("linkedin_profile", "published") }], now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(d.kind, "publish");
  });
  it("registro ilegível lança (nunca vira 'nada publicado')", () => {
    assert.throws(() => decideInstagramTimerRun({ ...base, registryRaws: [{ path: "x.json", raw: "{" }], now: new Date("2026-10-27T11:05:00Z") }));
  });
  it("dia sem edição, Instagram desligado ou backend worker-r2: nada a fazer", () => {
    const now = new Date("2026-10-27T11:05:00Z");
    assert.equal(decideInstagramTimerRun({ ...base, reviewedExists: false, now }).kind, "skip");
    assert.equal(decideInstagramTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, instagram: false } } }, now }).kind, "skip");
    assert.equal(decideInstagramTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } }, now }).kind, "skip");
  });
});

describe("#11265 chooseInstagramVideo", () => {
  const paths = { instagramCutPath: "/e/ig.mp4", genericPath: "/e/short.mp4" };
  it("corte do Instagram no disco: usa sem ler o Drive", () => {
    assert.deepEqual(chooseInstagramVideo({ ...paths, instagramCutExists: true, genericExists: true, lookup: null }), { kind: "use", path: "/e/ig.mp4", source: "instagram-cut" });
  });
  it("corte no Drive: baixa pro caminho do corte", () => {
    const c = chooseInstagramVideo({ ...paths, instagramCutExists: false, genericExists: true, lookup: { kind: "found", fileId: "abcdefghijk", name: "Diaria comentada_Instagram_V3.mp4" } });
    assert.deepEqual(c, { kind: "use", path: "/e/ig.mp4", source: "instagram-cut", driveFileId: "abcdefghijk", driveName: "Diaria comentada_Instagram_V3.mp4" });
  });
  it("sem corte no Drive: o genérico só se já estiver no disco; senão espera", () => {
    assert.deepEqual(chooseInstagramVideo({ ...paths, instagramCutExists: false, genericExists: true, lookup: { kind: "wait", reason: "nada" } }), { kind: "use", path: "/e/short.mp4", source: "generic" });
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: false, genericExists: false, lookup: { kind: "wait", reason: "nada" } }).kind, "wait");
  });
  it("erro do Drive é erro (nunca cai no genérico em silêncio)", () => {
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: false, genericExists: true, lookup: { kind: "error", reason: "401" } }).kind, "error");
  });
  it("o arquivo do corte é o que a limpeza do vertical já apaga", () => {
    assert.equal(shortInstagramVideoFileName(AAMMDD), `diaria-comentada-${AAMMDD}-short-instagram.mp4`);
  });
});

describe("#11265 interpretInstagramTimerOutput", () => {
  const out = (o: object) => JSON.stringify({ dry_run: false, ...o });
  it("publicado → done", () => {
    const r = interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "publish" }], results: [{ destination: "instagram", ok: true, entry: { status: "published", id: "m1", url: "https://i/m1" } }] }));
    assert.equal(r.kind, "done");
  });
  it("já na conta (conferência antes de publicar) → done", () => {
    const r = interpretInstagramTimerOutput(0, out({ items: [], results: [{ destination: "instagram", ok: true, alreadyRegistered: true, entry: { status: "published", id: "m1" } }] }));
    assert.equal(r.kind, "done");
    assert.match(r.detail, /já estava/);
  });
  it("falha do publish → failed", () => {
    assert.equal(interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, error: "rupload 400" }] })).kind, "failed");
  });
  it("pendente → wait; guiado/atraso → needs-editor; sem credencial → failed; sem JSON → failed", () => {
    assert.equal(interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "pending_schedule", detail: "d" }], results: [] })).kind, "wait");
    assert.equal(interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "guided", detail: "teto" }], results: [] })).kind, "needs-editor");
    assert.equal(interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "skip_late", detail: "3 h" }], results: [] })).kind, "needs-editor");
    assert.equal(interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "skip_missing_credentials", detail: "INSTAGRAM_*" }], results: [] })).kind, "failed");
    assert.equal(interpretInstagramTimerOutput(2, "publish-shorts: uso").kind, "failed");
  });
});

describe("#11265 conferência da conta antes de publicar (instagramTimerPreflight)", () => {
  const entry = { destination: "instagram", status: "published" as const, id: "m1", scheduled_at: null, at: AT };
  it("Reels da edição achado na conta → grava e não publica", () => {
    assert.deepEqual(instagramTimerPreflight({ kind: "register", entry, candidates: [], matchedBy: "marker" }), { kind: "already", entry, matchedBy: "marker" });
  });
  it("nada na conta (ou nenhum da edição) → publica", () => {
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "none" }).kind, "proceed");
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "no-match" }).kind, "proceed");
  });
  it("ambíguo ou leitura incompleta → não publica", () => {
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "ambiguous" }).kind, "block");
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "window" }).kind, "block");
  });
});

describe("#11265 alarme", () => {
  it("o mesmo motivo não repete na mesma edição; estado ilegível avisa de novo", () => {
    assert.equal(alreadyAlarmed(null, "late"), false);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "late"), true);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "needs-editor:x"), false);
    assert.equal(alreadyAlarmed("{", "late"), false);
  });
  it("o corpo traz o motivo e o caminho manual", () => {
    const a = buildInstagramTimerAlarm(AAMMDD, "acima do teto");
    assert.match(a.subject, new RegExp(AAMMDD));
    assert.match(a.body, /acima do teto/);
    assert.match(a.body, /--confirm-instagram/);
    assert.match(a.body, /--instagram-timer/);
  });
});

describe("#11265 tasks do 300 cobrem os horários do vertical", () => {
  const daily = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Instagram");
  const hourly = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Instagram-Catchup");
  it("as duas tasks existem, armáveis, rodando o script do timer, com guard da junction data/", () => {
    for (const t of [daily, hourly]) {
      assert.ok(t);
      assert.notEqual(t!.enabled, false);
      assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/shorts-instagram-timer.ts"]);
      assert.equal(t!.guard?.requiredFile, "editions");
    }
    assert.deepEqual(hourly!.schedule, { kind: "interval", hours: 1 });
  });
  it("todo horário do teste fora da hora cheia cai na diária em até 2 min (o resto, na de hora em hora)", () => {
    const times: string[] = (platformConfig as any).publishing.shorts.schedule.rotation_times;
    const d = daily!.schedule as { kind: "daily"; hour: number; minute: number };
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      if (m === 0) continue;
      const delta = d.hour * 60 + d.minute - (h * 60 + m);
      assert.ok(delta >= 0 && delta <= 2, `${t} BRT sem execução logo depois (diária às ${d.hour}:${d.minute})`);
    }
  });
});

describe("#11265/#10978 roteiro da skill", () => {
  const skill = readFileSync(new URL("../.claude/skills/diaria-publica-video/SKILL.md", import.meta.url), "utf8");
  it("INSTAGRAM_TIMER_DETAIL e o SKILL.md mandam rodar com --only instagram --instagram-timer", () => {
    assert.match(INSTAGRAM_TIMER_DETAIL, /--only instagram --instagram-timer/);
    assert.match(skill, /--only instagram --publish --instagram-timer/);
    assert.match(skill, /Diaria-Shorts-Instagram/);
  });
  it("o diálogo de proporção aceita as duas nomenclaturas, sem afirmar qual aparece (#10978 item 2)", () => {
    const step = skill.split("\n").find((l) => l.startsWith("3. **Propor"))!;
    assert.ok(step, "passo 3 do B3b presente");
    assert.match(step, /"9:16"/);
    assert.match(step, /"Original"/);
    assert.doesNotMatch(step, /escolher 9:16\./);
  });
});

describe("#11265 limpeza", () => {
  it("o registro do timer entra na leitura unida (decide skip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-ig-timer-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "instagram", status: "published", id: "m", at: AT }] }));
      assert.ok(readShortsRegistry(dir, AAMMDD).entries.some((e) => e.destination === "instagram"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
