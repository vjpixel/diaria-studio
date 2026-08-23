/**
 * test/issue-route.test.ts (#5969 Fase 1)
 *
 * Cobre `scripts/lib/issue-route.ts` (mapeamento puro veredito→labels) e
 * `scripts/route-issue.ts` (verbo de I/O — sempre com `GhRunFn` em memória,
 * NUNCA `gh` real, mesmo padrão de `test/wait-until-sync.test.ts` e
 * `test/alarm-issues.test.ts`).
 *
 * Casos exigidos pela issue:
 *   1. mapeamento veredito→labels: idempotência (aplicar duas vezes dá o
 *      mesmo resultado) e "remove as labels erradas de vereditos anteriores".
 *   2. validação pós-escrita: falha ruidosa quando classifyExecTrack não
 *      bate com o --track pedido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRouteLabelPlan,
  diffRouteLabelPlan,
  planRouteLabels,
  ROUTABLE_LABELS,
  ROUTE_TRACKS,
  type RouteTrack,
} from "../scripts/lib/issue-route.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";
import { routeIssue, type GhRunFn } from "../scripts/route-issue.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

// ─── planRouteLabels / applyRouteLabelPlan — mapeamento puro ────────────────

describe("planRouteLabels — round-trip contra classifyExecTrack", () => {
  // "agendada" é o único veredito sem label (o sinal é o marcador
  // aguardando-ate: no CORPO, não uma label — ver docstring do módulo) então
  // seu round-trip é testado à parte, abaixo, com o marcador no body.
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

  it("preserva labels que não pertencem a ROUTABLE_LABELS (ex: tipo/prioridade)", () => {
    const plan = planRouteLabels("develop");
    const next = applyRouteLabelPlan(["enhancement", "P2", "windows"], plan);
    assert.deepEqual(new Set(next), new Set(["enhancement", "P2", "develop-track"]));
  });
});

describe("applyRouteLabelPlan — idempotência", () => {
  for (const track of ROUTE_TRACKS) {
    it(`aplicar o plano de "${track}" duas vezes seguidas converge pro mesmo conjunto (${track})`, () => {
      const plan = planRouteLabels(track);
      const once = applyRouteLabelPlan(["windows", "not-this-week", "enhancement"], plan);
      const twice = applyRouteLabelPlan(once, plan);
      assert.deepEqual(new Set(once), new Set(twice));
    });
  }
});

describe("diffRouteLabelPlan — só o que muda de verdade", () => {
  it("labels já corretas não geram diff nenhum (0 chamadas de gh issue edit)", () => {
    const plan = planRouteLabels("develop");
    const { toAdd, toRemove } = diffRouteLabelPlan(["develop-track", "enhancement"], plan);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, []);
  });

  it("calcula toAdd/toRemove ordenados e mínimos", () => {
    const plan = planRouteLabels("bloqueada");
    const { toAdd, toRemove } = diffRouteLabelPlan(["windows", "external-blocker"], plan);
    assert.deepEqual(toAdd, ["bloqueio-execucao"]);
    // "bloqueada" canonicaliza pra uma única label (bloqueio-execucao) — o
    // veredito é "sessão nenhuma destrava sozinha", então a razão específica
    // anterior (external-blocker) é substituída, não preservada ao lado.
    assert.deepEqual(toRemove, ["external-blocker", "windows"]);
  });
});

// ─── routeIssue — I/O via GhRunFn em memória (sem rede/gh real) ────────────

interface FakeIssueState {
  labels: string[];
  body: string;
  state: string;
  comments: string[];
}

/** Stub de `GhRunFn` que serve `gh issue view --json labels,body,state,comments`
 * a partir de estado em memória e aplica `gh issue edit --add-label/--remove-label`,
 * `gh issue comment --body` de volta nele. Mesma técnica de `fakeGh` em
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
      // (stdout = corpo cru, não JSON) — distinto do `--json labels,body,state,comments`
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
      reason: "exige a máquina Windows",
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
    assert.match(result.error ?? "", /só é aceito com --track agendada/);
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

  it("dedup: rodar o mesmo veredito+razão duas vezes não duplica o comentário", () => {
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

describe("routeIssue — validação pós-escrita falha ruidosamente", () => {
  it("issue CLOSED nunca vira 'develop' — validação recusa e reporta o resolvedTrack real", () => {
    const gh = fakeGh({ labels: [], body: "", state: "CLOSED", comments: [] });
    const result = routeIssue({ issue: 48, track: "develop", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, false);
    assert.equal(result.validated, false);
    assert.equal(result.resolvedTrack, "fora-de-rodada");
    assert.match(result.error ?? "", /validação pós-escrita falhou/);
    assert.match(result.error ?? "", /pedido --track develop/);
    // As escritas já feitas (label) não são silenciadas mesmo com a falha:
    assert.deepEqual(result.labelsAdded, ["develop-track"]);
  });

  it("label de OUTRO mecanismo (fora de ROUTABLE_LABELS, ex: 'alarm') sobrevivendo ao plano faz a validação de 'overnight' falhar", () => {
    // "alarm" é deliberadamente fora do escopo de route-issue (owned by
    // scripts/lib/alarm-issues.ts — ver docstring do módulo) — route-issue
    // não a remove ao rotear pra "overnight". A VALIDAÇÃO precisa pegar essa
    // divergência (classifyExecTrack devolve "fora-de-rodada", não
    // "overnight"), não só confiar que o plano de labels bastou.
    const gh = fakeGh({ labels: ["alarm"], body: "", state: "OPEN", comments: [] });
    const result = routeIssue({ issue: 49, track: "overnight", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, false);
    assert.equal(result.resolvedTrack, "fora-de-rodada");
    assert.match(result.error ?? "", /pedido --track overnight/);
    assert.match(result.error ?? "", /fora-de-rodada/);
    // A label "alarm" continua lá — route-issue não pisa em estado de outro
    // mecanismo, mesmo quando isso significa a validação falhar.
    assert.ok(gh.state.labels.includes("alarm"));
  });
});

describe("routeIssue — falhas de gh (fail-soft explícito, nunca silencioso)", () => {
  it("gh issue view falhando na leitura inicial devolve ok:false sem tentar editar", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") return { status: 1, stdout: "", stderr: "gh: not authenticated" };
      throw new Error(`não devia chamar: ${args.join(" ")}`);
    };
    const result = routeIssue({ issue: 50, track: "develop", cwd: "/tmp", ghRun: run });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not authenticated/);
  });

  it("gh issue comment falhando reporta commentAction 'failed' sem reverter labels já escritas", () => {
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
