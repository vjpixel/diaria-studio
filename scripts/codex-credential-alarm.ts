#!/usr/bin/env node
/**
 * scripts/codex-credential-alarm.ts (#7250)
 *
 * Alarme das contas OpenAI Codex do Hermes. Só I/O — toda a decisão é pura e
 * testada em `scripts/lib/codex-credential-pool.ts`. Mesmo molde de
 * `scripts/kit-doi-orphan-guard.ts` e `scripts/subscribe-redirect-drift-check.ts`.
 *
 * ─── O que este alarme resolve ──────────────────────────────────────────────
 *
 * As contas Codex são acessadas por **OAuth**, não por API key: não existe
 * endpoint de saldo. O único sinal possível é o resultado da última tentativa
 * de uso — e o Hermes já o persiste, por conta, em
 * `~/.hermes/auth.json` → `credential_pool["openai-codex"]`.
 *
 * **Consequência que fica no desenho:** sem uso, não há sinal. Se ninguém
 * delegar nada, as contas podem estar zeradas e este alarme não acusa. Ele
 * detecta "esgotado ao tentar usar", nunca "esgotado". É por isso que ele roda
 * agendado e não sob demanda: o tick do contínuo é o que produz o sinal.
 *
 * ─── Por que a urgência é maior do que parece ───────────────────────────────
 *
 * Medição de 03/09/2026 (a que motivou este script): 2 das 3 contas
 * `exhausted`, com reset em **29/09 e 02/10** — ~26 e ~29 dias. O limite é
 * MENSAL, não diário. Se a última esgotar, a delegação Codex fica fora por
 * semanas, e hoje nada avisa: o editor descobriria pela ausência de trabalho
 * entregue.
 *
 * ─── Onde roda ──────────────────────────────────────────────────────────────
 *
 * No `helios`, que é onde `~/.hermes/auth.json` existe e onde as tasks
 * agendadas do projeto rodam desde 11/08. `--auth-json` permite apontar para
 * outro caminho (teste, ou leitura de fora via cópia) — mas o caminho padrão
 * é o local, e o script NUNCA tenta SSH: se o arquivo não existe, ele diz
 * isso e sai, em vez de fingir que mediu.
 *
 * ─── O que este script NÃO faz, de propósito ────────────────────────────────
 *
 * Não recarrega conta, não troca plano, não rotaciona credencial, não escreve
 * em `auth.json`. Detecta e avisa; a ação é do editor. Escrever num arquivo
 * que guarda token OAuth de 3 contas é blast radius que um alarme não precisa
 * ter.
 *
 * Uso:
 *   npx tsx scripts/codex-credential-alarm.ts              # avalia + alarma se NOVO
 *   npx tsx scripts/codex-credential-alarm.ts --dry-run    # avalia + imprime, não alarma
 *   npx tsx scripts/codex-credential-alarm.ts --json       # saída programática
 *   npx tsx scripts/codex-credential-alarm.ts --auth-json /caminho/auth.json
 *   npx tsx scripts/codex-credential-alarm.ts --to editor@exemplo   # override do destinatário
 *
 * Exit codes: 0 sempre que a avaliação rodou (com ou sem alarme). 1 só em uso
 * inválido de CLI ou arquivo ilegível — falha de leitura NUNCA vira "está tudo
 * bem" em silêncio.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  evaluateCodexPool,
  computeCodexPoolFingerprint,
  buildCodexAlarmMessage,
  type CodexCredentialEntry,
  type CodexPoolVerdict,
} from "./lib/codex-credential-pool.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(REPO_ROOT, "data", "codex-credential-alarm", "state.json");
const DEFAULT_AUTH_JSON = join(homedir(), ".hermes", "auth.json");
const POOL_KEY = "openai-codex";

interface AlarmState {
  last_fingerprint: string | null;
  last_alarmed_at: string | null;
}

function emptyState(): AlarmState {
  return { last_fingerprint: null, last_alarmed_at: null };
}

function readState(path: string): AlarmState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      last_fingerprint: typeof parsed?.last_fingerprint === "string" ? parsed.last_fingerprint : null,
      last_alarmed_at: typeof parsed?.last_alarmed_at === "string" ? parsed.last_alarmed_at : null,
    };
  } catch {
    // Estado ilegível é tratado como ausente: o pior caso é um alarme
    // repetido, nunca um alarme suprimido.
    return emptyState();
  }
}

function writeState(path: string, state: AlarmState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Lê o pool do `auth.json`. Devolve `null` (nunca lista vazia) quando o
 * arquivo não existe, não parseia, ou não tem a chave — a distinção importa:
 * "não consegui ler" e "não há conta nenhuma" levariam a alarmes opostos.
 */
