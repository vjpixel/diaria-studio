/**
 * #12545 — `route-issue --track bloqueada` não pode desfazer um destravamento
 * recente sem citá-lo. Fixture: a thread real da #12348 (08/11/2026), com os
 * dois comentários do editor das 14:44Z copiados e o roteamento errado das
 * 23:49Z como o caso a recusar. Nenhuma chamada `gh` real: `ghRun` é injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, routeIssue } from "../scripts/route-issue.ts";
import { parseRouteIssueMarkerAtStart } from "../scripts/lib/issue-route.ts";
import {
  detectIgnoredRecentUnblock,
  reasonAcknowledgesUnblock,
  textReportsUnblock,
} from "../scripts/lib/route-reason-guard.ts";

type Comment = { body: string; createdAt: string; authorAssociation: string };

/** Comentário explicativo real do editor (08/11 14:44:29Z), resumido nas linhas que importam. */
const EXPLICA_14_44 =
  "Token Meta renovado (07/11/2026, sem expor o valor).\n\n" +
  "- Escopos: todos os do token anterior mais `instagram_manage_insights` e `read_insights`.\n" +
  "- Gravado no Doppler (releitura == token novo; insights 200 com o valor lido de volta) e no secret do Worker `diaria-linkedin-cron` (`wrangler secret put`, sucesso).\n" +
  "- `probe-instagram-comment-scope.ts --source worker` (edição 261109): `granted: true`.\n\n" +
  "Falta implementar a Fase 2 da #8260.";

/** Roteamento real do editor (08/11 14:44:35Z). Sozinho não usa vocabulário de destravamento. */
const ROTA_14_44 =
  "<!-- route-issue: track=overnight -->\n\nRoteado para **overnight** — token com instagram_manage_insights no Doppler e no Worker; falta implementar a Fase 2 da #8260";

/** Razão real do roteamento errado da rodada 261108b (23:49:43Z). */
const RAZAO_23_49 = "token Meta sem escopo instagram_manage_insights; ação do editor";

const THREAD_12348: Comment[] = [
  { body: "Pedido de ação imediata (/diaria-desbloqueia, 07/11): o editor pediu para ser perguntado de novo amanhã.", createdAt: "2026-11-08T02:10:17Z", authorAssociation: "OWNER" },
  { body: EXPLICA_14_44, createdAt: "2026-11-08T14:44:29Z", authorAssociation: "OWNER" },
  { body: ROTA_14_44, createdAt: "2026-11-08T14:44:35Z", authorAssociation: "OWNER" },
];

const NOW = new Date("2026-11-08T23:49:43Z");
/** A rodada informou ter lido a thread depois do roteamento das 14:44Z (por isso o #11301 não pegou). */
const TRIAGED_AT = "2026-11-08T23:40:00Z";

