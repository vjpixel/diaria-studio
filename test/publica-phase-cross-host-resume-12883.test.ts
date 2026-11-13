/**
 * test/publica-phase-cross-host-resume-12883.test.ts (#12883)
 *
 * Follow-up do fluxo híbrido (#12655, PR #12879):
 *
 * 1. Tarefa do `publica-phase run` iniciada em OUTRA máquina não ficava
 *    `running` para sempre? Ficava: a órfã só era detectada pelo PID nesta
 *    máquina. Agora expira pelo relógio (`CROSS_HOST_STALE_MS` desde o último
 *    evento) e vira `orphaned` (`cross-host-stale`), com o retry ainda
 *    exigindo a releitura do registro (#11741).
 * 2. A retomada de um upload já registrado (só refaz podcast/legenda) era
 *    recusada pelo `run --phase upload` (sem autorização ativa, regra de
 *    retry). Agora passa com `--resume-existing`, só com o registro `done` e
 *    sem `--force` no comando.
 *
 * Nada publica: deps injetadas, diretório temporário, comando espião.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CROSS_HOST_STALE_MS,
  PUBLICA_PHASES_FILE,
  buildPhaseEvent,
  checkPhaseStart,
  deriveTasks,
  joinCheck,
  parsePhaseEvents,
  type PhaseEvent,
  type PhaseEventKind,
} from "../scripts/lib/diaria/publica-phases.ts";
import { checkExternalEffect } from "../scripts/lib/diaria/publica-effect-gate.ts";
import { buildHorizontalManifest, planSha256, sha256Hex, writeVideoPlanManifest, type VideoPlanManifest } from "../scripts/lib/diaria/video-publish-plan.ts";
import {
  authorizationStorePath,
  currentHost,
  emptyAuthorizationStore,
  grantVideoPublishAuthorization,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import { main as phaseMain, type PhaseCliDeps } from "../scripts/publica-phase.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";

const ED = "261112";
const T0 = new Date("2026-11-11T22:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const HOST = currentHost();
const OTHER = `${HOST}-outra-maquina`;
const STALE_MIN = CROSS_HOST_STALE_MS / 60_000;

function ev(phase: string, part: string, event: PhaseEventKind, min: number, over: Partial<Parameters<typeof buildPhaseEvent>[0]> = {}): PhaseEvent {
  return buildPhaseEvent({ edition: ED, phase, part, event, at: at(min), attempt: 1, sessionId: "S1", ...over });
}

/** `run` aberto em outra máquina (wrapper com PID e host de lá). */
function remoteRun(phase: string, part: string, min: number, over: Partial<Parameters<typeof buildPhaseEvent>[0]> = {}): PhaseEvent {
  return ev(phase, part, "start", min, { background: true, taskId: "pid-77", pid: 77, host: OTHER, ...over });
}

// O PID 77 "vive" nesta máquina: prova que a expiração não depende do PID local.
const aliveHere = () => true;

