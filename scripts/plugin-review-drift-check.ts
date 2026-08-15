#!/usr/bin/env node
/**
 * scripts/plugin-review-drift-check.ts (#5311)
 *
 * Smoke-test de runtime: lê os system prompts dos 5 agentes do plugin
 * `pr-review-toolkit` que `.claude/hooks/pr-create-review.mjs` (`DEFAULT_EFFORT
 * = "max"`) dispara — `code-reviewer`, `silent-failure-hunter`,
 * `pr-test-analyzer`, `comment-analyzer`, `type-design-analyzer` — e alarma
 * o editor se a linguagem de filtro de confiança/severidade de algum deles
 * mudar de forma relevante. Decisão do editor (14/08/2026, sessão de
 * desbloqueio pré-overnight, #5311):
 *
 *   "Implementar um smoke-test que falhe quando
 *   ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/
 *   pr-review-toolkit/agents/code-reviewer.md mudar de forma relevante —
 *   mesmo padrão de Diaria-Worker-Drift-Check/Diaria-Hub-Drift-Check. Hoje
 *   o arquivo é per-máquina, versionado pelo marketplace, e ninguém saberia
 *   se ele mudasse."
 *
 * O arquivo do plugin NÃO é versionado neste repo (`~/.claude/plugins/`,
 * fora do checkout) — por isso este check é um alarme AGENDADO (mesmo
 * padrão de worker-drift-check.ts/hub-drift-check.ts), não um teste de CI:
 * o runner de CI nunca tem o plugin instalado, então um teste de CI
 * sempre pularia (skip perpétuo, sem valor). Rodando localmente/no servidor
 * onde o plugin de fato está instalado, este script é o que detecta drift.
 *
 * Ver `scripts/lib/plugin-review-drift-check.ts` pra decisão pura
 * (`extractRelevantSignal`/`evaluateAgentDrift`) — só a linguagem de filtro
 * de confiança/severidade entra no fingerprint, não o arquivo inteiro (edição
 * cosmética do marketplace não deveria alarmar).
 *
 * Uso:
 *   npx tsx scripts/plugin-review-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/plugin-review-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/plugin-review-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Plugin ausente (sessão cloud, clone fresco) — skip, NUNCA falha: o hook
 * `pr-create-review.mjs` já cai no `general-purpose` com rubrico inline
 * nesse caso (comportamento correto documentado no CLAUDE.md, seção "Effort
 * do review automatizado") — este check não deveria alarmar sobre uma
 * ausência que já tem fallback tratado.
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * quando há drift pra de fato enviar o e-mail; a leitura do arquivo em si
 * não precisa de credencial nenhuma (leitura local de disco).
 *
 * Estado (idempotência + baseline por agente): `data/plugin-review-drift-check/state.json`.
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4750), o registro da task no Task Scheduler e a 1ª execução ao vivo nunca
 * rodaram nesta unidade (worktree isolado) — validado só via testes com a
 * lógica pura + arquivos de fixture (sem depender do plugin real instalado
 * na máquina de CI).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  PLUGIN_REVIEW_AGENTS,
  evaluateAllAgentsDrift,
  hasPendingPluginReviewDrift,
  shouldAlarmPluginReviewDrift,
  advancePluginReviewDriftState,
  buildPluginReviewDriftAlarmEmail,
  emptyPluginReviewDriftState,
  type PluginReviewDriftState,
} from "./lib/plugin-review-drift-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "plugin-review-drift-check", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[plugin-review-drift-check]";

/** Path do diretório de agentes do plugin — per-máquina, fora do repo. Não
 * é constante hardcoded fora de função pra permitir override em teste
 * (`agentsDirFn`). */
export function pluginAgentsDir(home: string = homedir()): string {
  return join(home, ".claude", "plugins", "marketplaces", "claude-plugins-official", "plugins", "pr-review-toolkit", "agents");
}

// ─── Estado (idempotência + baseline) ──────────────────────────────────────

export function loadState(statePath: string = STATE_PATH): PluginReviewDriftState {
  if (!existsSync(statePath)) return emptyPluginReviewDriftState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PluginReviewDriftState>;
    if (!raw || typeof raw !== "object" || !raw.agents || typeof raw.agents !== "object") {
      return emptyPluginReviewDriftState();
    }
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    return { agents: raw.agents as PluginReviewDriftState["agents"], lastAlarmedFingerprint: fingerprint ?? null };
  } catch {
    return emptyPluginReviewDriftState();
  }
}

export function saveState(state: PluginReviewDriftState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const agentsDir = pluginAgentsDir();
  if (!existsSync(agentsDir)) {
    console.log(
      `${LOG_PREFIX} plugin pr-review-toolkit ausente (${agentsDir} não existe) — skip, sem alarme. ` +
        "Sessão cloud/clone fresco: o hook já cai no general-purpose com rubrico inline nesse caso.",
    );
    return;
  }

  const contents = new Map<string, string | null>();
  for (const agent of PLUGIN_REVIEW_AGENTS) {
    const filePath = join(agentsDir, agent.fileName);
    contents.set(agent.agentName, existsSync(filePath) ? readFileSync(filePath, "utf8") : null);
  }

  const state = loadState();
  const results = evaluateAllAgentsDrift(PLUGIN_REVIEW_AGENTS, contents, state);

  for (const r of results) {
    console.log(`${LOG_PREFIX} pr-review-toolkit:${r.agentName}: ${r.status}`);
  }

  const missingFiles = results.filter((r) => r.status === "missing_file");
  if (missingFiles.length > 0) {
    console.error(
      `${LOG_PREFIX} aviso: ${missingFiles.length} agente(s) sem arquivo no marketplace (reestruturação?): ` +
        missingFiles.map((r) => r.agentName).join(", "),
    );
  }

  const pending = hasPendingPluginReviewDrift(results);
  console.log(`${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"}.`);

  if (shouldAlarmPluginReviewDrift(state, results)) {
    const { subject, body } = buildPluginReviewDriftAlarmEmail(results);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Mesmo racional de worker-drift-check.ts/hub-drift-check.ts: sem
      // try/catch — se o envio falhar, o cursor abaixo não avança (o save
      // fica condicionado a isDryRun logo adiante), então a próxima
      // execução tenta alarmar de novo.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente, ou o mesmo drift já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO persistido.`);
    return;
  }

  saveState(advancePluginReviewDriftState(state, results, new Date()));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
