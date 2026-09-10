#!/usr/bin/env npx tsx
/**
 * scripts/check-continuo-session-registration.ts (#7890)
 *
 * Verificação DETERMINÍSTICA (sem LLM) de que `session-registry.ts register
 * --kind continuo` de fato rodou pra cada tick recente do contínuo. Hoje
 * esse registro é um passo em PROSA no SKILL.md do contínuo (passo 1.3) —
 * depende do modelo executá-lo cedo o suficiente. Se o tick falhar cedo
 * (credencial, rede, etc.) o registro nunca acontece, e sem esta checagem
 * nada de fora percebe: foi exatamente o gap que causou a correlação errada
 * do detector de fabricação de conclusão (#7537) no #7641 —
 * `latest_continuo_session` pegou a sessão de OUTRO tick porque este não
 * tinha nenhuma, e ninguém sabia que faltava até investigar manualmente.
 *
 * Correlaciona as janelas de tempo dos sidecars de tick já capturados
 * (`data/continuo/tick-sidecars/`, #7814 — só sessões "encerradas" têm
 * sidecar, então esta checagem nunca alarma sobre um tick ainda rodando)
 * contra as janelas `[startedAt, lastHeartbeat]` das sessões `kind=continuo`
 * em `data/sessions/`. Ver `scripts/lib/continuo-session-registration-check.ts`
 * pro porquê os dois `sessionId` (bracket do Hermes vs. UUID do harness)
 * NUNCA são comparados por valor — só por sobreposição de janela.
 *
 * Uso (o consumidor real é `hermes/scripts/watch-continuo-health.sh`, via `--json`):
 *   npx tsx scripts/check-continuo-session-registration.ts --json
 *   npx tsx scripts/check-continuo-session-registration.ts \
 *     --sidecar-dir /path/to/tick-sidecars --sessions-dir /path/to/data/sessions \
 *     --now-iso 2026-09-10T06:00:00.000Z --json
 *
 * Exit code é SEMPRE 0 — mesma disciplina de `check-continuo-auth-stall.ts`:
 * este script só correlaciona e reporta `status`; quem decide alarmar (e
 * como) é quem chama, sem confundir "não consegui verificar" com "detectei
 * um gap".
 *
 * Deliberadamente NÃO registra sessão retroativamente nem re-executa nada
 * do tick — só torna o gap visível (item 2 da proposta da issue #7890,
 * escolhido sobre o item 1 — wrapper no cron do Hermes antes de invocar o
 * modelo — por ser puramente aditivo: não muda o contrato do protocolo do
 * tick nem o wrapper genérico `claude-delegate.sh`, reusado por outras
 * skills do Hermes além do contínuo. Ver corpo do PR pra justificativa
 * completa).
 *
 * @see hermes/scripts/watch-continuo-health.sh (o consumidor)
 * @see test/check-continuo-session-registration.test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  evaluateSessionRegistration,
  type RegisteredSessionWindow,
  type SessionRegistrationCheckResult,
  type TickWindow,
} from "./lib/continuo-session-registration-check.ts";

/** Repo root a partir deste arquivo (`scripts/` -> repo root). */
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
export const DEFAULT_SIDECAR_DIR = resolve(DIARIA_STUDIO_ROOT, "data", "continuo", "tick-sidecars");
export const DEFAULT_SESSIONS_DIR = resolve(DIARIA_STUDIO_ROOT, "data", "sessions");

/** Lê `data/continuo/tick-sidecars/*.json` e devolve as janelas de tick.
 *  Fail-soft por arquivo: um sidecar corrompido é ignorado (nunca derruba a
 *  checagem inteira por causa de 1 arquivo ruim) — mas fica registrado em
 *  `errors` pra quem chama decidir se isso é motivo de indeterminado. */
function readTickWindows(sidecarDir: string): { windows: TickWindow[]; errors: string[] } {
  const windows: TickWindow[] = [];
  const errors: string[] = [];
  if (!existsSync(sidecarDir)) return { windows, errors };
  let names: string[];
  try {
    names = readdirSync(sidecarDir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    return { windows, errors: [`falha ao listar ${sidecarDir}: ${(err as Error).message}`] };
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(sidecarDir, name), "utf8"));
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.firstAt === "string" &&
        typeof parsed.lastAt === "string" &&
        parsed.firstAt &&
        parsed.lastAt
      ) {
        windows.push({ sessionId: parsed.sessionId, firstAt: parsed.firstAt, lastAt: parsed.lastAt });
      } else {
        errors.push(`${name}: campos obrigatórios ausentes/inválidos`);
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { windows, errors };
}

