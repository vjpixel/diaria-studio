/**
 * #12389 — re-roteamento por outra sessão não pode ignorar um `decisao-editor`
 * vigente. Fixture: a thread real da #12104 (comentários de 04/11 e 08/11),
 * com o marcador de decisão copiado byte a byte. Nenhuma chamada `gh` real:
 * `ghRun` é injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, routeIssue } from "../scripts/route-issue.ts";
import { latestDecisionFor } from "../scripts/lib/issue-decisions.ts";
import { detectIgnoredDecision, reasonAcknowledgesDecision } from "../scripts/lib/route-reason-guard.ts";

/** Marcador real do comentário do editor na #12104 (04/11/2026 04:17Z). */
const DECISAO_12104 =
  "Decisão do editor (/diaria-desbloqueia, 04/11): **remover o modo `--title-mode text`**. O PNG é o padrão desde a #12095, e o gerador Text do FCP7 sai do build junto com o fundo Color+Crop e a quebra `\\r`. Não precisa de import no Premiere.\n\n" +
  "<!-- decisao-editor: eyJkZWNpZGVkX2F0IjoiMjAyNi0xMS0wNFQwNDoxNzoxMy4zNzNaIiwicGVyZ3VudGEiOiIjMTIxMDQ6IG8gcXVlIGZhemVyIGNvbSBvIG1vZG8gLS10aXRsZS1tb2RlIHRleHQgKGZ1bmRvIENvbG9yK0Nyb3AgZSBxdWVicmEgXFxyIG7Do28gdmFsaWRhZG9zKT8iLCJyZXNwb3N0YSI6IlJlbW92ZXIgbyBtb2RvIHRleHQ7IG8gdMOtdHVsbyBlbSBQTkcgZmljYSBjb21vIMO6bmljbyBjYW1pbmhvLiIsInNlc3NhbyI6ImRldmVsb3AifQ== -->\n";

/** Razões reais dos roteamentos da #12104. */
const RAZAO_C4_DEVELOP = "as duas opções exigem import real no Premiere";
const RAZAO_0208_DEVELOP =
  "exige import real no Premiere do editor (validar quebra de linha e fundo do modo text) ou decisão de remover o modo após a conferência da #11756";
const RAZAO_0005_OVERNIGHT =
  "decisão do editor de 04/11 já registrada: remover o modo --title-mode text; não exige import no Premiere, é código + teste (#6628)";
const RAZAO_C3_OVERNIGHT = "decisão do editor registrada (04/11): remover o modo --title-mode text; resto é código + teste";

type Comment = { body: string; createdAt: string; authorAssociation: string };

/** Thread da #12104 até o roteamento das 00:05Z de 08/11 (o último antes do bug). */
const THREAD_12104: Comment[] = [
  { body: "<!-- route-issue: track=develop -->\n\nRoteado para **develop** — validar o modo --title-mode text exige um import real no Premiere do Neo", createdAt: "2026-11-04T04:06:05Z", authorAssociation: "OWNER" },
  { body: DECISAO_12104, createdAt: "2026-11-04T04:17:14Z", authorAssociation: "OWNER" },
  { body: `<!-- route-issue: track=overnight -->\n\nRoteado para **overnight** — ${RAZAO_C3_OVERNIGHT}`, createdAt: "2026-11-04T04:17:21Z", authorAssociation: "OWNER" },
  { body: `<!-- route-issue: track=develop -->\n\nRoteado para **develop** — ${RAZAO_C4_DEVELOP}`, createdAt: "2026-11-04T06:23:10Z", authorAssociation: "OWNER" },
  { body: `<!-- route-issue: track=overnight -->\n\nRoteado para **overnight** — ${RAZAO_0005_OVERNIGHT}`, createdAt: "2026-11-08T00:05:44Z", authorAssociation: "OWNER" },
];

const NOW = new Date("2026-11-08T02:08:20Z");
/** A sessão das 02:08Z leu a thread depois do roteamento das 00:05Z. */
const TRIAGED_AT = "2026-11-08T02:00:00Z";