function run(extra: Partial<Parameters<typeof routeIssue>[0]>, comments: Comment[] = THREAD_12348) {
  const calls: string[][] = [];
  let labels = ["enhancement", "P2", "triada-overnight"];
  const result = routeIssue({
    issue: 12348,
    track: "bloqueada",
    reason: RAZAO_23_49,
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
  return { result, calls, wrote: calls.some((c) => c[1] === "edit" || c[1] === "comment") };
}

describe("#12545 — routeIssue não devolve a bloqueada uma issue recém-destravada (caso #12348)", () => {
  it("o roteamento das 23:49Z é recusado, sem nenhuma escrita", () => {
    const { result, wrote } = run({});
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /destravada e roteada para overnight em 2026-11-08T14:44:35Z/);
    assert.match(result.error ?? "", /#12545/);
    assert.equal(wrote, false);
  });

  it("razão que cita o destravamento e o que ainda falta passa", () => {
    const { result, calls } = run({ reason: "destravada em 08/11, mas o probe de insights ainda responde 403 com o token do .env" });
    assert.equal(result.ok, true, result.error);
    assert.ok(calls.some((c) => c[1] === "comment"));
  });

  it("--override-unblock sobrepõe e grava o motivo no comentário", () => {
    const { result, calls } = run({ overrideUnblock: "probe ao vivo voltou 403 às 23:45Z" });
    assert.equal(result.ok, true, result.error);
    const comment = calls.find((c) => c[1] === "comment");
    const body = comment ? comment[comment.indexOf("--body") + 1] : "";
    assert.match(body, /Sobreposição de destravamento recente: probe ao vivo voltou 403/);
  });

  it("--override-unblock vazio é recusado; --force e --override-newer não dispensam o guard", () => {
    assert.equal(run({ overrideUnblock: "  " }).result.ok, false);
    assert.match(run({ force: true }).result.error ?? "", /#12545/);
    assert.match(run({ overrideNewer: "relido" }).result.error ?? "", /#12545/);
  });

  it("depois de 24 h o destravamento deixa de segurar o roteamento (quem recusa passa a ser o #12744)", () => {
    const { result } = run({ now: new Date("2026-11-09T15:00:00Z"), triagedAt: "2026-11-09T14:50:00Z" });
    assert.doesNotMatch(result.error ?? "", /#12545/);
    assert.match(result.error ?? "", /#12744/);
  });

  it("comentário explicativo de conta externa não conta como destravamento", () => {
    const thread = THREAD_12348.map((c) => (c.body === EXPLICA_14_44 ? { ...c, authorAssociation: "NONE" } : c));
    const { result } = run({}, thread);
    assert.doesNotMatch(result.error ?? "", /#12545/);
    assert.match(result.error ?? "", /#12744/);
  });

  it("issue roteada para overnight sem destravamento (decisão → bloqueio de execução, #5373 item 5) fica livre do #12545", () => {
    const thread: Comment[] = [
      { body: "<!-- route-issue: track=overnight -->\n\nRoteado para **overnight** — decidido no briefing 261108", createdAt: "2026-11-08T22:00:00Z", authorAssociation: "OWNER" },
    ];
    // Livre do #12545; desde o #12744 a razão precisa citar o roteamento.
    assert.match(run({ reason: "a execução exige conta de terceiro" }, thread).result.error ?? "", /#12744/);
    const { result } = run({ reason: "roteada para overnight no briefing 261108, mas a execução exige conta de terceiro" }, thread);
    assert.equal(result.ok, true, result.error);
  });

  it("issue que saiu de bloqueada há menos de 24 h é guardada mesmo sem vocabulário de destravamento", () => {
    const thread: Comment[] = [
      { body: "<!-- route-issue: track=bloqueada -->\n\nRoteado para **bloqueada** — falta conta", createdAt: "2026-11-07T10:00:00Z", authorAssociation: "OWNER" },
      { body: "<!-- route-issue: track=overnight -->\n\nRoteado para **overnight** — conta aberta pelo editor", createdAt: "2026-11-08T20:00:00Z", authorAssociation: "OWNER" },
    ];
    assert.equal(run({ reason: "falta conta" }, thread).result.ok, false);
  });

  it("CLI aceita --override-unblock e recusa valor ausente", () => {
    const parsed = parseArgs(["--issue", "1", "--track", "bloqueada", "--reason", "x", "--override-unblock", "motivo"]);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.overrideUnblock, "motivo");
    assert.ok("error" in parseArgs(["--issue", "1", "--track", "bloqueada", "--override-unblock"]));
  });
});

describe("#12545 — detectIgnoredRecentUnblock (puro)", () => {
  const base = { reason: RAZAO_23_49, now: NOW, comments: THREAD_12348, parseTrack: parseRouteIssueMarkerAtStart };

  it("só guarda bloqueada", () => {
    assert.ok(detectIgnoredRecentUnblock({ ...base, track: "bloqueada" }));
    for (const track of ["overnight", "develop", "agendada", "fora-de-rodada"]) {
      assert.equal(detectIgnoredRecentUnblock({ ...base, track }), null, track);
    }
  });

  it("roteamento mais recente já em bloqueada não é destravamento", () => {
    const comments = [...THREAD_12348, { body: "<!-- route-issue: track=bloqueada -->\n\nRoteado para **bloqueada** — x", createdAt: "2026-11-08T20:00:00Z" }];
    assert.equal(detectIgnoredRecentUnblock({ ...base, track: "bloqueada", comments }), null);
  });

  it("comentário explicativo fora da janela de 30 min antes do roteamento não conta", () => {
    const comments = THREAD_12348.map((c) => (c.body === EXPLICA_14_44 ? { ...c, createdAt: "2026-11-08T13:00:00Z" } : c));
    assert.equal(detectIgnoredRecentUnblock({ ...base, track: "bloqueada", comments }), null);
  });

  it("vocabulário de destravamento dos comentários reais é reconhecido; razão do corpo não o reconhece", () => {
    assert.equal(textReportsUnblock(EXPLICA_14_44), true);
    assert.equal(textReportsUnblock("Roteado para **overnight** — /diaria-desbloqueia 09/11, probe: GET /insights responde 200 (1 série)"), true);
    assert.equal(textReportsUnblock(ROTA_14_44), false);
    assert.equal(reasonAcknowledgesUnblock(RAZAO_23_49), false);
    assert.equal(reasonAcknowledgesUnblock("destravada em 08/11, mas ainda 403"), true);
    assert.equal(reasonAcknowledgesUnblock("o bloqueio voltou: token revogado"), true);
  });
});
