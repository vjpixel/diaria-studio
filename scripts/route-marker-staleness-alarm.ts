#!/usr/bin/env node
/**
 * scripts/route-marker-staleness-alarm.ts (#7270 Parte 2, #7288 Parte B)
 *
 * Task semanal (Parte 2 do #7270 + Parte B do #7288 — mesmo alarme, ver
 * docblock de `scripts/lib/route-marker-staleness.ts` pro porquê de ser um
 * só): lista TODAS as issues abertas via `gh issue list`, avalia cada uma
 * contra as 5 categorias de achado do módulo puro, e envia 1 e-mail-digest
 * ao editor quando há pelo menos 1 achado. **Nunca remove label, nunca
 * reroteia** — só avisa, mesma disciplina de `on-hold-vencimento-alarm.ts`
 * (#5317): "revisar é decisão de quem tem contexto".
 *
 * Uso:
 *   npx tsx scripts/route-marker-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/route-marker-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia e-mail
 *   npx tsx scripts/route-marker-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Sem estado/idempotência persistente — mesmo racional de
 * `on-hold-vencimento-alarm.ts`: um achado pendente continua pendente até
 * o editor agir, e suprimir o reenvio reintroduziria "só sai da geladeira
 * se alguém lembrar do 1º e-mail".
 *
 * Env: `gh` autenticado + `data/.credentials.json` com `gmail.send` (só
 * necessário pra ENVIAR).
 *
 * @see scripts/lib/route-marker-staleness.ts (lógica pura)
 * @see scripts/on-hold-vencimento-alarm.ts (mesmo padrão de CLI/e-mail)
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import {
  findRouteMarkerStaleness,
  type RouteMarkerFinding,
  type RouteMarkerStalenessConsultor,
  type RouteMarkerStalenessIssueInput,
  type IssueLookupState,
} from "./lib/route-marker-staleness.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[route-marker-staleness-alarm]";

interface GhIssueListEntry {
  number: number;
  labels?: Array<{ name?: string }>;
  body: string | null;
  state?: string;
  comments?: Array<{ body?: string }>;
  url?: string;
  title?: string;
}

interface FetchedIssue extends RouteMarkerStalenessIssueInput {
  url: string;
  title: string;
}

/** Lista TODAS as issues abertas (labels/body/state/comments/url/title) via
 * `gh issue list`. `null` em falha do `gh` — caller nunca inventa achado a
 * partir de um `gh` que não respondeu. */
export function listOpenIssuesForStaleness(cwd: string = ROOT): FetchedIssue[] | null {
  const res = spawnGhSync(
    ["issue", "list", "--state", "open", "--json", "number,labels,body,state,comments,url,title", "--limit", "300"],
    cwd,
  );
  if (res.status !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as GhIssueListEntry[];
    return entries.map((e) => ({
      number: e.number,
      labels: (e.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0),
      body: e.body ?? "",
      state: (e.state ?? "OPEN").toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
      comments: (e.comments ?? []).map((c) => c.body ?? ""),
      url: e.url ?? "",
      title: e.title ?? "",
    }));
  } catch {
    return null;
  }
}

/** Consultor real — memoiza `gh issue view --json state` por issue (várias
 * categorias podem consultar a MESMA issue citada — ex: 2 issues `agendada`
 * citando a mesma dependência já fechada). Fail-soft: qualquer falha vira
 * `"UNKNOWN"`, nunca lança. */
function buildRealConsultor(cwd: string): RouteMarkerStalenessConsultor {
  const cache = new Map<number, IssueLookupState>();
  return {
    getIssueState(issueNumber: number): IssueLookupState {
      const cached = cache.get(issueNumber);
      if (cached) return cached;
      const res = spawnGhSync(["issue", "view", String(issueNumber), "--json", "state"], cwd);
      let value: IssueLookupState = "UNKNOWN";
      if (res.status === 0 && res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout) as { state?: string };
          const state = (parsed.state ?? "").toUpperCase();
          if (state === "OPEN" || state === "CLOSED") value = state;
        } catch {
          value = "UNKNOWN";
        }
      }
      cache.set(issueNumber, value);
      return value;
    },
  };
}

const CATEGORY_LABEL: Record<RouteMarkerFinding["category"], string> = {
  "bloqueada-sem-marcador": "bloqueada SEM marcador bloqueio-execucao (#7270)",
  "bloqueada-depends-on-fechada": "bloqueada por dependência já fechada — reconcile-issue-dependencies.ts está atrasado?",
  "bloqueada-externa-sem-atualizacao": "bloqueada por condição externa sem atualização recente",
  "agendada-motivo-cita-issue-fechada": "agendada cuja razão cita issue já fechada (#7288)",
  "agendada-renovada-multiplas-vezes": "agendada renovada múltiplas vezes — provável estacionamento (#7288)",
};

/** Pure: monta assunto + corpo do e-mail-digest. Exportado pra teste. */
export function buildRouteMarkerStalenessEmail(
  findings: readonly RouteMarkerFinding[],
  issuesByNumber: ReadonlyMap<number, { url: string; title: string }>,
): { subject: string; body: string } {
  const subject = `⚠️ ${findings.length} issue(ns) com marcador de roteamento desatualizado`;
  const lines: string[] = [
    "As issues abaixo têm um marcador de bloqueio/agendamento (route-issue.ts)",
    "que precisa de revisão — o alarme só REPORTA, nunca remove label nem",
    "reroteia sozinho (#7270/#7288). Decidir o que fazer é sempre do editor.",
    "",
  ];
  for (const f of findings) {
    const meta = issuesByNumber.get(f.number);
    lines.push(`#${f.number}${meta?.title ? ` — ${meta.title}` : ""} (${CATEGORY_LABEL[f.category]})`);
    lines.push(`  ${f.detail}`);
    if (meta?.url) lines.push(`  ${meta.url}`);
  }
  return { subject, body: lines.join("\n") };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const issues = listOpenIssuesForStaleness();
  if (issues === null) {
    console.error(`${LOG_PREFIX} 'gh issue list' falhou — não avalia, não alarma. Checar 'gh auth status'.`);
    process.exit(1);
  }

  const consultor = buildRealConsultor(ROOT);
  const now = new Date();
  const findings = findRouteMarkerStaleness(issues, consultor, now);
  console.log(`${LOG_PREFIX} issues abertas: ${issues.length}, achados: ${findings.length}`);

  if (findings.length === 0) {
    console.log(`${LOG_PREFIX} nenhum achado — todos os marcadores de roteamento estão em dia.`);
    return;
  }

  const issuesByNumber = new Map(issues.map((i) => [i.number, { url: i.url, title: i.title }]));
  const { subject, body } = buildRouteMarkerStalenessEmail(findings, issuesByNumber);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (${findings.length} achado(s)).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
