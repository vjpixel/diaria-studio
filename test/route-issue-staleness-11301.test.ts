import { it } from "node:test";
import assert from "node:assert/strict";
import { routeIssue, parseArgs } from "../scripts/route-issue.ts";
import { formatDecisionMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";

const initial = "2026-10-27T12:00:00Z";
const newer = "2026-10-27T12:56:00Z";
const now = new Date("2026-10-27T13:50:00Z");
function run(extra: Partial<Parameters<typeof routeIssue>[0]> = {}, comments = [
  { body: "<!-- route-issue: track=overnight -->", createdAt: newer, authorAssociation: "OWNER" },
]) {
  const calls: string[][] = [];
  let labels: string[] = [];
  const result = routeIssue({
    issue: 11251, track: "bloqueada", reason: "credencial que só o editor provisiona",
    triagedAt: initial, now, cwd: "/tmp", ...extra,
    ghRun(args) {
      calls.push(args);
      if (args[1] === "view") return { status: 0, stderr: "", stdout: args.includes("-q") ? "corpo" : JSON.stringify({ labels: labels.map(name => ({ name })), body: "corpo", state: "OPEN", comments }) };
      if (args[1] === "edit" && args.includes("--add-label")) labels = args[args.indexOf("--add-label") + 1].split(",");
      return { status: 0, stderr: "", stdout: "" };
    },
  });
  return { result, calls };
}
function refused(extra = {}, comments?: Parameters<typeof run>[1]) {
  const { result, calls } = run(extra, comments);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /roteamento mais novo/);
  assert.equal(calls.some(c => c[1] === "edit" || c[1] === "comment"), false);
}
it("#11301: triagem 12h não re-bloqueia roteamento das 12:56 às 13:50", () => refused());
it("--force não sobrepõe roteamento mais novo", () => refused({ force: true }));
it("sem base temporal, exige releitura antes de mudar track com histórico", () => refused({ triagedAt: undefined }));
it("releitura posterior ao roteamento permite novo julgamento", () => assert.equal(run({ triagedAt: "2026-10-27T13:49:00Z" }).result.ok, true));
it("mesmo track é idempotente", () => assert.equal(run({ track: "overnight" }).result.ok, true));
it("override exige motivo e registra-o no comentário", () => {
  assert.equal(run({ overrideNewer: " " }).result.ok, false);
  const { result, calls } = run({ overrideNewer: "credencial revalidada e revogada agora" });
  assert.equal(result.ok, true);
  assert.match(calls.find(c => c[1] === "comment")?.join(" ") ?? "", /credencial revalidada e revogada agora/);
});
it("comentário externo não comanda o roteamento", () => assert.equal(run({}, [{ body: "<!-- route-issue: track=overnight -->", createdAt: newer, authorAssociation: "NONE" }]).result.ok, true));
it("edição recente de comentário antigo também protege", () => refused({}, [{ body: "<!-- route-issue: track=overnight -->", createdAt: initial, updatedAt: newer, authorAssociation: "MEMBER" }]));
it("decisão do editor recente impede contradizer o track atual", () => refused({}, [{ body: formatDecisionMarker({ decided_at: newer, pergunta: "bloqueio?", resposta: "removido", sessao: "develop" }), createdAt: newer, authorAssociation: "OWNER" }]));
it("bloqueio recente impede desbloqueio com triagem antiga", () => {
  const body = formatExecutionBlockMarker({ recorded_at: "2026-10-27", motivo: "credencial", sessao: "develop", condicao: { tipo: "externo", descricao: "renovar" } });
  refused({ track: "develop" }, [{ body, createdAt: newer, authorAssociation: "COLLABORATOR" }]);
});
it("CLI reconhece flags e recusa valor ausente", () => {
  const args = parseArgs(["--issue", "1", "--track", "overnight", "--triaged-at", initial, "--override-newer", "revalidado"]);
  assert.ok(!("error" in args));
  assert.equal(args.triagedAt, initial);
  assert.equal(args.overrideNewer, "revalidado");
  assert.ok("error" in parseArgs(["--issue", "1", "--track", "overnight", "--triaged-at"]));
});
it("timestamp inválido ou futuro não autoriza escrita", () => {
  for (const triagedAt of ["inválido", "2027-01-01T00:00:00Z"]) {
    const { result, calls } = run({ triagedAt });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  }
});
it("só o roteamento mais recente decide, independente da ordem recebida", () => {
  const comments = [
    { body: "<!-- route-issue: track=bloqueada -->", createdAt: "2026-10-27T13:00:00Z", authorAssociation: "OWNER" },
    { body: "<!-- route-issue: track=overnight -->", createdAt: newer, authorAssociation: "OWNER" },
  ];
  assert.equal(run({}, comments).result.ok, true);
  assert.equal(run({}, comments.toReversed()).result.ok, true);
});
