/**
 * beehiiv-send-count.ts (#1419)
 *
 * Tracking de quantos test emails foram enviados nesta sessão pra
 * detectar rate-limit silencioso do Beehiiv (~10 sends/hora; sends
 * posteriores absorvidos sem feedback visual ou API error).
 *
 * Caso real 260520: 14 sends consecutivos; sends 11-14 não chegaram
 * ao Gmail mas Beehiiv UI mostrou popover de sucesso normal. Loop
 * verify→fix iterou sobre o último email recebido (do 10º send)
 * sem perceber que os subsequentes estavam stale.
 *
 * Counter persistido em `{edition_dir}/_internal/.beehiiv-send-count.json`
 * com estrutura:
 *   {
 *     "count": 7,
 *     "first_sent_at": "2026-05-19T18:47:00Z",
 *     "last_sent_at": "2026-05-19T21:35:00Z",
 *     "history": [{ ts, ok }]  // últimos 20
 *   }
 *
 * Warning thresholds:
 *   - Aos 6 sends: warn "rate limit em ~4 sends; aguarde se for re-enviar"
 *   - Aos 10 sends: bloqueia o próximo send em modo strict; warning forte
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface SendCountState {
  count: number;
  first_sent_at: string;
  last_sent_at: string;
  history: Array<{ ts: string; ok: boolean }>;
}

export const WARN_THRESHOLD = 6;
export const BLOCK_THRESHOLD = 10;
const HISTORY_LIMIT = 20;

export function getCountFilePath(editionDir: string): string {
  return resolve(editionDir, "_internal", ".beehiiv-send-count.json");
}

export function loadSendCount(editionDir: string): SendCountState | null {
  const path = getCountFilePath(editionDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<SendCountState>;
    if (typeof data.count !== "number") return null;
    return {
      count: data.count,
      first_sent_at: data.first_sent_at ?? new Date().toISOString(),
      last_sent_at: data.last_sent_at ?? new Date().toISOString(),
      history: Array.isArray(data.history) ? data.history : [],
    };
  } catch {
    return null;
  }
}

export function recordSend(
  editionDir: string,
  ok: boolean,
  now: () => Date = () => new Date(),
): SendCountState {
  const existing = loadSendCount(editionDir);
  const nowIso = now().toISOString();
  const state: SendCountState = existing
    ? {
        count: existing.count + 1,
        first_sent_at: existing.first_sent_at,
        last_sent_at: nowIso,
        history: [...existing.history, { ts: nowIso, ok }].slice(-HISTORY_LIMIT),
      }
    : {
        count: 1,
        first_sent_at: nowIso,
        last_sent_at: nowIso,
        history: [{ ts: nowIso, ok }],
      };
  const path = getCountFilePath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

export type WarnLevel = "ok" | "warn" | "block";

export interface WarnDecision {
  level: WarnLevel;
  message: string;
  count: number;
}

/**
 * Pure: decide nível de warning baseado em count atual + thresholds.
 * Caller (orchestrator) checa antes de invocar Send test email.
 *
 * Levels:
 *   - "ok"    (count < WARN_THRESHOLD): seguir normal
 *   - "warn"  (WARN_THRESHOLD <= count < BLOCK_THRESHOLD): warn editor
 *             que rate limit do Beehiiv está próximo (~10 sends/hora)
 *   - "block" (count >= BLOCK_THRESHOLD): bloquear send adicional
 *             até reset (1h após last_sent_at) ou override explícito
 */
export function decideWarnLevel(count: number): WarnDecision {
  if (count >= BLOCK_THRESHOLD) {
    return {
      level: "block",
      message:
        `Você enviou ${count} test emails nesta sessão. Beehiiv rate limit ` +
        `(~10 sends/hora) provavelmente alcançado — próximos sends podem ` +
        `não chegar ao Gmail silenciosamente. Aguarde 1h após o último ` +
        `send antes de continuar, OU validate visualmente no draft do Beehiiv ` +
        `e pule send adicional.`,
      count,
    };
  }
  if (count >= WARN_THRESHOLD) {
    return {
      level: "warn",
      message:
        `Você enviou ${count} test emails nesta sessão. Beehiiv pode começar a ` +
        `rate-limitar a partir de ~10/hora. Considere validar visualmente ` +
        `(draft preview) em vez de mais sends.`,
      count,
    };
  }
  return { level: "ok", message: "", count };
}

/**
 * Pure: verifica se a janela rolling de 1h passou desde o last_sent_at —
 * usado pra resetar counter naturalmente quando o rate limit do Beehiiv
 * já deve ter expirado.
 */
export function shouldResetWindow(
  lastSentIso: string,
  now: Date = new Date(),
  windowMs = 60 * 60 * 1000,
): boolean {
  const lastMs = Date.parse(lastSentIso);
  if (Number.isNaN(lastMs)) return true;
  return now.getTime() - lastMs > windowMs;
}
