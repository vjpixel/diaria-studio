/**
 * #12744 — `route-issue --track bloqueada` não pode contrariar o roteamento
 * mais recente da thread (de outro track) sem citá-lo, em qualquer idade.
 * Fixture: a thread real da #12348 até 10/11/2026, com o roteamento errado da
 * rodada 261110d (18:46:26Z) como o caso a recusar — 28 h depois do último
 * roteamento para overnight, fora da janela de 24 h do #12545. Também o caso
 * #12737 (decisão do editor ignorada por `--motivo trade-off`). Nenhuma
 * chamada `gh` real: `ghRun` é injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, routeIssue } from "../scripts/route-issue.ts";
import { parseRouteIssueMarkerAtStart } from "../scripts/lib/issue-route.ts";
import { formatDecisionMarker } from "../scripts/lib/issue-decisions.ts";
import {
  detectIgnoredDecision,
  detectIgnoredLatestRoute,
  detectIgnoredRecentUnblock,
  reasonAcknowledgesRoute,
} from "../scripts/lib/route-reason-guard.ts";

type Comment = { body: string; createdAt: string; authorAssociation: string };

const route = (track: string, text: string) => `<!-- route-issue: track=${track} -->\n\nRoteado para **${track}** — ${text}`;

/** Thread real da #12348 (comentários de roteamento e os explicativos que importam). */
const THREAD_12348: Comment[] = [
  { body: "Token Meta renovado (07/11/2026, sem expor o valor). Escopos: ... mais `instagram_manage_insights`.", createdAt: "2026-11-08T14:44:29Z", authorAssociation: "OWNER" },
  { body: route("overnight", "token com instagram_manage_insights no Doppler e no Worker; falta implementar a Fase 2 da #8260"), createdAt: "2026-11-08T14:44:35Z", authorAssociation: "OWNER" },
  { body: route("bloqueada", "token Meta sem escopo instagram_manage_insights; ação do editor"), createdAt: "2026-11-08T23:49:43Z", authorAssociation: "OWNER" },
  { body: route("overnight", "/diaria-desbloqueia 09/11, probe: GET /{IG_ID}/insights?metric=follower_count com o INSTAGRAM_ACCESS_TOKEN do .env responde 200 (1 série). Resta implementar a Fase 2 da #8260, mecânico."), createdAt: "2026-11-09T14:38:58Z", authorAssociation: "OWNER" },
  { body: route("overnight", "/diaria-desbloqueia 09/11: o token do Instagram já tem escopo de insights (probe 200). Resta implementar a Fase 2 da #8260, mecânico."), createdAt: "2026-11-09T14:42:10Z", authorAssociation: "OWNER" },
  { body: "overnight 261110d: issue vista e mantida fora desta rodada. Motivo: `bloqueio-externo` — token Meta sem permissao instagram_manage_insights; exige acao do editor na conta.", createdAt: "2026-11-10T15:48:52Z", authorAssociation: "OWNER" },
];

/** Razão real do roteamento errado da rodada 261110d (10/11 18:46:26Z). */
const RAZAO_18_46 = "bloqueio externo: token Meta sem permissao instagram_manage_insights; acao do editor na conta";
const NOW = new Date("2026-11-10T18:46:26Z");
const TRIAGED_AT = "2026-11-10T18:40:00Z";

