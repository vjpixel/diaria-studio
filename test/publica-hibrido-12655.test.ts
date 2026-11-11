/**
 * test/publica-hibrido-12655.test.ts (#12655)
 *
 * Fluxo híbrido do `/diaria-publica`: telemetria por fase, travas de início
 * (Chrome com dono único, um escritor por registro, vertical do thread
 * principal fora das janelas das Etapas 5/6, retry só com releitura do
 * registro, background antes da 1ª pergunta), gate de efeito externo
 * (nenhuma publicação antes da aprovação do plano ATUAL; sem link do vídeo
 * nenhum escopo da Etapa 5 sai), join, relatório (indisponível ≠ zero, união
 * de intervalos), isolamento do custo do vídeo da janela das Etapas 5/6 e a
 * releitura do estado do YouTube no A4 com a API simulada.
 *
 * Nada publica: o CLI roda com deps injetadas, em diretório temporário, e o
 * comando do `run` é um espião que só registra se foi chamado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLICA_PHASES_FILE,
  buildPhaseEvent,
  checkPhaseStart,
  deriveTasks,
  joinCheck,
  nextAttempt,
  parsePhaseEvents,
  phaseReport,
  unionDurationMs,
  videoPartMainThreadIntervals,
  type PhaseEvent,
  type PhaseEventKind,
} from "../scripts/lib/diaria/publica-phases.ts";
import { checkExternalEffect } from "../scripts/lib/diaria/publica-effect-gate.ts";
import {
  buildHorizontalManifest,
  planSha256,
  sha256Hex,
  writeVideoPlanManifest,
  type VideoPlanManifest,
} from "../scripts/lib/diaria/video-publish-plan.ts";
import {
  authorizationStorePath,
  currentHost,
  emptyAuthorizationStore,
  grantVideoPublishAuthorization,
  invalidateVideoPublishAuthorization,
  consumeVideoPublishAuthorization,
  recordRegistryCheck,
  type VideoPublishAuthorizationStore,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import { main as phaseMain, type PhaseCliDeps } from "../scripts/publica-phase.ts";
import { captureUsageForWindow, publicaVideoIntervals } from "../scripts/capture-stage-usage.ts";
import { decideRefresh, refreshYouTubeRecordState } from "../scripts/lib/diaria/youtube-link-refresh.ts";
import { gateVideoLink, readYouTubeRecordSummary } from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";

const ED = "261112";
const T0 = new Date("2026-11-11T22:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const HOST = currentHost();

function ev(phase: string, part: string, event: PhaseEventKind, min: number, over: Partial<Parameters<typeof buildPhaseEvent>[0]> = {}): PhaseEvent {
  return buildPhaseEvent({ edition: ED, phase, part, event, at: at(min), attempt: 1, sessionId: "S1", ...over });
}

function horizontal(title = "Ensinaram a IA e foram demitidos"): VideoPlanManifest {
  return buildHorizontalManifest({
    aammdd: ED,
    metadata: { title, description: "desc", tags: ["ia"] },
    schedule: { mode: "scheduled", publishAt: "2026-11-12T09:00:00.000Z" },
    privacy: "private",
    media: { video_sha256: sha256Hex("video"), cover_sha256: sha256Hex("capa"), captions_sha256: null },
    sources: { reviewed: sha256Hex("rev") },
    command: `npx tsx scripts/publish-youtube.ts ${ED} --upload --confirm-publish ${ED}`,
    generatedAt: T0.toISOString(),
  });
}

function granted(m: VideoPlanManifest, store: VideoPublishAuthorizationStore = emptyAuthorizationStore(ED), host = HOST): VideoPublishAuthorizationStore {
  const r = grantVideoPublishAuthorization(store, { manifest: m, planSha256: planSha256(m), confirmation: "pode publicar", now: T0, host, isPidAlive: () => false });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.store;
}

describe("#12655 eventos e tarefas", () => {
  it("evento carrega edição, fase, parte, stage, tentativa, sessão, task e hash", () => {
    const e = ev("stage5", "sessao", "start", 0, { taskId: "bg-1", planSha256: "a".repeat(64) });
    assert.equal(e.stage, 5);
    assert.equal(e.session_id, "S1");
    assert.equal(e.task_id, "bg-1");
    assert.equal(e.plan_sha256, "a".repeat(64));
    assert.deepEqual(e.resources, ["registry:05-published", "registry:06-social-published"]);
    assert.throws(() => ev("inventada", "horizontal", "start", 0), /fase desconhecida/);
    assert.throws(() => ev("fetch", "horizontal", "start", 0, { attempt: 0 }), /tentativa/);
    assert.throws(() => ev("fetch", "horizontal", "start", 0, { planSha256: "xyz" }), /plan_sha256/);
  });

  it("deriva tarefas por par início/fim; fim sem início não inventa tarefa; PID morto vira órfã", () => {
    const events = [
      ev("fetch", "horizontal", "start", 0, { background: true, taskId: "t1", pid: 11, host: "h" }),
      ev("fetch", "horizontal", "end", 3, { background: true, taskId: "t1" }),
      ev("upload", "horizontal", "end", 4),
      ev("vertical-api", "vertical", "start", 5, { background: true, taskId: "t2", pid: 22, host: "h" }),
    ];
    const tasks = deriveTasks(events, { isPidAlive: (p) => p !== 22, host: "h" });
    assert.deepEqual(tasks.map((t) => `${t.phase}:${t.status}`), ["fetch:done", "vertical-api:orphaned"]);
    assert.equal(nextAttempt(events, "vertical-api", "vertical"), 2);
  });

  it("JSONL ilegível vira problema listado, nunca some", () => {
    const good = JSON.stringify(ev("fetch", "horizontal", "start", 0));
    const { events, problems } = parsePhaseEvents(`${good}\n{quebrado\n{"schema":"x"}\n`);
    assert.equal(events.length, 1);
    assert.equal(problems.length, 2);
  });
});

describe("#12655 travas de início", () => {
  it("Chrome tem um dono só: 2ª fase guiada recusada enquanto a 1ª roda", () => {
    const events = [ev("vertical-guiado", "vertical", "start", 0)];
    const p = checkPhaseStart({ events, candidate: ev("stage6-teste", "sessao", "start", 1, { extraResources: ["chrome"] }) });
    assert.match(p.join("\n"), /recurso ocupado: chrome/);
    const after = [...events, ev("vertical-guiado", "vertical", "end", 2)];
    assert.deepEqual(checkPhaseStart({ events: after, candidate: ev("stage6-teste", "sessao", "start", 3, { extraResources: ["chrome"] }) }), []);
  });

  it("Etapa 5 e vertical em background concorrem sem escrita no mesmo registro; upload e vertical não", () => {
    const events = [ev("stage5", "sessao", "start", 0)];
    assert.deepEqual(checkPhaseStart({ events, candidate: ev("vertical-api", "vertical", "start", 1, { background: true, taskId: "bg" }) }), []);
    const up = [ev("upload", "horizontal", "start", 0)];
    assert.match(checkPhaseStart({ events: up, candidate: ev("vertical-api", "vertical", "start", 1, { background: true, taskId: "bg" }) }).join(), /registry:video-publish-authorizations/);
  });

  it("vertical no thread principal durante a Etapa 5/6 é recusado (o custo cairia no stage)", () => {
    const events = [ev("stage6-gate", "sessao", "start", 0)];
    assert.match(checkPhaseStart({ events, candidate: ev("vertical-guiado", "vertical", "start", 1) }).join(), /isolamento de custo/);
    assert.match(checkPhaseStart({ events, candidate: ev("aprovacao", "vertical", "start", 1) }).join(), /isolamento de custo/);
  });

  it("retry de fase externa interrompida exige releitura do registro depois da interrupção", () => {
    const events = [ev("upload", "horizontal", "start", 0), ev("upload", "horizontal", "interrupted", 2)];
    const retry = ev("upload", "horizontal", "start", 5, { attempt: 2 });
    assert.match(checkPhaseStart({ events, candidate: retry }).join(), /releia o registro/);
    const old = [{ at: at(1).toISOString(), since: at(0).toISOString(), verdict: "nothing-since" }];
    assert.match(checkPhaseStart({ events, candidate: retry, registryChecks: old }).join(), /releia o registro/, "releitura ANTES do fim não cobre");
    const unreadable = [{ at: at(3).toISOString(), since: at(0).toISOString(), verdict: "unreadable" }];
    assert.match(checkPhaseStart({ events, candidate: retry, registryChecks: unreadable }).join(), /unreadable/);
    const ok = [{ at: at(3).toISOString(), since: at(0).toISOString(), verdict: "nothing-since" }];
    assert.deepEqual(checkPhaseStart({ events, candidate: retry, registryChecks: ok }), []);
  });

  it("tarefa órfã (PID morto, sem fim) também exige a releitura antes do retry", () => {
    const events = [ev("vertical-api", "vertical", "start", 0, { background: true, taskId: "pid-9", pid: 9, host: "h" })];
    const retry = ev("vertical-api", "vertical", "start", 5, { background: true, taskId: "pid-10", attempt: 2 });
    const p = checkPhaseStart({ events, candidate: retry, deriveOptions: { isPidAlive: () => false, host: "h" } });
    assert.match(p.join(), /releia o registro/);
  });

  it("background iniciado antes da 1ª pergunta bloqueante; sem ele, só com a limitação declarada", () => {
    const question = ev("decisoes", "sessao", "start", 2);
    assert.match(checkPhaseStart({ events: [], candidate: question }).join(), /sem preparo em background/);
    assert.deepEqual(checkPhaseStart({ events: [], candidate: question, serialReason: "sem worker nesta máquina" }), []);
    const bg = [ev("fetch", "horizontal", "start", 0, { background: true, taskId: "bg-fetch" })];
    assert.deepEqual(checkPhaseStart({ events: bg, candidate: question }), []);
    const fg = [ev("fetch", "horizontal", "start", 0)];
    assert.match(checkPhaseStart({ events: fg, candidate: question }).join(), /sem preparo em background/, "fetch no thread principal não conta");
    assert.deepEqual(checkPhaseStart({ events: [ev("decisoes", "sessao", "start", 2)], candidate: ev("aprovacao", "horizontal", "start", 9) }), [], "só a 1ª pergunta exige");
  });
});

describe("#12655 join e sentinels", () => {
  it("vertical pendente segura o join mesmo com as Etapas 5/6 concluídas, e é relatado", () => {
    const events = [
      ev("stage5", "sessao", "start", 0),
      ev("stage5", "sessao", "end", 10),
      ev("vertical-api", "vertical", "start", 1, { background: true, taskId: "bg" }),
      ev("stage6-schedule", "sessao", "start", 11),
      ev("stage6-schedule", "sessao", "end", 12),
    ];
    const r = joinCheck(events, { step5: true, step6: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.partsPending, ["vertical"]);
    const done = joinCheck([...events, ev("vertical-api", "vertical", "end", 13, { background: true, taskId: "bg" })], { step5: true, step6: true });
    assert.equal(done.ok, true);
  });

  it("sentinel da Etapa 5 com a etapa ainda rodando é antecipado", () => {
    const r = joinCheck([ev("stage5", "sessao", "start", 0)], { step5: true, step6: false });
    assert.match(r.problems.join(), /sentinel antecipado/);
  });
});

describe("#12655 relatório", () => {
  it("fase sem par início/fim é indisponível (null), nunca zero", () => {
    const r = phaseReport(ED, [ev("fetch", "horizontal", "start", 0)]);
    const row = r.rows.find((x) => x.phase === "fetch");
    assert.equal(row?.duration_ms, null);
    assert.ok(r.unavailable.includes("upload"));
    assert.equal(r.critical_path_ms, null);
    assert.deepEqual(r.pending, ["fetch/horizontal"]);
  });

  it("caminho crítico é a união dos intervalos; espera do editor separada da execução", () => {
    const events = [
      ev("fetch", "horizontal", "start", 0, { background: true, taskId: "a" }),
      ev("fetch", "horizontal", "end", 10, { background: true, taskId: "a" }),
      ev("decisoes", "sessao", "start", 2),
      ev("decisoes", "sessao", "end", 6),
      ev("stage5", "sessao", "start", 20),
      ev("stage5", "sessao", "end", 30),
      ev("vertical-api", "vertical", "start", 22, { background: true, taskId: "b" }),
      ev("vertical-api", "vertical", "end", 28, { background: true, taskId: "b" }),
    ];
    const r = phaseReport(ED, events);
    assert.equal(r.critical_path_ms, 20 * 60_000, "0–10 ∪ 20–30");
    assert.equal(r.naive_sum_ms, 30 * 60_000);
    assert.equal(r.wait_ms, 4 * 60_000);
    assert.equal(r.active_ms, 20 * 60_000);
    assert.equal(unionDurationMs([]), 0);
  });
});

describe("#12655 gate de efeito externo", () => {
  const m = horizontal();
  const base = { phase: "upload" as const, part: "horizontal" as const, currentPlanSha256: planSha256(m), host: HOST };

  it("nenhum upload antes da aprovação", () => {
    const r = checkExternalEffect({ ...base, store: emptyAuthorizationStore(ED) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /sem autorização ativa/);
  });

  it("plano alterado depois da aprovação invalida", () => {
    const store = granted(m);
    const changed = horizontal("Outro título");
    const r = checkExternalEffect({ ...base, store, currentPlanSha256: planSha256(changed) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /plano da parte horizontal mudou/);
    assert.equal(checkExternalEffect({ ...base, store }).ok, true);
  });

  it("aprovação de outra máquina, registro ilegível e sem manifesto recusam", () => {
    assert.match(String((checkExternalEffect({ ...base, store: granted(m, undefined, "outra") }) as { reason: string }).reason), /outra máquina/);
    assert.match(String((checkExternalEffect({ ...base, store: null, storeError: "JSON" }) as { reason: string }).reason), /indisponível/);
    assert.match(String((checkExternalEffect({ ...base, store: granted(m), currentPlanSha256: null }) as { reason: string }).reason), /sem manifesto/);
  });

  it("autorização consumida não serve a uma 2ª execução; invalidada também não", () => {
    const store = granted(m);
    const used = consumeVideoPublishAuthorization(store, { edition: ED, manifest: m, destinations: ["youtube"], now: at(5), pid: 4242, by: "t" });
    assert.ok(used.ok);
    assert.equal(checkExternalEffect({ ...base, store: (used as { store: VideoPublishAuthorizationStore }).store }).ok, false);
    const inv = invalidateVideoPublishAuthorization(store, { part: "horizontal", reason: "interrompida", now: at(6) });
    assert.equal(checkExternalEffect({ ...base, store: inv.store }).ok, false);
  });

  it("sem link do vídeo nenhum escopo da Etapa 5 sai (newsletter, social e Schedule)", () => {
    const blocked = { status: "video-without-link", blocking: true, warning: "sem link" };
    for (const phase of ["stage5", "stage6-schedule"] as const) {
      assert.equal(checkExternalEffect({ phase, part: "sessao", store: null, currentPlanSha256: null, videoGate: blocked, host: HOST }).ok, false);
      assert.equal(checkExternalEffect({ phase, part: "sessao", store: null, currentPlanSha256: null, videoGate: null, host: HOST }).ok, false);
      assert.equal(
        checkExternalEffect({ phase, part: "sessao", store: null, currentPlanSha256: null, videoGate: { status: "link-ready", blocking: false, warning: null }, host: HOST }).ok,
        true,
      );
    }
  });

  it("fases reversíveis não passam pelo gate", () => {
    assert.equal(checkExternalEffect({ phase: "fetch", part: "horizontal", store: null, currentPlanSha256: null, host: HOST }).ok, true);
  });
});

describe("#12655 CLI: nenhum efeito externo antes da autorização", () => {
  let dir: string;
  let out: string[];
  let errs: string[];
  let spawned: string[][];
  let runLogged: PhaseEvent[];
  let clock: Date;
  const deps = (): PhaseCliDeps => ({
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    now: () => clock,
    env: { CLAUDE_CODE_SESSION_ID: "S1" },
    host: HOST,
    pid: 4242,
    isPidAlive: () => true,
    runLog: (e) => runLogged.push(e),
    videoGate: () => ({ status: "video-without-link", blocking: true, warning: "sem link do vídeo" }),
    spawnCommand: async (argv) => {
      spawned.push(argv);
      return { code: 0, signal: null };
    },
  });
  const phases = () => (existsSync(join(dir, PUBLICA_PHASES_FILE)) ? parsePhaseEvents(readFileSync(join(dir, PUBLICA_PHASES_FILE), "utf8")).events : []);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "publica-12655-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    out = [];
    errs = [];
    spawned = [];
    runLogged = [];
    clock = T0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("run do upload sem grant: recusado, comando nunca chamado, nada gravado", async () => {
    writeVideoPlanManifest(dir, horizontal());
    const code = await phaseMain(["run", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir, "--", "npx", "tsx", "scripts/publish-youtube.ts", ED, "--upload"], deps());
    assert.equal(code, 1);
    assert.deepEqual(spawned, []);
    assert.deepEqual(phases(), []);
    assert.match(errs.join("\n"), /sem autorização ativa/);
  });

  it("run do upload com grant do plano atual roda e registra início e fim; plano alterado depois recusa", async () => {
    const m = horizontal();
    writeVideoPlanManifest(dir, m);
    writeFileSync(authorizationStorePath(dir), JSON.stringify(granted(m), null, 2));
    const code = await phaseMain(["run", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir, "--", "echo", "ok"], deps());
    assert.equal(code, 0);
    assert.deepEqual(spawned, [["echo", "ok"]]);
    const evs = phases();
    assert.deepEqual(evs.map((e) => e.event), ["start", "end"]);
    assert.equal(evs[0].plan_sha256, planSha256(m));
    assert.equal(evs[0].task_id, "pid-4242");
    assert.equal(runLogged.length, 2);

    writeVideoPlanManifest(dir, horizontal("Título trocado depois"));
    spawned = [];
    const again = await phaseMain(["run", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir, "--", "echo", "x"], deps());
    assert.equal(again, 1);
    assert.deepEqual(spawned, []);
    assert.match(errs.join("\n"), /plano da parte horizontal mudou/);
  });

  it("Etapa 5 sem link do vídeo: start recusado em qualquer escopo", async () => {
    const code = await phaseMain(["start", ED, "--phase", "stage5", "--part", "sessao", "--edition-dir", dir], deps());
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /sem link do vídeo/);
    assert.deepEqual(phases(), []);
  });

  it("comando que falha vira error com exit code; join acusa tarefa aberta e libera depois", async () => {
    const d = deps();
    d.spawnCommand = async () => ({ code: 3, signal: null });
    assert.equal(await phaseMain(["run", ED, "--phase", "fetch", "--part", "vertical", "--background", "--edition-dir", dir, "--", "false"], d), 3);
    const evs = phases();
    assert.equal(evs[1].event, "error");
    assert.equal(evs[1].exit_code, 3);

    assert.equal(await phaseMain(["start", ED, "--phase", "plano", "--part", "vertical", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--edition-dir", dir], deps()), 1);
    assert.equal(await phaseMain(["end", ED, "--phase", "plano", "--part", "vertical", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--edition-dir", dir], deps()), 0);
  });

  it("retomada: retry do upload interrompido só depois da releitura gravada no registro", async () => {
    const m = horizontal();
    writeVideoPlanManifest(dir, m);
    const d = deps();
    d.spawnCommand = async () => ({ code: 1, signal: "SIGTERM" });
    writeFileSync(authorizationStorePath(dir), JSON.stringify(granted(m), null, 2));
    assert.equal(await phaseMain(["run", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir, "--", "x"], d), 1);
    assert.equal(phases()[1].event, "interrupted");

    clock = at(10);
    // Nova aprovação (o editor confirmou de novo) — mas sem releitura do registro, o start recusa.
    const regranted = granted(m, emptyAuthorizationStore(ED));
    writeFileSync(authorizationStorePath(dir), JSON.stringify(regranted, null, 2));
    assert.equal(await phaseMain(["start", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir], deps()), 1);
    assert.match(errs.join("\n"), /releia o registro/);

    const withCheck = recordRegistryCheck(regranted, { now: at(9), since: T0.toISOString(), verdict: "nothing-since", registered: [] });
    writeFileSync(authorizationStorePath(dir), JSON.stringify(withCheck, null, 2));
    assert.equal(await phaseMain(["start", ED, "--phase", "upload", "--part", "horizontal", "--edition-dir", dir], deps()), 0);
  });
});

describe("#12655 custo: o vídeo não cai na janela das Etapas 5/6", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "publica-usage-12655-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function line(id: string, minute: number, input: number): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: at(minute).toISOString(),
      message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
  }

  it("turnos do thread principal num intervalo do vertical saem do agregado do stage", () => {
    const transcripts = join(root, "t");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, "S1.jsonl"), [line("m1", 1, 100), line("m2", 5, 1000), line("m3", 9, 10)].join("\n"));
    const editionDir = join(root, "ed");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    const events = [
      ev("stage5", "sessao", "start", 0),
      ev("vertical-guiado", "vertical", "start", 4),
      ev("vertical-guiado", "vertical", "end", 6),
      ev("vertical-api", "vertical", "start", 2, { background: true, taskId: "bg" }),
      ev("stage5", "sessao", "end", 10),
    ];
    writeFileSync(join(editionDir, PUBLICA_PHASES_FILE), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const intervals = publicaVideoIntervals(editionDir, "S1", at(10).toISOString());
    assert.deepEqual(intervals?.map((i) => i.label), ["vertical-guiado/vertical"], "o vertical em background não tem transcript: não vira intervalo");
    const r = captureUsageForWindow(transcripts, at(0).toISOString(), at(10).toISOString(), ED, { sessionId: "S1", excludeIntervals: intervals });
    assert.equal(r.tokens_in, 110);
    assert.deepEqual(r.excluded_other_parts, { entries: 1, tokens_in: 1000, tokens_out: 1, labels: ["vertical-guiado/vertical"] });

    const sem = captureUsageForWindow(transcripts, at(0).toISOString(), at(10).toISOString(), ED, { sessionId: "S1" });
    assert.equal(sem.tokens_in, 1110, "sem a telemetria, a janela soma tudo (o problema que o isolamento resolve)");
    assert.equal(sem.excluded_other_parts, undefined);
  });

  it("intervalos só da sessão dona; tarefa aberta vai até o fim da janela", () => {
    const events = [ev("aprovacao", "vertical", "start", 3), ev("plano", "vertical", "start", 1, { sessionId: "S2" }), ev("plano", "vertical", "end", 2, { sessionId: "S2" })];
    const iv = videoPartMainThreadIntervals(events, "S1", at(10).getTime());
    assert.equal(iv.length, 1);
    assert.equal(iv[0].end, at(10).getTime());
  });
});

describe("#12655 A4: estado do YouTube relido na API (simulada)", () => {
  let dir: string;
  const VID = "abcdefghijk";
  const URL = `https://youtu.be/${VID}`;
  const CH = "UCdiaria";
  const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: CH };
  const now = new Date("2026-11-12T02:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "a4-12655-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify({ videoId: VID, url: URL, state: "draft", status: "done", rereadStatus: { privacyStatus: "private" } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function api(item: unknown, opts: { status?: number; hang?: boolean } = {}) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      deps: {
        now: () => now,
        fetch: async (url: string) => {
          calls++;
          if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
          if (opts.hang) return new Promise<Response>(() => {});
          if (opts.status) return new Response("{}", { status: opts.status });
          return new Response(JSON.stringify({ items: item ? [item] : [] }), { status: 200 });
        },
      },
    };
  }
  const item = (status: Record<string, unknown>, channelId = CH) => ({ id: VID, snippet: { channelId }, status });
  const record = () => JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8")) as Record<string, unknown>;
  const gate = (d1: string) =>
    gateVideoLink({ videoUrl: URL, record: readYouTubeRecordSummary(dir), d1SlotAt: new Date(d1), projectAudited: true, newsletterSendAt: new Date("2026-11-12T09:00:00.000Z") });

  it("público no Studio depois do upload privado: registro atualizado e o link passa sem --assume-public", async () => {
    assert.equal(gate("2026-11-12T09:00:00.000Z").ok, false, "antes: rascunho");
    const a = api(item({ uploadStatus: "processed", privacyStatus: "public" }));
    const r = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: a.deps });
    assert.equal(r.kind, "refreshed");
    assert.equal(record().state, "published");
    assert.equal((record().status_refreshes as unknown[]).length, 1);
    assert.equal(gate("2026-11-12T09:00:00.000Z").ok, true);
  });

  it("privado sem agendamento continua recusado (o fallback humano segue)", async () => {
    const r = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(item({ uploadStatus: "processed", privacyStatus: "private" })).deps });
    assert.equal(r.kind, "refreshed");
    assert.equal(record().state, "draft");
    assert.equal(gate("2026-11-12T09:00:00.000Z").ok, false);
  });

  it("agendado cedo passa; agendado depois do post do D1 é recusado", async () => {
    await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(item({ uploadStatus: "processed", privacyStatus: "private", publishAt: "2026-11-12T08:30:00.000Z" })).deps });
    assert.equal(record().state, "scheduled");
    assert.equal(gate("2026-11-12T09:00:00.000Z").ok, true);
    await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(item({ uploadStatus: "processed", privacyStatus: "private", publishAt: "2026-11-12T12:00:00.000Z" })).deps });
    assert.equal(gate("2026-11-12T09:00:00.000Z").ok, false);
  });

  for (const terminal of ["failed", "rejected", "deleted"]) {
    it(`${terminal} na releitura é terminal: estado unknown, link recusado`, async () => {
      const r = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(item({ uploadStatus: terminal, privacyStatus: "public" })).deps });
      assert.equal(r.kind, "terminal");
      assert.equal(record().state, "unknown");
      assert.equal(gate("2026-11-12T09:00:00.000Z").ok, false);
    });
  }

  it("sem credencial: inconclusivo, sem rede, registro intacto (nunca vira público)", async () => {
    const a = api(item({ privacyStatus: "public" }));
    const before = readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8");
    const r = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env: {}, deps: a.deps });
    assert.equal(r.kind, "inconclusive");
    assert.match((r as { reason: string }).reason, /sem credencial/);
    assert.equal(a.calls, 0);
    assert.equal(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"), before);
  });

  it("timeout e HTTP de erro: inconclusivo, registro intacto", async () => {
    const before = readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8");
    const t = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(null, { hang: true }).deps, timeoutMs: 20 });
    assert.equal(t.kind, "inconclusive");
    assert.match((t as { reason: string }).reason, /timeout/);
    const h = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(null, { status: 500 }).deps });
    assert.equal(h.kind, "inconclusive");
    assert.equal(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"), before);
  });

  it("canal diferente ou vídeo fora da resposta: inconclusivo, registro intacto", async () => {
    const before = readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8");
    assert.equal((await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(item({ privacyStatus: "public" }, "UCoutro")).deps })).kind, "inconclusive");
    assert.equal((await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: api(null).deps })).kind, "inconclusive");
    assert.equal(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"), before);
  });

  it("registro obsoleto (outro vídeo) ou ausente: pulado, sem chamada à API", async () => {
    const a = api(item({ privacyStatus: "public" }));
    const r = await refreshYouTubeRecordState({ editionDir: dir, videoUrl: "https://youtu.be/zzzzzzzzzzz", env, deps: a.deps });
    assert.equal(r.kind, "skipped");
    assert.equal(a.calls, 0);
    rmSync(join(dir, YOUTUBE_PUBLISHED_FILE));
    assert.equal((await refreshYouTubeRecordState({ editionDir: dir, videoUrl: URL, env, deps: a.deps })).kind, "skipped");
  });

  it("decideRefresh é puro: id e canal conferidos antes de qualquer estado", () => {
    const base = { linkVideoId: VID, recordVideoId: VID, expectedChannelId: CH, now };
    assert.equal(decideRefresh({ ...base, fetched: { kind: "ok", channelId: CH, status: { privacyStatus: "public" } } }).kind, "refreshed");
    assert.equal(decideRefresh({ ...base, fetched: { kind: "ok", channelId: null, status: { privacyStatus: "public" } } }).kind, "inconclusive");
    assert.equal(decideRefresh({ ...base, recordVideoId: null, fetched: { kind: "not-found" } }).kind, "skipped");
  });
});
