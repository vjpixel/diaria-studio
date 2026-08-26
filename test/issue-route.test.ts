/**
 * test/issue-route.test.ts (#5969 Fase 1)
 *
 * Cobre `scripts/lib/issue-route.ts` (mapeamento puro veredito->labels) e
 * `scripts/route-issue.ts` (verbo de I/O — sempre com `GhRunFn` em memoria,
 * NUNCA `gh` real, mesmo padrao de `test/wait-until-sync.test.ts` e
 * `test/alarm-issues.test.ts`).
 *
 * Casos exigidos pela issue:
 *   1. mapeamento veredito->labels: idempotencia (aplicar duas vezes da o
 *      mesmo resultado) e "remove as labels erradas de vereditos anteriores".
 *   2. validacao pos-escrita: falha ruidosa quando classifyExecTrack nao
 *      bate com o --track pedido.
 *   3. #6197 — 5 labels (3a) passam no round-trip; --motivo seleciona label
 *      especifica; 3b preserva label de bloqueio preexistente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRouteLabelPlan,
  autoMotivoForTrack,
  diffRouteLabelPlan,
  labelsForNewIssue,
  MOTIVO_LABEL,
  planRouteLabels,
  ROUTABLE_LABELS,
  ROUTE_TRACKS,
  type RouteMotivo,
  type RouteTrack,
} from "../scripts/lib/issue-route.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";
import { routeIssue, routeIssueForCreate, type GhRunFn } from "../scripts/route-issue.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

// ─── planRouteLabels / applyRouteLabelPlan — mapeamento puro ────────────────

describe("planRouteLabels — round-trip contra classifyExecTrack", () => {
  // "agendada" e o unico veredito sem label (o sinal e o marcador
  // aguardando-ate: no CORPO, nao uma label — ver docstring do modulo) entao
  // seu round-trip e testado a parte, abaixo, com o marcador no body.
  for (const track of ROUTE_TRACKS.filter((t) => t !== "agendada")) {
    it(`aplicar o plano de "${track}" a partir de zero labels faz classifyExecTrack devolver "${track}"`, () => {
      const plan = planRouteLabels(track);
      const nextLabels = applyRouteLabelPlan([], plan);
      const resolved = classifyExecTrack({ labels: nextLabels, body: "", state: "OPEN" });
      assert.equal(resolved, track);
    });
  }

  it('"agendada" (sem label, marcador aguardando-ate no body) faz classifyExecTrack devolver "agendada"', () => {
    const plan = planRouteLabels("agendada");
    assert.deepEqual(plan.add, []);
    const nextLabels = applyRouteLabelPlan([], plan);
    const resolved = classifyExecTrack({
      labels: nextLabels,
      body: "<!-- aguardando-ate: 2026-09-01 -->",
      state: "OPEN",
      now: new Date("2026-08-23T00:00:00Z"),
    });
    assert.equal(resolved, "agendada");
  });
});

describe("planRouteLabels — round-trip dos 5 motivos #6197 (3a)", () => {
  // Cada --motivo mapeia a uma label que classifyExecTrack reconhece e
  // devolve o track pedido — garantido pelo round-trip a seguir.
  const cases: Array<[RouteTrack, string]> = [
    // bloqueada
    ["bloqueada", "conta-de-terceiro"],
    ["bloqueada", "plataforma"],
    ["bloqueada", "kit"],
    ["bloqueada", "execucao"],
    // epica (#6201 — motivo "epica" pareado com o track próprio, não mais
    // "fora-de-rodada": epic-guarda-chuva ganhou precedência acima de
    // BLOCKED_LABELS, então classifica "epica", não "fora-de-rodada")
    ["epica", "epica"],
    // fora-de-rodada
    ["fora-de-rodada", "sem-direcao"],
    ["fora-de-rodada", "decisao"],
    ["fora-de-rodada", "alarme-estado"],
    // overnight
    ["overnight", "alarme-evento"],
  ];

  for (const [track, motivo] of cases) {
    it(`--track ${track} --motivo ${motivo} adiciona ${MOTIVO_LABEL[motivo]} e round-trip bate`, () => {
      const plan = planRouteLabels(track, motivo as RouteMotivo);
      const expectedLabel = MOTIVO_LABEL[motivo];
      assert.deepEqual(plan.add, [expectedLabel]);
      const nextLabels = applyRouteLabelPlan([], plan);
      const resolved = classifyExecTrack({ labels: nextLabels, body: "", state: "OPEN" });
      assert.equal(
        resolved,
        track,
        `--motivo ${motivo} produziu label ${expectedLabel} que classifica como "${resolved}", esperado "${track}"`,
      );
    });
  }

  it("alarm-evento round-trip: --track overnight --motivo alarme-evento", () => {
    const plan = planRouteLabels("overnight", "alarme-evento");
    assert.deepEqual(plan.add, ["alarm-evento"]);
    const nextLabels = applyRouteLabelPlan([], plan);
    const resolved = classifyExecTrack({ labels: nextLabels, body: "", state: "OPEN" });
    assert.equal(resolved, "overnight");
  });
});

describe("planRouteLabels — remove sinais conflitantes de vereditos anteriores", () => {
  it("rotear pra develop a partir de uma issue bloqueada remove a label de bloqueio", () => {
    const plan = planRouteLabels("develop");
    const current = ["external-blocker", "not-this-week"];
    const next = applyRouteLabelPlan(current, plan);
    assert.deepEqual(new Set(next), new Set(["develop-track"]));
  });

  it("rotear pra overnight a partir de qualquer estado anterior limpa todas as ROUTABLE_LABELS", () => {
    const plan = planRouteLabels("overnight");
    const next = applyRouteLabelPlan([...ROUTABLE_LABELS], plan);
    assert.deepEqual(next, []);
  });

  it("rotear pra bloqueada a partir de develop troca develop-track por bloqueio-execucao", () => {
    const plan = planRouteLabels("bloqueada");
    const next = applyRouteLabelPlan(["develop-track", "windows"], plan);
    assert.deepEqual(new Set(next), new Set(["bloqueio-execucao"]));
  });

  it("preserva labels que n\u00e3o pertencem a ROUTABLE_LABELS (ex: tipo/prioridade)", () => {
    const plan = planRouteLabels("develop");
    const next = applyRouteLabelPlan(["enhancement", "P2", "windows"], plan);
    assert.deepEqual(new Set(next), new Set(["enhancement", "P2", "develop-track"]));
  });
});

describe("planRouteLabels -- motivo seleciona label especifica (3b)", () => {
  it("bloqueada --motivo conta-de-terceiro adiciona external-blocker, nao bloqueio-execucao", () => {
    const plan = planRouteLabels("bloqueada", "conta-de-terceiro");
    assert.deepEqual(plan.add, ["external-blocker"]);
    assert.ok(!plan.remove.includes("external-blocker"));
    assert.ok(plan.remove.includes("bloqueio-execucao"));
  });

  it("bloqueada --motivo execucao adiciona bloqueio-execucao", () => {
    const plan = planRouteLabels("bloqueada", "execucao");
    assert.deepEqual(plan.add, ["bloqueio-execucao"]);
  });

  it("--track epica (sem --motivo) adiciona epic-guarda-chuva via TRACK_ADD_LABEL default", () => {
    const plan = planRouteLabels("epica");
    assert.deepEqual(plan.add, ["epic-guarda-chuva"]);
    assert.ok(!plan.remove.includes("epic-guarda-chuva"));
    assert.ok(plan.remove.includes("on-hold"));
  });

  it("fora-de-rodada --motivo epica ainda adiciona epic-guarda-chuva (compat #6201) — mas o round-trip real e' via --track epica, ver describe acima", () => {
    const plan = planRouteLabels("fora-de-rodada", "epica");
    assert.deepEqual(plan.add, ["epic-guarda-chuva"]);
    assert.ok(!plan.remove.includes("epic-guarda-chuva"));
    assert.ok(plan.remove.includes("on-hold"));
  });

  it("motivo invalido lanca erro listando valores validos", () => {
    assert.throws(
      () => planRouteLabels("bloqueada", "nao-existe" as RouteMotivo),
      /motivo desconhecido/,
    );
  });
});

describe("planRouteLabels — idempotencia", () => {
  for (const track of ROUTE_TRACKS) {
    it(`aplicar o plano de "${track}" duas vezes seguidas converge pro mesmo conjunto (${track})`, () => {
      const plan = planRouteLabels(track);
      const once = applyRouteLabelPlan(["windows", "not-this-week", "enhancement"], plan);
      const twice = applyRouteLabelPlan(once, plan);
      assert.deepEqual(new Set(once), new Set(twice));
    });
  }
});

describe("diffRouteLabelPlan — so o que muda de verdade", () => {
  it("labels ja corretas não geram diff nenhum (0 chamadas de gh issue edit)", () => {
    const plan = planRouteLabels("develop");
    const { toAdd, toRemove } = diffRouteLabelPlan(["develop-track", "enhancement"], plan);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, []);
  });

  it("calcula toAdd/toRemove ordenados e minimos", () => {
    const plan = planRouteLabels("bloqueada");
    const { toAdd, toRemove } = diffRouteLabelPlan(["windows", "external-blocker"], plan);
    assert.deepEqual(toAdd, ["bloqueio-execucao"]);
    // "bloqueada" sem --motivo usa a label generica (bloqueio-execucao) via
    // TRACK_ADD_LABEL. A preservacao de label especifica (3b) e feita no
    // nivel do verbo routeIssue() (autoMotivoForTrack), nao nessa funcao
    // pura — que sempre usa o default generativo.
    assert.deepEqual(toRemove, ["external-blocker", "windows"]);
  });
});

describe("diffRouteLabelPlan — --motivo muda o diff", () => {
  it("bloqueada --motivo conta-de-terceiro preserva external-blocker no diff (nao remove)", () => {
    const plan = planRouteLabels("bloqueada", "conta-de-terceiro");
    const { toAdd, toRemove } = diffRouteLabelPlan(["external-blocker", "windows"], plan);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, ["windows"]);
    assert.ok(!toRemove.includes("external-blocker"));
  });
});

// ─── autoMotivoForTrack — preservacao 3b ────────────────────────────────────

describe("autoMotivoForTrack — #6197 item 3b", () => {
  it("bloqueada + external-blocker presente devolve motivo conta-de-terceiro", () => {
    assert.equal(autoMotivoForTrack("bloqueada", ["external-blocker"]), "conta-de-terceiro");
  });

  it("bloqueada + kit-migration presente devolve motivo kit", () => {
    assert.equal(autoMotivoForTrack("bloqueada", ["kit-migration"]), "kit");
  });

  it("bloqueada + beehiiv presente devolve motivo plataforma", () => {
    assert.equal(autoMotivoForTrack("bloqueada", ["beehiiv"]), "plataforma");
  });

  it("bloqueada sem label de bloqueio devolve undefined (usa default generico)", () => {
    assert.equal(autoMotivoForTrack("bloqueada", ["enhancement"]), undefined);
  });

  it("credencial-escopo sozinha devolve undefined (sozinha classifica overnight)", () => {
    assert.equal(autoMotivoForTrack("bloqueada", ["credencial-escopo"]), undefined);
    assert.equal(autoMotivoForTrack("bloqueada", ["credencial-escopo", "external-blocker"]), "conta-de-terceiro");
  });

  it("tracks diferentes de bloqueada sempre devolvem undefined", () => {
    assert.equal(autoMotivoForTrack("develop", ["external-blocker"]), undefined);
    assert.equal(autoMotivoForTrack("overnight", ["external-blocker"]), undefined);
    assert.equal(autoMotivoForTrack("fora-de-rodada", ["external-blocker"]), undefined);
  });
});

// ─── routeIssue — I/O via GhRunFn em memoria (sem rede/gh real) ────────────

interface FakeIssueState {
  labels: string[];
  body: string;
  state: string;
  comments: string[];
}

/** Stub de `GhRunFn` que serve `gh issue view --json labels,body,state,comments`
 * a partir de estado em memoria e aplica `gh issue edit --add-label/--remove-label`,
 * `gh issue comment --body` de volta nele. Mesma tecnica de `fakeGh` em
 * `test/wait-until-sync.test.ts`. */