function run(extra: Partial<Parameters<typeof routeIssue>[0]>, comments: Comment[] = THREAD_12348) {
  const calls: string[][] = [];
  let labels = ["enhancement", "P2"];
  const result = routeIssue({
    issue: 12348,
    track: "bloqueada",
    reason: RAZAO_18_46,
    triagedAt: TRIAGED_AT,
    now: NOW,
    cwd: "/tmp",
    ...extra,
    ghRun(args) {
      calls.push(args);
      if (args[1] === "view") {
        return {
          status: 0,
          stderr: "",
          stdout: args.includes("-q")
            ? "corpo"
            : JSON.stringify({ labels: labels.map((name) => ({ name })), body: "Token Meta sem instagram_manage_insights", state: "OPEN", comments }),
        };
      }
      if (args[1] === "edit") {
        if (args.includes("--remove-label")) {
          const rm = args[args.indexOf("--remove-label") + 1].split(",");
          labels = labels.filter((l) => !rm.includes(l));
        }
        if (args.includes("--add-label")) labels.push(...args[args.indexOf("--add-label") + 1].split(","));
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  });
  const comment = calls.find((c) => c[1] === "comment");
  return {
    result,
    wrote: calls.some((c) => c[1] === "edit" || c[1] === "comment"),
    commentBody: comment ? comment[comment.indexOf("--body") + 1] : "",
  };
}

describe("#12744 — routeIssue não devolve a bloqueada contrariando o roteamento mais recente (caso #12348, 10/11)", () => {
  it("o #12545 sozinho deixava passar: 28 h depois, fora da janela de 24 h", () => {
    assert.equal(
      detectIgnoredRecentUnblock({ track: "bloqueada", reason: RAZAO_18_46, now: NOW, comments: THREAD_12348, parseTrack: parseRouteIssueMarkerAtStart }),
      null,
    );
  });

  it("o roteamento das 18:46Z é recusado, sem nenhuma escrita", () => {
    const { result, wrote } = run({});
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /roteamento mais recente da thread é para overnight \(2026-11-09T14:42:10Z\)/);
    assert.match(result.error ?? "", /#12744/);
    assert.equal(wrote, false);
  });

  it("razão que cita o roteamento e por que não vale mais passa", () => {
    const { result } = run({ reason: "roteada para overnight em 09/11, mas o probe de hoje responde 403 com o token do .env" });
    assert.equal(result.ok, true, result.error);
  });

  it("razão que cita o destravamento também passa", () => {
    assert.equal(run({ reason: "destravada em 09/11, mas o token foi revogado hoje" }).result.ok, true);
  });

  it("--override-reroute sobrepõe e grava o motivo no comentário", () => {
    const { result, commentBody } = run({ overrideReroute: "probe ao vivo de 10/11 18:40Z voltou 403" });
    assert.equal(result.ok, true, result.error);
    assert.match(commentBody, /Sobreposição do roteamento mais recente: probe ao vivo de 10\/11 18:40Z voltou 403/);
  });

  it("--override-unblock também dispensa; --override-reroute vazio é recusado; --force/--override-newer não dispensam", () => {
    assert.equal(run({ overrideUnblock: "probe 403" }).result.ok, true);
    assert.equal(run({ overrideReroute: "  " }).result.ok, false);
    assert.match(run({ force: true }).result.error ?? "", /#12744/);
    assert.match(run({ overrideNewer: "relido" }).result.error ?? "", /#12744/);
  });

  it("issue sem roteamento anterior, ou com o mais recente já em bloqueada, segue livre", () => {
    assert.equal(run({}, []).result.ok, true);
    const already = [...THREAD_12348, { body: route("bloqueada", "x"), createdAt: "2026-11-10T16:00:00Z", authorAssociation: "OWNER" }];
    assert.equal(run({}, already).result.ok, true);
  });

  it("roteamento de conta externa não conta", () => {
    const thread = THREAD_12348.map((c) => (c.body.startsWith("<!-- route-issue: track=overnight") ? { ...c, authorAssociation: "NONE" } : c));
    assert.equal(run({}, thread).result.ok, true);
  });

  it("CLI aceita --override-reroute e recusa valor ausente", () => {
    const parsed = parseArgs(["--issue", "1", "--track", "bloqueada", "--reason", "x", "--override-reroute", "motivo"]);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.overrideReroute, "motivo");
    assert.ok("error" in parseArgs(["--issue", "1", "--track", "bloqueada", "--override-reroute"]));
  });
});

describe("#12744 — detectIgnoredLatestRoute / reasonAcknowledgesRoute (puro)", () => {
  const base = { reason: RAZAO_18_46, comments: THREAD_12348, parseTrack: parseRouteIssueMarkerAtStart };

  it("só guarda bloqueada", () => {
    assert.ok(detectIgnoredLatestRoute({ ...base, track: "bloqueada" }));
    for (const track of ["overnight", "develop", "agendada", "fora-de-rodada"]) {
      assert.equal(detectIgnoredLatestRoute({ ...base, track }), null, track);
    }
  });

  it("vale para qualquer track anterior, não só overnight", () => {
    const comments = [{ body: route("develop", "exige Chrome logado"), createdAt: "2026-10-01T10:00:00Z" }];
    assert.match(detectIgnoredLatestRoute({ ...base, track: "bloqueada", comments }) ?? "", /para develop/);
  });

  it("roteamento sem createdAt legível fica de fora", () => {
    const comments = [{ body: route("overnight", "x") }];
    assert.equal(detectIgnoredLatestRoute({ ...base, track: "bloqueada", comments }), null);
  });

  it("reconhece a citação do roteamento; a razão do corpo não", () => {
    assert.equal(reasonAcknowledgesRoute(RAZAO_18_46, "overnight"), false);
    assert.equal(reasonAcknowledgesRoute("roteada para overnight em 09/11, mas 403", "overnight"), true);
    assert.equal(reasonAcknowledgesRoute("o roteamento de 09/11 assumiu probe 200; hoje dá 403", "overnight"), true);
    assert.equal(reasonAcknowledgesRoute("o roteamento anterior não vale: token revogado", "overnight"), true);
    assert.equal(reasonAcknowledgesRoute("route-issue de 09/11 superado: token revogado", "overnight"), true);
    // Track errado não conta como citação.
    assert.equal(reasonAcknowledgesRoute("roteada para develop por engano", "overnight"), false);
  });
});

describe("#12744 — decisão do editor ignorada por --motivo trade-off (caso #12737)", () => {
  const decisionBody = formatDecisionMarker({
    decided_at: "2026-11-10T00:11:00Z",
    sessao: "interactive",
    pergunta: "#12737: qual desenho?",
    resposta: "opção B, sem novo endpoint",
  });

  it("detectIgnoredDecision guarda --motivo trade-off mesmo no track overnight", () => {
    const decision = { decided_at: "2026-11-10T00:11:00Z", resposta: "opção B" };
    const reason = "exige decisão do editor (desenho/escopo)";
    assert.match(detectIgnoredDecision({ track: "overnight", reason, decision, motivo: "trade-off" }) ?? "", /--motivo trade-off/);
    assert.equal(detectIgnoredDecision({ track: "overnight", reason, decision }), null);
    assert.equal(detectIgnoredDecision({ track: "overnight", reason: "decisão do editor de 10/11 já registrada; falta X", decision, motivo: "trade-off" }), null);
  });

  it("routeIssue recusa o re-roteamento das 00:17 com trade-off sem citar a decisão das 00:11", () => {
    const thread: Comment[] = [
      { body: decisionBody, createdAt: "2026-11-10T00:11:00Z", authorAssociation: "OWNER" },
      { body: route("overnight", "triada; decisão registrada"), createdAt: "2026-11-10T00:14:00Z", authorAssociation: "OWNER" },
    ];
    const { result, wrote } = run(
      { issue: 12737, track: "overnight", motivo: "trade-off", reason: "exige decisão do editor (desenho/escopo)", now: new Date("2026-11-10T00:17:00Z"), triagedAt: "2026-11-10T00:16:00Z" },
      thread,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /decisão do editor registrada em 2026-11-10/);
    assert.equal(wrote, false);
  });
});
