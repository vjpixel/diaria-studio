/**
 * scripts/check-decision-state-drift.ts (#10105)
 *
 * CLI fino sobre `scripts/lib/decision-state-drift.ts`: cruza a decisão
 * vigente do editor (marcador `decisao-editor` com `estado_esperado`) com o
 * toggle real em `data/*-enabled.json`.
 *
 * Uso:
 *   npx tsx scripts/check-decision-state-drift.ts                 # issues abertas
 *   npx tsx scripts/check-decision-state-drift.ts --issues 8099,10105
 *   npx tsx scripts/check-decision-state-drift.ts --json
 *     exit 0 = nenhuma divergência; 1 = há divergência; 2 = não deu pra
 *     conferir (gh falhou / argumento inválido).
 *
 *   npx tsx scripts/check-decision-state-drift.ts --print-marker \
 *     --pergunta "Religar a rampa?" --resposta "Ainda não — mantém pausada" \
 *     --sessao develop --toggle clarice-envio-enabled --enabled false
 *     → imprime o marcador `<!-- decisao-editor: ... -->` com `estado_esperado`,
 *       pronto pra prefixar o comentário de decisão.
 */
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkDecisionStates,
  driftsOf,
  fetchIssuesWithTrustedComments,
  fetchOpenIssuesWithTrustedComments,
  formatDriftReportLines,
  productionToggleReader,
} from "./lib/decision-state-drift.ts";
import {
  formatDecisionMarker,
  VERIFIABLE_TOGGLES,
  type IssueDecision,
  type SessionKind,
  type VerifiableToggle,
} from "./lib/issue-decisions.ts";

export type DriftCliCommand =
  | { kind: "check"; issues: number[] | null; json: boolean }
  | { kind: "marker"; decision: IssueDecision }
  | { kind: "error"; message: string };

const SESSOES: readonly SessionKind[] = ["continuo", "overnight", "develop", "interactive"];

export function parseDriftCli(argv: string[], now: () => Date = () => new Date()): DriftCliCommand {
  const { flags, values } = parseArgs(argv);
  if (flags.has("print-marker")) {
    const pergunta = values.pergunta;
    const resposta = values.resposta;
    const sessao = values.sessao as SessionKind | undefined;
    const toggle = values.toggle;
    const enabledRaw = values.enabled;
    if (!pergunta || !resposta) return { kind: "error", message: "--print-marker exige --pergunta e --resposta" };
    if (!sessao || !SESSOES.includes(sessao)) {
      return { kind: "error", message: `--sessao precisa ser um de ${SESSOES.join(", ")}` };
    }
    if (!toggle || !(VERIFIABLE_TOGGLES as readonly string[]).includes(toggle)) {
      return { kind: "error", message: `--toggle precisa ser um de ${VERIFIABLE_TOGGLES.join(", ")}` };
    }
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      return { kind: "error", message: "--enabled precisa ser true ou false" };
    }
    return {
      kind: "marker",
      decision: {
        decided_at: now().toISOString(),
        pergunta,
        resposta,
        sessao,
        estado_esperado: { toggle: toggle as VerifiableToggle, enabled: enabledRaw === "true" },
      },
    };
  }
  let issues: number[] | null = null;
  if (values.issues !== undefined) {
    issues = values.issues.split(",").map((s) => Number(s.trim()));
    if (issues.length === 0 || issues.some((n) => !Number.isInteger(n) || n <= 0)) {
      return { kind: "error", message: `--issues inválido: ${values.issues}` };
    }
  } else if (flags.has("issues")) {
    return { kind: "error", message: "--issues exige lista N,M" };
  }
  return { kind: "check", issues, json: flags.has("json") };
}

function main(): void {
  const cmd = parseDriftCli(process.argv.slice(2));
  if (cmd.kind === "error") {
    console.error(cmd.message);
    process.exitCode = 2;
    return;
  }
  if (cmd.kind === "marker") {
    console.log(formatDecisionMarker(cmd.decision));
    return;
  }
  const cwd = process.cwd();
  const fetched = cmd.issues ? fetchIssuesWithTrustedComments(cmd.issues, cwd) : fetchOpenIssuesWithTrustedComments(cwd);
  if (!fetched.ok) {
    console.error(`não deu pra conferir: ${fetched.error}`);
    process.exitCode = 2;
    return;
  }
  const checks = checkDecisionStates(fetched.issues, productionToggleReader(cwd));
  const drifts = driftsOf(checks);
  if (cmd.json) {
    console.log(JSON.stringify({ checked: checks.length, drifts: drifts.length, checks }, null, 2));
  } else if (checks.length === 0) {
    console.log("nenhuma decisão vigente com estado_esperado nas issues lidas.");
  } else {
    for (const c of checks.filter((x) => x.ok)) {
      console.log(`ok  #${c.issue}: ${c.toggle} ${c.actualEnabled ? "enabled" : "disabled"}, como a decisão de ${c.decision.decided_at} manda.`);
    }
    for (const line of formatDriftReportLines(checks)) console.log(line);
  }
  process.exitCode = drifts.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) main();