function fakeGh(initial: FakeIssueState): { run: GhRunFn; state: FakeIssueState; calls: string[][] } {
  const state: FakeIssueState = {
    labels: [...initial.labels],
    body: initial.body,
    state: initial.state,
    comments: [...initial.comments],
  };
  const calls: string[][] = [];
  const run: GhRunFn = (args): GhSpawnResult => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      // `scripts/lib/wait-until-sync.ts` chama `gh issue view N --json body -q .body`
      // (stdout = corpo cru, nao JSON) — distinto do `--json labels,body,state,comments`
      // que `scripts/route-issue.ts` usa (stdout = JSON completo). O `-q`/`--jq`
      // real sempre anexa 1 "\n" extra (replicado aqui como no fakeGh de
      // test/wait-until-sync.test.ts).
      if (args.includes("-q") && args.includes(".body")) {
        return { status: 0, stdout: `${state.body}\n`, stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          labels: state.labels.map((name) => ({ name })),
          body: state.body,
          state: state.state,
          comments: state.comments.map((body) => ({ body })),
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const addIdx = args.indexOf("--add-label");
      if (addIdx !== -1) {
        for (const l of args[addIdx + 1].split(",")) {
          if (!state.labels.includes(l)) state.labels.push(l);
        }
      }
      const removeIdx = args.indexOf("--remove-label");
      if (removeIdx !== -1) {
        const toRemove = new Set(args[removeIdx + 1].split(","));
        state.labels = state.labels.filter((l) => !toRemove.has(l));
      }
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) state.body = args[bodyIdx + 1];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const bodyIdx = args.indexOf("--body");
      state.comments.push(args[bodyIdx + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  return { run, state, calls };
}

describe("routeIssue — fluxo feliz", () => {
  it("roteia pra develop: aplica label, comenta, valida ok", () => {
    const gh = fakeGh({ labels: ["enhancement"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 42,
      track: "develop",
      reason: "exige a maquina Windows",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.equal(result.validated, true);
    assert.equal(result.resolvedTrack, "develop");
    assert.deepEqual(result.labelsAdded, ["develop-track"]);
    assert.ok(gh.state.labels.includes("develop-track"));
    assert.equal(gh.state.comments.length, 1);
    assert.ok(gh.state.comments[0].includes("<!-- route-issue: track=develop -->"));
  });

  it("roteia pra agendada: exige --until, grava o marcador, valida ok", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 43,
      track: "agendada",
      until: "2026-09-01",
      reason: "aguardando resposta da Beehiiv",
      cwd: "/tmp",
      ghRun: gh.run,
      now: new Date("2026-08-23T00:00:00Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.markerAction, "inserted");
    assert.match(gh.state.body, /aguardando-ate: 2026-09-01/);
  });

  it("--track agendada sem --until falha antes de qualquer I/O", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({ issue: 44, track: "agendada", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exige --until/);
    assert.equal(gh.calls.length, 0);
  });

  it("--until com track diferente de agendada falha antes de qualquer I/O", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 45,
      track: "develop",
      until: "2026-09-01",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /aceito com --track agendada/);
    assert.equal(gh.calls.length, 0);
  });

  it("roteando pra develop depois de agendada remove o marcador aguardando-ate", () => {
    const gh = fakeGh({
      labels: [],
      body: "<!-- aguardando-ate: 2026-12-01 -->\n\nAlgum texto.",
      state: "OPEN",
      comments: [],
    });
    const result = routeIssue({
      issue: 46,
      track: "develop",
      reason: "editor destravou ao vivo",
      cwd: "/tmp",
      ghRun: gh.run,
      now: new Date("2026-08-23T00:00:00Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.markerAction, "removed");
    assert.doesNotMatch(gh.state.body, /aguardando-ate/);
  });

  it("dedup: rodar o mesmo veredito+razao duas vezes nao duplica o comentario", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const opts = {
      issue: 47,
      track: "bloqueada" as RouteTrack,
      reason: "aguardando conta Beehiiv Scale",
      cwd: "/tmp",
      ghRun: gh.run,
    };
    const first = routeIssue(opts);
    const second = routeIssue(opts);
    assert.equal(first.commentAction, "posted");
    assert.equal(second.commentAction, "deduped");
    assert.equal(gh.state.comments.length, 1);
  });
});

describe("routeIssue --motivo #6197 item 2", () => {
  it("--track bloqueada --motivo conta-de-terceiro adiciona external-blocker (nao bloqueio-execucao)", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 53,
      track: "bloqueada",
      motivo: "conta-de-terceiro",
      reason: "API da Beehiiv responde 403",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.labelsAdded, ["external-blocker"]);
    assert.ok(gh.state.labels.includes("external-blocker"));
    assert.ok(!gh.state.labels.includes("bloqueio-execucao"));
  });

  it("--track agendada --motivo epica agora falha na validacao (#6201: epica vence agendada na precedencia)", () => {
    // Antes do #6201, `epic-guarda-chuva` classificava `fora-de-rodada`
    // (checado bem depois de `agendada`), entao esta combinacao produzia
    // "agendada" de verdade. Com `epica` promovida a track proprio e
    // checada logo no topo da precedencia (2o passo, antes de
    // bloqueada/agendada), a label sozinha ja classifica "epica" —
    // routeIssue detecta a divergencia no passo 4 e falha ruidosamente em
    // vez de reportar sucesso mentiroso. Quem quer "epica com data" usa
    // --track epica direto (sem --until — agendada e o unico track com
    // marcador, ver docstring do modulo).
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 54,
      track: "agendada",
      until: "2026-10-01",
      motivo: "epica",
      reason: "issue e uma epica; sub-issues em andamento",
      cwd: "/tmp",
      ghRun: gh.run,
      now: new Date("2026-08-23T00:00:00Z"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.validated, false);
    assert.equal(result.resolvedTrack, "epica");
    assert.deepEqual(result.labelsAdded, ["epic-guarda-chuva"]);
    assert.ok(gh.state.labels.includes("epic-guarda-chuva"));
  });

  it("--track epica (sem --motivo, sem --until) roteia com sucesso", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 59,
      track: "epica",
      reason: "issue e uma epica; sub-issues em andamento",
      cwd: "/tmp",
      ghRun: gh.run,
      now: new Date("2026-08-23T00:00:00Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.validated, true);
    assert.equal(result.resolvedTrack, "epica");
    assert.deepEqual(result.labelsAdded, ["epic-guarda-chuva"]);
  });

  it("motivo invalido falha antes de qualquer I/O", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 55,
      track: "bloqueada",
      motivo: "nao-existe" as RouteMotivo,
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /motivo desconhecido/);
    assert.equal(gh.calls.length, 0);
  });
});

describe("routeIssue #6197 3b — preservacao de label de bloqueio preexistente", () => {
  it("roteia pra bloqueada preservando external-blocker (sem --motivo)", () => {
    const gh = fakeGh({ labels: ["external-blocker"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 56,
      track: "bloqueada",
      reason: "depende de conta externa",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.ok(gh.state.labels.includes("external-blocker"));
    assert.ok(!gh.state.labels.includes("bloqueio-execucao"));
    assert.deepEqual(result.labelsAdded, []);
    assert.equal(result.validated, true);
  });

  it("roteia pra bloqueada preservando kit-migration", () => {
    const gh = fakeGh({ labels: ["kit-migration"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 57,
      track: "bloqueada",
      reason: "migracao de kit em andamento",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.ok(gh.state.labels.includes("kit-migration"));
    assert.ok(!gh.state.labels.includes("bloqueio-execucao"));
  });

  it("roteia pra bloqueada sem label especifica adiciona bloqueio-execucao (default)", () => {
    const gh = fakeGh({ labels: ["enhancement"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 58,
      track: "bloqueada",
      reason: "sem label especifica ainda",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.ok(gh.state.labels.includes("bloqueio-execucao"));
  });
});

describe("routeIssue — validacao pos-escrita falha ruidosamente", () => {
  it("issue CLOSED nunca vira 'develop' — validacao recusa e reporta o resolvedTrack real", () => {
    const gh = fakeGh({ labels: [], body: "", state: "CLOSED", comments: [] });
    const result = routeIssue({ issue: 48, track: "develop", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, false);
    assert.equal(result.validated, false);
    assert.equal(result.resolvedTrack, "fora-de-rodada");
    assert.match(result.error ?? "", /falhou/);
    assert.match(result.error ?? "", /pedido --track develop/);
    // As escritas ja feitas (label) nao sao silenciadas mesmo com a falha:
    assert.deepEqual(result.labelsAdded, ["develop-track"]);
  });

  it("label 'alarm' agora e gerenciada (em ROUTABLE_LABELS) — route-issue a remove ao rotear pra overnight e valida ok", () => {
    // #6197 (3a) — alarm agora e ROUTABLE_LABELS, entao route-issue remove ela
    // ao rotear pra overnight e a validacao passa. O teste antigo esperava
    // que alarm sobrevivesse; agora ela e gerenciada pelo verbo.
    const gh = fakeGh({ labels: ["alarm"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({
      issue: 49,
      track: "overnight",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true);
    assert.equal(result.validated, true);
    assert.ok(!gh.state.labels.includes("alarm"));
  });
});

describe("routeIssue — falhas de gh (fail-soft explicito, nunca silencioso)", () => {
  it("gh issue view falhando na leitura inicial devolve ok:false sem tentar editar", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") return { status: 1, stdout: "", stderr: "gh: not authenticated" };
      throw new Error(`nao devia chamar: ${args.join(" ")}`);
    };
    const result = routeIssue({ issue: 50, track: "develop", cwd: "/tmp", ghRun: run });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not authenticated/);
  });

  it("gh issue comment falhando reporta commentAction 'failed' sem reverter labels ja escritas", () => {
    const gh = fakeGh({ labels: [], body: "", state: "OPEN", comments: [] });
    const run: GhRunFn = (args, cwd) => {
      if (args[0] === "issue" && args[1] === "comment") return { status: 1, stdout: "", stderr: "gh: rate limited" };
      return gh.run(args, cwd);
    };
    const result = routeIssue({ issue: 51, track: "develop", cwd: "/tmp", ghRun: run });
    assert.equal(result.ok, false);
    assert.equal(result.commentAction, "failed");
    assert.equal(result.labelsAdded.length, 1);
    assert.ok(gh.state.labels.includes("develop-track"));
  });
});

describe("planRouteLabels — 5 labels #6197 (3a) em ROUTABLE_LABELS", () => {
  const newLabels = ["epic-guarda-chuva", "decisao-registrada", "alarm", "alarm-evento", "sem-direcao-acionavel"];
  for (const label of newLabels) {
    it(`"${label}" esta em ROUTABLE_LABELS`, () => {
      assert.ok(ROUTABLE_LABELS.includes(label), `${label} deveria estar em ROUTABLE_LABELS`);
    });
  }

  it("rotear pra overnight remove as 5 novas labels", () => {
    const plan = planRouteLabels("overnight");
    const next = applyRouteLabelPlan(newLabels, plan);
    assert.deepEqual(next, []);
  });

  it("rotear pra develop remove as 5 novas labels e adiciona develop-track", () => {
    const plan = planRouteLabels("develop");
    const next = applyRouteLabelPlan(newLabels, plan);
    assert.deepEqual(next, ["develop-track"]);
  });
});

describe("labelsForNewIssue / routeIssueForCreate — declarar track na criação (#6205)", () => {
  it("labelsForNewIssue é o mesmo .add de planRouteLabels, sem I/O", () => {
    for (const track of ROUTE_TRACKS) {
      assert.deepEqual(labelsForNewIssue(track), planRouteLabels(track).add);
    }
  });

  it("labelsForNewIssue com --motivo aplica a label específica", () => {
    assert.deepEqual(labelsForNewIssue("bloqueada", "conta-de-terceiro"), ["external-blocker"]);
  });

  it("routeIssueForCreate: track sem label especial (overnight) → labels vazio, body intocado", () => {
    const result = routeIssueForCreate({ track: "overnight", body: "corpo original" });
    assert.deepEqual(result, { ok: true, labels: [], body: "corpo original" });
  });

  it("routeIssueForCreate: bloqueada + motivo → external-blocker, body vazio quando omitido", () => {
    const result = routeIssueForCreate({ track: "bloqueada", motivo: "conta-de-terceiro" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.labels, ["external-blocker"]);
    assert.equal(result.body, "");
  });

  it("routeIssueForCreate: agendada sem --until falha (mesmo contrato de routeIssue)", () => {
    const result = routeIssueForCreate({ track: "agendada" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exige --until/);
  });

  it("routeIssueForCreate: track != agendada COM --until falha", () => {
    const result = routeIssueForCreate({ track: "develop", until: "2026-09-01" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /só é aceito com --track agendada/);
  });

  it("routeIssueForCreate: agendada + --until insere o marcador no topo do corpo", () => {
    const result = routeIssueForCreate({ track: "agendada", until: "2026-09-01", body: "corpo original" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.labels, []);
    assert.equal(result.body, "<!-- aguardando-ate: 2026-09-01 -->\n\ncorpo original");
  });

  it("routeIssueForCreate: agendada sem body → marcador sozinho", () => {
    const result = routeIssueForCreate({ track: "agendada", until: "2026-09-01" });
    assert.equal(result.ok, true);
    assert.equal(result.body, "<!-- aguardando-ate: 2026-09-01 -->\n");
  });

  it("round-trip: labels de routeIssueForCreate produzem o track pedido em classifyExecTrack (não-agendada)", () => {
    for (const track of ROUTE_TRACKS) {
      if (track === "agendada") continue; // agendada depende do marcador no body, coberto abaixo
      const result = routeIssueForCreate({ track });
      assert.equal(result.ok, true);
      const resolved = classifyExecTrack({ labels: result.labels as string[], body: result.body, state: "OPEN" });
      assert.equal(resolved, track, `--for-create --track ${track} produziu labels que classificam "${resolved}"`);
    }
  });

  it("round-trip: agendada com marcador futuro classifica agendada", () => {
    const result = routeIssueForCreate({ track: "agendada", until: "2099-01-01" });
    assert.equal(result.ok, true);
    const resolved = classifyExecTrack({ labels: result.labels as string[], body: result.body, state: "OPEN" });
    assert.equal(resolved, "agendada");
  });
});