/** Lê `data/sessions/*.json`, filtrando por `kind === "continuo"` LENDO O
 *  CAMPO, nunca por prefixo de nome de arquivo — `kind=continuo-review`
 *  (5º kind, `continuo-pr-review.sh`) também começa com `continuo-` no
 *  nome do arquivo (`{kind}-{machineTag}-{sessionId}.json`), então um glob
 *  por prefixo casaria as duas classes de sessão erroneamente. */
function readContinuoSessionWindows(sessionsDir: string): { windows: RegisteredSessionWindow[]; errors: string[] } {
  const windows: RegisteredSessionWindow[] = [];
  const errors: string[] = [];
  if (!existsSync(sessionsDir)) return { windows, errors };
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    return { windows, errors: [`falha ao listar ${sessionsDir}: ${(err as Error).message}`] };
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(sessionsDir, name), "utf8"));
      if (parsed.kind !== "continuo") continue;
      if (typeof parsed.sessionId === "string" && typeof parsed.startedAt === "string" && parsed.startedAt) {
        windows.push({
          sessionId: parsed.sessionId,
          startedAt: parsed.startedAt,
          lastHeartbeat: typeof parsed.lastHeartbeat === "string" ? parsed.lastHeartbeat : null,
        });
      }
      // Registro `kind=continuo` sem `sessionId`/`startedAt` legível é
      // silenciosamente ignorado (não é o achado que esta checagem procura
      // — outra checagem, `checkSessionsScanHealth`, já cobre registro
      // corrompido em geral).
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { windows, errors };
}

export interface SessionRegistrationCliResult extends SessionRegistrationCheckResult {
  readonly readErrors: readonly string[];
}

export function runCheck(
  sidecarDir: string,
  sessionsDir: string,
  nowIso: string,
  opts: { lookbackHours?: number; bufferMinutes?: number } = {},
): SessionRegistrationCliResult {
  const sidecarExisted = existsSync(sidecarDir);
  const sessionsExisted = existsSync(sessionsDir);
  const { windows: ticks, errors: tickErrors } = readTickWindows(sidecarDir);
  const { windows: sessions, errors: sessionErrors } = readContinuoSessionWindows(sessionsDir);
  const readErrors = [...tickErrors, ...sessionErrors];

  // Diretório de sidecars ausente: normal em checkout fresco/máquina sem
  // captura ainda (#7814 pode nunca ter rodado ali) — indeterminado, nunca
  // "ok" (não confirma nada) nem "alarm" (não há evidência de um tick
  // específico sem registro).
  if (!sidecarExisted) {
    return {
      status: "indeterminate",
      reason: `diretório de sidecars ausente (${sidecarDir}) — nada pra correlacionar ainda`,
      checkedTickCount: 0,
      unregisteredTicks: [],
      readErrors,
    };
  }
  // Sidecars existem mas `data/sessions/` não — não dá pra confirmar
  // AUSÊNCIA de registro sem saber se o diretório de sessões em si existe;
  // tratar como indeterminado em vez de alarmar sobre todo tick recente.
  if (!sessionsExisted) {
    return {
      status: "indeterminate",
      reason: `diretório de sessões ausente (${sessionsDir}) — não é possível confirmar registro`,
      checkedTickCount: 0,
      unregisteredTicks: [],
      readErrors,
    };
  }

  const result = evaluateSessionRegistration(ticks, sessions, nowIso, opts);
  return { ...result, readErrors };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const sidecarDir = values["sidecar-dir"] ?? DEFAULT_SIDECAR_DIR;
  const sessionsDir = values["sessions-dir"] ?? DEFAULT_SESSIONS_DIR;
  const nowIso = values["now-iso"] ?? new Date().toISOString();
  const lookbackHours = values["lookback-hours"] ? Number(values["lookback-hours"]) : undefined;
  const bufferMinutes = values["buffer-minutes"] ? Number(values["buffer-minutes"]) : undefined;
  const asJson = flags.has("json");

  const result = runCheck(sidecarDir, sessionsDir, nowIso, { lookbackHours, bufferMinutes });

  if (asJson) {
    console.log(JSON.stringify(result));
  } else {
    console.error(`[check-continuo-session-registration] status=${result.status} ${result.reason}`);
    if (result.readErrors.length > 0) {
      console.error(`[check-continuo-session-registration] erros de leitura: ${result.readErrors.join("; ")}`);
    }
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