function run(
  extra: Partial<Parameters<typeof routeIssue>[0]>,
  comments: Comment[] = THREAD_12104,
  initialLabels: string[] = ["enhancement", "P3"],
) {
  const calls: string[][] = [];
  let labels = [...initialLabels];
  const result = routeIssue({
    issue: 12104,
    track: "develop",
    reason: RAZAO_0208_DEVELOP,
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
            : JSON.stringify({ labels: labels.map((name) => ({ name })), body: "Escolher um dos caminhos", state: "OPEN", comments }),
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

describe("#12389 — routeIssue não ignora decisao-editor vigente (caso #12104)", () => {
  it("o marcador real da #12104 é lido como decisão vigente", () => {
    const d = latestDecisionFor(THREAD_12104.map((c) => c.body));
    assert.ok(d);
    assert.equal(d.decided_at.slice(0, 10), "2026-11-04");
    assert.match(d.resposta, /Remover o modo text/);
  });

  it("o re-roteamento das 02:08Z para develop é recusado, sem nenhuma escrita", () => {
    const { result, wrote } = run({});
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /decisão do editor registrada em 2026-11-04/);
    assert.match(result.error ?? "", /Remover o modo text/);
    assert.equal(wrote, false);
  });

  it("o roteamento de 04/11 06:23Z ('as duas opções exigem import') também é recusado", () => {
    const thread = THREAD_12104.slice(0, 3);
    const { result, wrote } = run({ reason: RAZAO_C4_DEVELOP, triagedAt: "2026-11-04T06:20:00Z", now: new Date("2026-11-04T06:23:10Z") }, thread);
    assert.equal(result.ok, false);
    assert.equal(wrote, false);
  });

  it("fora-de-rodada sem citar a decisão também é recusado", () => {
    const { result, wrote } = run({ track: "fora-de-rodada", motivo: "decisao", reason: "falta escolher o caminho" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /decisão do editor/);
    assert.equal(wrote, false);
  });

  it("rotear para overnight consumindo a decisão segue livre", () => {
    const { result } = run({ track: "overnight", reason: RAZAO_0005_OVERNIGHT }, THREAD_12104.slice(0, 4), ["enhancement", "P3", "develop-track"]);
    assert.equal(result.ok, true, result.error);
  });

  it("develop citando a decisão e o que ainda falta passa", () => {
    const { result, calls } = run({ reason: "decisão do editor de 04/11 já registrada; a remoção ainda exige o Chrome logado do Neo" });
    assert.equal(result.ok, true, result.error);
    assert.ok(calls.some((c) => c[1] === "comment"));
  });

  it("--override-decision sobrepõe e grava motivo + decisão no comentário", () => {
    const { result, calls } = run({ overrideDecision: "editor reabriu a pergunta ao vivo" });
    assert.equal(result.ok, true, result.error);
    const comment = calls.find((c) => c[1] === "comment");
    const body = comment ? comment[comment.indexOf("--body") + 1] : "";
    assert.match(body, /Sobreposição da decisão do editor de 2026-11-04/);
    assert.match(body, /editor reabriu a pergunta ao vivo/);
  });

  it("--override-decision vazio é recusado; --force e --override-newer não dispensam o guard", () => {
    assert.equal(run({ overrideDecision: "  " }).result.ok, false);
    assert.match(run({ force: true }).result.error ?? "", /decisão do editor/);
    assert.match(run({ overrideNewer: "relido" }).result.error ?? "", /decisão do editor/);
  });

  it("decisão gravada por conta externa não segura o roteamento", () => {
    const thread = THREAD_12104.map((c) => (c.body === DECISAO_12104 ? { ...c, authorAssociation: "NONE" } : c));
    assert.equal(run({}, thread).result.ok, true);
  });

  it("issue sem decisão (caso #12078: guard de publicação) roteia para develop normalmente", () => {
    const thread = THREAD_12104.filter((c) => c.body !== DECISAO_12104);
    const { result } = run({ reason: "backfill de legendas é upload ao vivo no YouTube (guard de publicação proíbe executar)" }, thread);
    assert.equal(result.ok, true, result.error);
  });

  it("bloqueada depois da decisão (bloqueio de execução, #5373 item 5) não é afetada", () => {
    const { result } = run({ track: "bloqueada", reason: "roteada para overnight em 08/11 após a decisão; a remoção exige conta de terceiro" });
    assert.equal(result.ok, true, result.error);
  });

  it("CLI aceita --override-decision e recusa valor ausente", () => {
    const parsed = parseArgs(["--issue", "1", "--track", "develop", "--override-decision", "motivo"]);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.overrideDecision, "motivo");
    assert.ok("error" in parseArgs(["--issue", "1", "--track", "develop", "--override-decision"]));
  });
});

describe("#12389 — detectIgnoredDecision / reasonAcknowledgesDecision (puro)", () => {
  const decision = { decided_at: "2026-11-04T04:17:13.373Z", resposta: "Remover o modo text" };

  it("razões reais que citam a decisão são reconhecidas", () => {
    assert.equal(reasonAcknowledgesDecision(RAZAO_0005_OVERNIGHT), true);
    assert.equal(reasonAcknowledgesDecision(RAZAO_C3_OVERNIGHT), true);
    assert.equal(reasonAcknowledgesDecision("o editor decidiu remover; falta Chrome"), true);
    assert.equal(reasonAcknowledgesDecision("ver decisao-editor acima"), true);
  });

  it("'decisão de remover o modo' (pedir a decisão de novo) não conta como citação", () => {
    assert.equal(reasonAcknowledgesDecision(RAZAO_0208_DEVELOP), false);
    assert.equal(reasonAcknowledgesDecision(RAZAO_C4_DEVELOP), false);
  });

  it("só guarda develop e fora-de-rodada, e só com decisão", () => {
    assert.ok(detectIgnoredDecision({ track: "develop", reason: RAZAO_0208_DEVELOP, decision }));
    assert.ok(detectIgnoredDecision({ track: "fora-de-rodada", reason: "", decision }));
    for (const track of ["overnight", "bloqueada", "agendada", "epica"]) {
      assert.equal(detectIgnoredDecision({ track, reason: RAZAO_0208_DEVELOP, decision }), null, track);
    }
    assert.equal(detectIgnoredDecision({ track: "develop", reason: RAZAO_0208_DEVELOP, decision: null }), null);
  });
});