describe("#12883 tarefa de outra máquina expira pelo relógio", () => {
  it("dentro do prazo segue running; passado o prazo vira orphaned (cross-host-stale)", () => {
    const events = [remoteRun("vertical-api", "vertical", 0)];
    const within = deriveTasks(events, { isPidAlive: aliveHere, host: HOST, now: at(STALE_MIN - 1).getTime() });
    assert.equal(within[0].status, "running");
    const after = deriveTasks(events, { isPidAlive: aliveHere, host: HOST, now: at(STALE_MIN + 1).getTime() });
    assert.equal(after[0].status, "orphaned");
    assert.equal(after[0].orphan_reason, "cross-host-stale");
  });

  it("sem `now` a tarefa de outra máquina nunca expira (comportamento anterior)", () => {
    const events = [remoteRun("vertical-api", "vertical", 0)];
    assert.equal(deriveTasks(events, { isPidAlive: () => false, host: HOST })[0].status, "running");
  });

  it("o `spawned` conta como sinal de vida: o prazo corre do último evento", () => {
    const events = [remoteRun("vertical-api", "vertical", 0), ev("vertical-api", "vertical", "spawned", 60, { background: true, taskId: "pid-77", childPid: 78, host: OTHER })];
    const t = deriveTasks(events, { isPidAlive: aliveHere, host: HOST, now: at(STALE_MIN + 30).getTime() })[0];
    assert.equal(t.status, "running", "60 min depois do start ainda dentro do prazo pelo spawned");
    assert.equal(t.last_event_at, at(60).toISOString());
  });

  it("tarefa desta máquina continua pelo PID, não pelo relógio", () => {
    const local = [ev("vertical-api", "vertical", "start", 0, { background: true, taskId: "pid-5", pid: 5, host: HOST })];
    const t = deriveTasks(local, { isPidAlive: () => true, host: HOST, now: at(10 * STALE_MIN).getTime() })[0];
    assert.equal(t.status, "running");
    const dead = deriveTasks(local, { isPidAlive: () => false, host: HOST, now: at(1).getTime() })[0];
    assert.equal(dead.orphan_reason, "pid-dead");
  });

  it("start manual (sem PID) de outra máquina nunca vira órfã", () => {
    const manual = [ev("vertical-guiado", "vertical", "start", 0)];
    assert.equal(deriveTasks(manual, { isPidAlive: () => false, host: HOST, now: at(10 * STALE_MIN).getTime() })[0].status, "running");
  });

  it("Chrome preso por run de outra máquina: recusa diz quando expira; expirada libera e o retry exige releitura", () => {
    const events = [remoteRun("vertical-guiado", "vertical", 0)];
    const opts = (min: number) => ({ isPidAlive: aliveHere, host: HOST, now: at(min).getTime() });
    const busy = checkPhaseStart({ events, candidate: ev("stage6-teste", "sessao", "start", 5, { extraResources: ["chrome"] }), deriveOptions: opts(5) });
    assert.match(busy.join("\n"), /recurso ocupado: chrome/);
    assert.match(busy.join("\n"), /outra máquina .* expira sozinha em/);

    const free = checkPhaseStart({ events, candidate: ev("stage6-teste", "sessao", "start", STALE_MIN + 5, { extraResources: ["chrome"] }), deriveOptions: opts(STALE_MIN + 5) });
    assert.deepEqual(free, []);

    const retry = ev("vertical-guiado", "vertical", "start", STALE_MIN + 5, { attempt: 2 });
    assert.match(checkPhaseStart({ events, candidate: retry, deriveOptions: opts(STALE_MIN + 5) }).join(), /releia o registro/);
  });

  it("join acusa a órfã de outra máquina como tal", () => {
    const events = [remoteRun("vertical-api", "vertical", 0)];
    const pending = joinCheck(events, { step5: false, step6: false }, { isPidAlive: aliveHere, host: HOST, now: at(10).getTime() });
    assert.equal(pending.ok, false);
    assert.match(pending.problems.join(), /pendente: vertical-api\/vertical.*outra máquina/);
    const stale = joinCheck(events, { step5: false, step6: false }, { isPidAlive: aliveHere, host: HOST, now: at(STALE_MIN + 1).getTime() });
    assert.equal(stale.ok, false);
    assert.match(stale.problems.join(), /órfã: vertical-api\/vertical \(iniciada em outra máquina/);
  });
});

function horizontal(): VideoPlanManifest {
  return buildHorizontalManifest({
    aammdd: ED,
    metadata: { title: "Ensinaram a IA e foram demitidos", description: "desc", tags: ["ia"] },
    schedule: { mode: "scheduled", publishAt: "2026-11-12T09:00:00.000Z" },
    privacy: "private",
    media: { video_sha256: sha256Hex("video"), cover_sha256: sha256Hex("capa"), captions_sha256: null },
    sources: { reviewed: sha256Hex("rev") },
    command: `npx tsx scripts/publish-youtube.ts ${ED} --upload --confirm-publish ${ED}`,
    generatedAt: T0.toISOString(),
  });
}

describe("#12883 CLI", () => {
  let dir: string;
  let errs: string[];
  let spawned: string[][];
  let clock: Date;
  let exitCode: number;
  const deps = (): PhaseCliDeps => ({
    log: () => {},
    err: (l) => errs.push(l),
    now: () => clock,
    env: { CLAUDE_CODE_SESSION_ID: "S2" },
    host: HOST,
    pid: 4242,
    isPidAlive: () => true,
    runLog: () => {},
    videoGate: () => ({ status: "video-without-link", blocking: true, warning: "sem link" }),
    spawnCommand: async (argv) => {
      spawned.push(argv);
      return { code: exitCode, signal: null };
    },
  });
  const phases = () => (existsSync(join(dir, PUBLICA_PHASES_FILE)) ? parsePhaseEvents(readFileSync(join(dir, PUBLICA_PHASES_FILE), "utf8")).events : []);
  const writeRecord = (rec: unknown) => writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(rec));
  const upload = (...extra: string[]) => ["run", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir, ...extra];
  const cmd = ["--", "npx", "tsx", "scripts/publish-youtube.ts", ED, "--upload", "--confirm-publish", ED];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "publica-12883-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    errs = [];
    spawned = [];
    clock = T0;
    exitCode = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("run de outra máquina segura o Chrome até expirar; o interrupted manual ainda fecha", async () => {
    appendFileSync(join(dir, PUBLICA_PHASES_FILE), JSON.stringify(remoteRun("vertical-guiado", "vertical", 0)) + "\n");
    clock = at(30);
    assert.equal(await phaseMain(["start", ED, "--phase", "stage6-teste", "--part", "sessao", "--resources", "chrome", "--edition-dir", dir], deps()), 1);
    assert.match(errs.join("\n"), /outra máquina/);

    clock = at(STALE_MIN + 1);
    errs = [];
    assert.equal(await phaseMain(["start", ED, "--phase", "stage6-teste", "--part", "sessao", "--resources", "chrome", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["end", ED, "--phase", "stage6-teste", "--part", "sessao", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--edition-dir", dir], deps()), 1, "a órfã de outra máquina ainda segura o join");
    assert.match(errs.join("\n"), /órfã: vertical-guiado\/vertical \(iniciada em outra máquina/);

    assert.equal(await phaseMain(["interrupted", ED, "--phase", "vertical-guiado", "--part", "vertical", "--task-id", "pid-77", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--edition-dir", dir], deps()), 0);
  });

  it("retomada com o vídeo registrado: sem a flag recusa; com --resume-existing roda mesmo depois de erro e sem autorização ativa", async () => {
    const m = horizontal();
    writeVideoPlanManifest(dir, m);
    const g = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation: "pode publicar", now: T0, host: HOST, isPidAlive: () => false });
    assert.ok(g.ok);
    writeFileSync(authorizationStorePath(dir), JSON.stringify(g.store, null, 2));
    exitCode = 1; // vídeo subiu, mas a rodada saiu com erro (ex.: podcast/legenda)
    assert.equal(await phaseMain([...upload(), ...cmd], deps()), 1);
    assert.equal(phases()[1].event, "error");
    writeRecord({ aammdd: ED, videoId: "abc123XYZ", url: "https://youtu.be/abc123XYZ", state: "draft" });
    // O publisher consumiu a autorização: o store volta sem nenhuma ativa.
    writeFileSync(authorizationStorePath(dir), JSON.stringify(emptyAuthorizationStore(ED), null, 2));

    clock = at(20);
    exitCode = 0;
    spawned = [];
    errs = [];
    assert.equal(await phaseMain([...upload(), ...cmd], deps()), 1, "sem a flag segue recusado");
    assert.deepEqual(spawned, []);
    assert.match(errs.join("\n"), /releia o registro|sem autorização ativa/);

    errs = [];
    assert.equal(await phaseMain([...upload("--resume-existing"), ...cmd], deps()), 0);
    assert.equal(spawned.length, 1);
    const starts = phases().filter((e) => e.event === "start");
    assert.match(starts[starts.length - 1].detail ?? "", /retomada do vídeo registrado abc123XYZ/);
    assert.equal(phases().at(-1)?.event, "end");
  });

  it("--resume-existing com --force no comando recusa sem rodar nada", async () => {
    writeVideoPlanManifest(dir, horizontal());
    writeRecord({ aammdd: ED, videoId: "abc123XYZ", url: "https://youtu.be/abc123XYZ" });
    assert.equal(await phaseMain([...upload("--resume-existing"), ...cmd, "--force"], deps()), 1);
    assert.deepEqual(spawned, []);
    assert.deepEqual(phases(), []);
    assert.match(errs.join("\n"), /--force cria OUTRO vídeo/);
  });

  it("--resume-existing sem registro, com marcador incerto ou de outra edição recusa", async () => {
    writeVideoPlanManifest(dir, horizontal());
    assert.equal(await phaseMain([...upload("--resume-existing"), ...cmd], deps()), 1);
    assert.match(errs.join("\n"), /sem vídeo registrado/);

    errs = [];
    writeRecord({ aammdd: ED, status: "upload_indeterminado", at: T0.toISOString(), video_path: "v.mp4", title: "t" });
    assert.equal(await phaseMain([...upload("--resume-existing"), ...cmd], deps()), 1);
    assert.match(errs.join("\n"), /estado incerto/);

    errs = [];
    writeRecord({ aammdd: "261111", videoId: "old", url: "https://youtu.be/old" });
    assert.equal(await phaseMain([...upload("--resume-existing"), ...cmd], deps()), 1);
    assert.match(errs.join("\n"), /outra edição/);
    assert.deepEqual(spawned, []);
    assert.deepEqual(phases(), []);
  });

  it("--resume-existing fora de upload/horizontal é erro de uso", async () => {
    assert.equal(await phaseMain(["start", ED, "--phase", "vertical-api", "--part", "vertical", "--resume-existing", "--edition-dir", dir], deps()), 2);
    assert.equal(await phaseMain(["start", ED, "--phase", "upload", "--part", "vertical", "--resume-existing", "--edition-dir", dir], deps()), 2);
  });
});

describe("#12883 gate puro", () => {
  it("retomada passa o gate do upload sem autorização; não vale para vertical-api", () => {
    const base = { store: null, currentPlanSha256: null, host: HOST } as const;
    assert.equal(checkExternalEffect({ ...base, phase: "upload", part: "horizontal", resumeExisting: { videoId: "v1" } }).ok, true);
    assert.equal(checkExternalEffect({ ...base, phase: "upload", part: "horizontal" }).ok, false);
    assert.equal(checkExternalEffect({ ...base, phase: "vertical-api", part: "vertical", resumeExisting: { videoId: "v1" } }).ok, false);
  });

  it("checkPhaseStart: a retomada dispensa só a regra de retry, e só no upload/horizontal", () => {
    const events = [ev("upload", "horizontal", "start", 0), ev("upload", "horizontal", "error", 2)];
    const retry = ev("upload", "horizontal", "start", 5, { attempt: 2 });
    assert.match(checkPhaseStart({ events, candidate: retry }).join(), /releia o registro/);
    assert.deepEqual(checkPhaseStart({ events, candidate: retry, resumeExisting: true }), []);
    const v = ev("vertical-api", "vertical", "start", 5, { background: true, taskId: "b" });
    assert.match(checkPhaseStart({ events: [], candidate: v, resumeExisting: true }).join(), /só vale para upload\/horizontal/);
    // Recurso ocupado continua valendo na retomada.
    const busy = [ev("link", "horizontal", "start", 4)];
    assert.match(checkPhaseStart({ events: busy, candidate: retry, resumeExisting: true }).join(), /recurso ocupado/);
  });
});
