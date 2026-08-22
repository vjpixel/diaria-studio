#!/usr/bin/env node
/**
 * scripts/on-hold-vencimento-alarm.ts (#5317)
 *
 * Task semanal: lista as issues abertas com label `on-hold` via `gh issue
 * list`, avalia cada uma contra a linha `Vencimento: AAAA-MM-DD` do corpo
 * (`scripts/lib/on-hold-vencimento-alarm.ts` — lógica pura), e envia 1
 * e-mail-digest ao editor quando há pelo menos 1 achado (vencida, sem data
 * declarada, ou sem a linha `Vencimento:` de propósito). **NUNCA remove a
 * label on-hold** — só avisa; decidir se a issue volta pra fila é sempre
 * ação do editor.
 *
 * Sem estado/idempotência persistente — o alarme re-envia o digest completo
 * toda vez que a task roda e há achados pendentes (ver docstring do módulo
 * puro pro porquê disso ser o comportamento CORRETO aqui, não um bug).
 *
 * Uso:
 *   npx tsx scripts/on-hold-vencimento-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/on-hold-vencimento-alarm.ts --dry-run      # avalia + imprime, NÃO envia e-mail
 *   npx tsx scripts/on-hold-vencimento-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `gh` autenticado (mesmo requisito de `alarm-issues.ts`/`check-pr-bugfix.ts`)
 * + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos
 * outros alarmes locais deste repo) — só necessário pra ENVIAR; a checagem
 * em si não precisa de credencial nenhuma além do `gh`.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import {
  evaluateOnHoldIssues,
  shouldSendOnHoldVencimentoAlarm,
  buildOnHoldVencimentoAlarmEmail,
  type OnHoldIssueInput,
} from "./lib/on-hold-vencimento-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[on-hold-vencimento-alarm]";

interface GhIssueListEntry {
  number: number;
  title: string;
  url: string;
  body: string | null;
}

/** Lista issues abertas com label `on-hold` via `gh issue list`. `null` em
 * falha do `gh` (não autenticado, offline, rate limit) — caller decide como
 * tratar (fail-fast, este script nunca inventa achados a partir de um `gh`
 * que não respondeu). */
export function listOpenOnHoldIssues(cwd: string = ROOT): OnHoldIssueInput[] | null {
  const res = spawnGhSync(
    ["issue", "list", "--label", "on-hold", "--state", "open", "--json", "number,title,body,url", "--limit", "100"],
    cwd,
  );
  if (res.status !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as GhIssueListEntry[];
    return entries.map((e) => ({ number: e.number, title: e.title, url: e.url, body: e.body ?? "" }));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const issues = listOpenOnHoldIssues();
  if (issues === null) {
    console.error(`${LOG_PREFIX} 'gh issue list' falhou — não avalia, não alarma. Checar 'gh auth status'.`);
    process.exit(1);
  }

  const now = new Date();
  const findings = evaluateOnHoldIssues(issues, now);
  console.log(`${LOG_PREFIX} on-hold abertas: ${issues.length}, achados: ${findings.length}`);

  if (!shouldSendOnHoldVencimentoAlarm(findings)) {
    console.log(`${LOG_PREFIX} nenhum achado — todas as on-hold têm vencimento futuro declarado.`);
    return;
  }

  const { subject, body } = buildOnHoldVencimentoAlarmEmail(findings);
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
