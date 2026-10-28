import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeIssue, parseArgs } from "../scripts/route-issue.ts";
import { formatDecisionMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";

const initial = "2026-10-27T12:00:00Z";
const newer = "2026-10-27T12:56:00Z";
const now = new Date("2026-10-27T13:50:00Z");
function run(extra: Partial<Parameters<typeof routeIssue>[0]> = {}, comments: Array<{ body: string; createdAt: string; authorAssociation: string }> = [
  { body: "<!-- route-issue: track=overnight -->", createdAt: newer, authorAssociation: "OWNER" },
], initialLabels: string[] = []) {
  const calls: string[][] = [];
  let labels: string[] = [...initialLabels];
  const result = routeIssue({
    issue: 11251, track: "bloqueada", reason: "credencial que só o editor provisiona",
    triagedAt: initial, now, cwd: "/tmp", ...extra,
    ghRun(args) {
      calls.push(args);
      if (args[1] === "view") return { status: 0, stderr: "", stdout: args.includes("-q") ? "corpo" : JSON.stringify({ labels: labels.map(name => ({ name })), body: "corpo", state: "OPEN", comments }) };
      if (args[1] === "edit") {
        if (args.includes("--remove-label")) labels = labels.filter(l => !args[args.indexOf("--remove-label") + 1].split(",").includes(l));
        if (args.includes("--add-label")) labels.push(...args[args.indexOf("--add-label") + 1].split(","));
      }
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
it("histórico antigo relido permite reclassificação com payload real do gh", () => {
  assert.equal(run({}, [{ body: "<!-- route-issue: track=overnight -->", createdAt: initial, authorAssociation: "MEMBER" }]).result.ok, true);
});
it("decisão do editor recente exige releitura mesmo sem declarar track", () => refused({}, [{ body: formatDecisionMarker({ decided_at: newer, pergunta: "bloqueio?", resposta: "removido", sessao: "develop" }), createdAt: newer, authorAssociation: "OWNER" }]));
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
  assert.equal(run({}, [...comments].reverse()).result.ok, true);
});

it("#11315: desbloqueia relê decisão e roteia fora-de-rodada → overnight sem override", () => {
  const comments = [{
    body: formatDecisionMarker({ decided_at: newer, pergunta: "qual critério?", resposta: "implementar o critério definido", sessao: "develop" }),
    createdAt: newer, authorAssociation: "OWNER",
  }];
  const { result, calls } = run({ track: "overnight", motivo: "triada", triagedAt: "2026-10-27T12:57:00Z" }, comments, ["sem-direcao-acionavel"]);
  assert.equal(result.ok, true, result.error);
  assert.ok(calls.some(c => c[1] === "edit"));
  assert.ok(calls.some(c => c[1] === "comment"));
});
it("#11315: decisão recente também protege quando labels já coincidem com o pedido", () => {
  refused({ track: "overnight" }, [{
    body: formatDecisionMarker({ decided_at: newer, pergunta: "qual direção?", resposta: "reavaliar o escopo", sessao: "develop" }),
    createdAt: newer, authorAssociation: "OWNER",
  }]);
});

it("#11315: develop consome decisão e remove trade-off-real com histórico de bloqueio real", () => {
  // Usa o comentário realmente produzido por routeIssue, com os dois marcadores.
  const blocked = run({}, []).calls.find(c => c[1] === "comment")!;
  const body = blocked[blocked.indexOf("--body") + 1];
  assert.match(body, /route-issue:/);
  assert.match(body, /bloqueio-execucao:/);
  const comments = [
    { body, createdAt: initial, authorAssociation: "OWNER" },
    { body: formatDecisionMarker({ decided_at: newer, pergunta: "qual opção?", resposta: "opção A, implementar", sessao: "develop" }), createdAt: newer, authorAssociation: "OWNER" },
  ];
  const extra = { track: "overnight" as const, motivo: "triada" as const, triagedAt: "2026-10-27T12:57:00Z" };
  const { result, calls } = run(extra, comments, ["trade-off-real", "bloqueio-execucao"]);
  assert.equal(result.ok, true, result.error);
  assert.ok(calls.find(c => c[1] === "edit")?.join(" ").includes("trade-off-real"));
  // Outra sessão roteou depois da releitura da decisão: nenhuma escrita.
  refused(extra, [...comments, { body, createdAt: "2026-10-27T12:58:00Z", authorAssociation: "OWNER" }]);
  refused(extra, [...comments, { body: "<!-- route-issue: track=develop -->", createdAt: "2026-10-27T12:58:00Z", authorAssociation: "OWNER" }]);
});

it("marcador sem data não desaparece atrás de marcador datado", () => {
  const comments = [
    { body: "<!-- route-issue: track=develop -->", createdAt: "", authorAssociation: "OWNER" },
    { body: "<!-- route-issue: track=bloqueada -->", createdAt: newer, authorAssociation: "OWNER" },
  ];
  refused({}, comments);
  refused({}, [...comments].reverse());
});

it("CLI não substitui releitura pelo início da sessão", () => {
  const parsed = parseArgs(["--issue", "1", "--track", "overnight"]);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.triagedAt, undefined);
});

it("#11315: todos os coordenadores instruem releitura após decisão e timestamp explícito", () => {
  for (const path of [
    ".claude/skills/diaria-develop/SKILL.md",
    ".claude/skills/diaria-overnight/SKILL.md",
    ".claude/skills/diaria-continuo/SKILL.md",
    ".claude/skills/diaria-desbloqueia/SKILL.md",
    "hermes/skills/hermes-diaria-continuo/SKILL.md",
  ]) {
    const text = readFileSync(new URL("../" + path, import.meta.url), "utf8");
    assert.match(text, /--triaged-at "\{triaged_at\}"/, path);
    assert.match(text, /Depois de postar `decisao-editor`/, path);
    assert.match(text, /no início dessa nova leitura, após a postagem/, path);
  }
});
