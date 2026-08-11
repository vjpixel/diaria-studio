#!/usr/bin/env node
/**
 * scripts/beehiiv-home-meta-check.ts (#4557)
 *
 * Smoke-test de runtime: bate `GET https://diar.ia.br/` (home pública — GET
 * simples, sem autenticação, sem API do Beehiiv, sem MCP — qualquer visitante
 * vê o mesmo HTML, isso NÃO é uma ação de publish/schedule/send) e verifica
 * os 3 eixos de drift da issue #4557: `og:title` sem a marca oficial (ou com
 * a grafia legada "Diar.ia"), self-links `href="http://diar.ia.br..."`
 * (deveria ser https), e rótulos residuais em inglês na UI do tema Beehiiv
 * ("Sign Up", "Login", "N min read"). Se algum eixo der drift, alarma o
 * editor por e-mail.
 *
 * Contexto: a issue #4557 original pede 3 mudanças de PAINEL Beehiiv e diz
 * explicitamente que não é código — é ação manual do editor no painel. O
 * único pedaço que ela autoriza em código é "um teste/guard que detecte
 * regressão de og:title" (generalizado aqui pros 3 eixos igualmente
 * checáveis a partir do HTML público). Sem este guard, uma regressão nesses
 * 3 eixos (ex: o tema Beehiiv resetar config num update, ou o editor mudar
 * algo sem perceber o efeito colateral) fica invisível — ninguém olha a home
 * pública todo dia.
 *
 * Ver `scripts/lib/beehiiv-home-meta-check.ts` pra decisão pura
 * (`evaluateHomeMetaDrift`) + extração de metadata + fingerprint/idempotência
 * do alarme.
 *
 * Uso:
 *   npx tsx scripts/beehiiv-home-meta-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/beehiiv-home-meta-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/beehiiv-home-meta-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário quando há drift pra
 * de fato enviar o e-mail; a checagem HTTP em si não precisa de credencial
 * nenhuma (GET público, sem auth). Não precisa do junction `data/` pra rodar
 * a checagem em si — só pra persistir o estado de idempotência
 * (`data/beehiiv-home-meta-check/state.json`).
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4740/#4750), o registro da task no Task Scheduler e a 1ª execução ao vivo
 * nunca rodaram nesta unidade (worktree isolado, sem `data/.credentials.json`
 * real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de
 * rede real nesta sessão, mesmo sendo GET público de leitura — ver PR body) —
 * validado só via testes com a lógica pura + fetch mockado (sem rede real).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { BEEHIIV_BASE_URL } from "./lib/edition-url.ts";
import {
  extractHomeMeta,
  evaluateHomeMetaDrift,
  hasHomeMetaDrift,
  computeHomeMetaFingerprint,
  shouldAlarmHomeMetaDrift,
  advanceHomeMetaAlarmState,
  emptyHomeMetaAlarmState,
  buildHomeMetaDriftAlarmEmail,
  type HomeMetaAlarmState,
} from "./lib/beehiiv-home-meta-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "beehiiv-home-meta-check", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[beehiiv-home-meta-check]";
const FETCH_TIMEOUT_MS = 15_000;
const HOME_URL = `${BEEHIIV_BASE_URL}/`;

// ─── Estado (idempotência) — mesmo padrão I/O de hub-drift-check.ts ────────

export function loadState(statePath: string = STATE_PATH): HomeMetaAlarmState {
  if (!existsSync(statePath)) return emptyHomeMetaAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<HomeMetaAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyHomeMetaAlarmState();
  }
}

export function saveState(state: HomeMetaAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Checagem HTTP (I/O, fail-soft) ────────────────────────────────────────

/**
 * Bate `GET url` e resolve pra `{ html, fetchError }` — NUNCA lança: uma
 * falha de rede (timeout, DNS, conexão recusada) ou HTTP não-2xx vira
 * `fetchError` preenchido em vez de propagar.
 */
export async function fetchHomeHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ html: string | null; fetchError: string | null }> {
  try {
    const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { html: null, fetchError: `HTTP ${res.status}` };
    return { html: await res.text(), fetchError: null };
  } catch (e) {
    return { html: null, fetchError: (e as Error).message };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  console.log(`${LOG_PREFIX} checando ${HOME_URL}`);

  const { html, fetchError } = await fetchHomeHtml(HOME_URL);
  if (fetchError || html === null) {
    // Fail-soft: falha de rede na checagem em si não é o drift que este
    // script existe pra detectar (é infra, não conteúdo) — loga e sai com
    // erro sem persistir/alarmar, mesma disciplina do restante do repo pra
    // falha de checagem inteira (ver docstring de hub-drift-check.ts §"por
    // que broken inclui tanto HTTP não-200 quanto erro de fetch" pro porquê
    // de NÃO tratar isso como "drift" propriamente dito).
    console.error(`${LOG_PREFIX} falha ao buscar ${HOME_URL}: ${fetchError}`);
    process.exitCode = 1;
    return;
  }

  const extract = extractHomeMeta(html);
  const findings = evaluateHomeMetaDrift(html, extract);

  if (findings.length === 0) {
    console.log(`${LOG_PREFIX} nenhum drift — og:title, self-links e rótulos EN estão limpos.`);
  } else {
    for (const f of findings) {
      console.log(`${LOG_PREFIX} [${f.check}] ${f.message}`);
    }
  }

  const state = loadState();
  const pending = hasHomeMetaDrift(findings);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  if (shouldAlarmHomeMetaDrift(state, findings)) {
    const { subject, body } = buildHomeMetaDriftAlarmEmail(findings, extract, HOME_URL);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Mesmo racional de hub-drift-check.ts/worker-drift-check.ts: sem
      // try/catch — se o envio falhar, o cursor abaixo não avança (aborta
      // antes do saveState), então a próxima execução tenta alarmar de novo
      // em vez de marcar este drift como "já avisado" sem o editor ter
      // recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente, ou o mesmo drift já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = pending ? computeHomeMetaFingerprint(findings) : null;
  saveState(advanceHomeMetaAlarmState(nextFingerprint, new Date()));
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de awaits de rede (fetchHomeHtml/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING no Windows documentado em worker-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