export function readCodexPool(authJsonPath: string): readonly CodexCredentialEntry[] | null {
  if (!existsSync(authJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authJsonPath, "utf8"));
  } catch {
    return null;
  }
  const pool = (parsed as { credential_pool?: Record<string, unknown> })?.credential_pool?.[POOL_KEY];
  if (!Array.isArray(pool)) return null;
  return pool as CodexCredentialEntry[];
}

function render(verdict: CodexPoolVerdict, nowIso: string): string {
  return buildCodexAlarmMessage(verdict, nowIso);
}

async function main(argv: string[]): Promise<number> {
  const dryRun = hasFlag(argv, "dry-run");
  const asJson = hasFlag(argv, "json");
  // `getArg` colapsa flag ausente em "" (não `undefined`), então `??` não
  // serve aqui — o fallback tem de ser sobre string vazia.
  const authPath = getArg(argv, "auth-json") || DEFAULT_AUTH_JSON;
  const nowIso = new Date().toISOString();

  const pool = readCodexPool(authPath);

  if (pool === null) {
    const msg =
      `[codex-credential-alarm] não foi possível ler o pool em ${authPath} ` +
      `(arquivo ausente, JSON inválido, ou sem credential_pool["${POOL_KEY}"]). ` +
      `Este script roda no helios, onde o arquivo existe — rodá-lo noutra máquina ` +
      `sem --auth-json não mede nada.`;
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "pool_unreadable", path: authPath })}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  const verdict = evaluateCodexPool(pool);
  const fingerprint = computeCodexPoolFingerprint(verdict);
  const state = readState(STATE_PATH);
  const isNew = fingerprint !== state.last_fingerprint;
  const willAlarm = verdict.shouldAlarm && isNew && !dryRun;

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        vivas: verdict.vivas,
        esgotadas: verdict.esgotadas,
        indeterminadas: verdict.indeterminadas,
        should_alarm: verdict.shouldAlarm,
        all_exhausted: verdict.allExhausted,
        fingerprint_changed: isNew,
        alarmed: willAlarm,
        contas: verdict.verdicts.map((v) => ({ label: v.label, state: v.state, resets_at: v.resetsAtIso })),
      })}\n`,
    );
  } else {
    process.stdout.write(`${render(verdict, nowIso)}\n`);
    if (!verdict.shouldAlarm) {
      process.stdout.write(`\n[codex-credential-alarm] acima do limiar — nada a alarmar.\n`);
    } else if (!isNew) {
      process.stdout.write(
        `\n[codex-credential-alarm] já alarmado para este mesmo estado em ${state.last_alarmed_at ?? "?"} — não repete.\n`,
      );
    } else if (dryRun) {
      process.stdout.write(`\n[codex-credential-alarm] --dry-run: não envia nem persiste.\n`);
    }
  }

  if (willAlarm) {
    // O envio reusa a mesma infraestrutura dos demais alarmes do projeto.
    // Import dinâmico para que --dry-run e --json não exijam credencial de
    // e-mail: medir nunca deve depender de poder enviar.
    const { sendGmailMessage } = await import("./lib/gmail-send.ts");
    const { resolveEditorEmail } = await import("./lib/inbox-stats.ts");
    const to = getArg(argv, "to") || resolveEditorEmail(join(REPO_ROOT, "platform.config.json"));
    const assunto = verdict.allExhausted
      ? "[diar.ia.br] TODAS as contas Codex esgotadas — delegação parada"
      : `[diar.ia.br] resta ${verdict.vivas} conta Codex viva de ${verdict.verdicts.length}`;
    await sendGmailMessage(to, assunto, render(verdict, nowIso));
    writeState(STATE_PATH, { last_fingerprint: fingerprint, last_alarmed_at: nowIso });
    if (!asJson) process.stdout.write(`\n[codex-credential-alarm] alarme enviado para ${to}.\n`);
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Erro não-tratado nunca pode sair como sucesso silencioso: este alarme
      // existe exatamente para tornar visível um estado que ninguém observa.
      process.stderr.write(`[codex-credential-alarm] erro não-tratado: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
