/**
 * clarice-envio-lock.ts (#5026)
 *
 * Trava de concorrência do envio Clarice — impede que a task diária das
 * 19:00, o guard das 05:00, e uma invocação MANUAL da skill (que passou a
 * delegar pro mesmo `clarice-envio-run.ts`, ver #5027) montem a MESMA onda ao
 * mesmo tempo. O risco real: `appendSentOrQueuedEmails`
 * (`scripts/clarice-build-segment.ts`) faz read-modify-write sem lock nem
 * escrita atômica — duas invocações concorrentes sobre o mesmo ciclo já
 * deixaram 52 de 1.963 contatos escaparem do dedup num incidente real
 * (#4765). Numa automação diária isso vira risco permanente, não um acidente
 * pontual — daí a trava dedicada.
 *
 * NÃO reusa `scripts/lib/file-lock.ts` (`acquireLock`/`releaseLock`) direto:
 * aquele helper é pra seções críticas CURTAS (read-modify-write de um
 * arquivo, timeout default 10s com spin-wait). Uma rodada de
 * `clarice-envio-run.ts` faz VÁRIAS chamadas de rede sequenciais
 * (dashboard, MV sob demanda, Brevo × até 3 células) que legitimamente
 * levam minutos — segurar esse lock com spin-wait de 50ms por toda a
 * rodada queimaria CPU à toa. **Achado do comment-analyzer no review da PR:
 * este módulo NÃO cobre retry automático de 429 da Brevo** — `step()` em
 * `clarice-envio-run.ts` chama `deps.exec()` uma única vez e lança
 * `EnvioAbort` de imediato se o exit code não bater; os ~32min de espera
 * que o SKILL.md documenta são um humano re-rodando o comando manualmente
 * no fluxo antigo, não algo que a rodada atual retenta sozinha segurando
 * este lock. Este módulo é uma trava de ESCOPO LARGO com detecção de
 * abandono (lock "stale" — processo morreu sem liberar), não uma seção
 * crítica.
 *
 * Formato do lock: `data/clarice-subscribers/{cycle}/.envio-run.lock`, JSON
 * `{ pid, host, startedAt, label }`. Criação exclusiva (`wx`, mesmo primitivo
 * atômico de `file-lock.ts`) garante que só 1 caller cria o arquivo — os
 * demais recebem `LockHeldError` (mensagem já pronta pro relatório da
 * rodada, nunca uma exceção genérica).
 */
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./cli-args.ts";

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly label: string;
}

/** Rodada normal (rede + montagem de onda) não deveria passar disso. Acima => provável processo morto sem liberar. */
export const STALE_LOCK_MS = 30 * 60 * 1000;

export class LockHeldError extends Error {
  constructor(readonly info: LockInfo, readonly lockPath: string) {
    super(
      `[clarice-envio-lock] ${lockPath} já está travado por "${info.label}" ` +
        `(pid ${info.pid} em ${info.host}, desde ${info.startedAt}) — ` +
        `provável sessão manual ou rodada concorrente em curso. Abortando sem tocar Brevo.`,
    );
    this.name = "LockHeldError";
  }
}

export function lockPathForCycle(rootDir: string, cycle: string): string {
  return resolve(rootDir, "data", "clarice-subscribers", cycle, ".envio-run.lock");
}

/** Lê o lock existente (ou `null` se ausente/ilegível — ilegível é tratado como "sem lock", nunca lança). */
function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      raw && typeof raw === "object" &&
      typeof raw.pid === "number" && typeof raw.host === "string" &&
      typeof raw.startedAt === "string" && typeof raw.label === "string"
    ) {
      return raw as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** `true` quando o lock existente é mais velho que `STALE_LOCK_MS` (ou ilegível — trata como abandonado). */
export function isLockStale(lockPath: string, now: Date, staleMs: number = STALE_LOCK_MS): boolean {
  const info = readLockInfo(lockPath);
  if (!info) return true; // ilegível/corrompido — melhor tratar como abandonado que travar pra sempre.
  const startedMs = Date.parse(info.startedAt);
  if (!Number.isFinite(startedMs)) return true;
  return now.getTime() - startedMs > staleMs;
}

/**
 * Adquire o lock desta invocação — cria o arquivo atomicamente (`wx`).
 * Se já existir e estiver STALE (`isLockStale`), remove e tenta de novo (o
 * dono anterior morreu sem liberar). Se existir e estiver FRESCO, lança
 * `LockHeldError` — nunca espera, nunca faz spin-wait (a rodada inteira dura
 * minutos; esperar aqui só atrasaria o relatório de "já está rodando").
 *
 * Devolve o `lockPath` — o caller é responsável por `releaseEnvioLock` no
 * `finally`, sempre, inclusive nos caminhos de erro.
 */
export function acquireEnvioLock(rootDir: string, cycle: string, label: string, now: Date): string {
  const lockPath = lockPathForCycle(rootDir, cycle);
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    if (isLockStale(lockPath, now)) {
      try { unlinkSync(lockPath); } catch { /* corrida com outro processo removendo — segue tentando criar abaixo */ }
    } else {
      const info = readLockInfo(lockPath);
      throw new LockHeldError(
        info ?? { pid: -1, host: "?", startedAt: "?", label: "(lock ilegível)" },
        lockPath,
      );
    }
  }

  const payload: LockInfo = { pid: process.pid, host: hostname(), startedAt: now.toISOString(), label };
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify(payload, null, 2) + "\n");
    closeSync(fd);
  } catch (e) {
    // Corrida genuína: outro processo criou o lock entre o existsSync acima e
    // este openSync. Não tenta de novo (evita loop infinito de corrida) —
    // trata como held, mesma mensagem que o caso "detectado antes".
    const info = readLockInfo(lockPath);
    throw new LockHeldError(
      info ?? { pid: -1, host: "?", startedAt: now.toISOString(), label: "(corrida na criação do lock)" },
      lockPath,
    );
  }
  return lockPath;
}

/** Libera o lock — fail-soft (arquivo já sumido não é erro, ver `file-lock.ts` pro mesmo padrão). */
export function releaseEnvioLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * Comando `--break` (#5832) — destrava um lock ABANDONADO sem esperar
 * `STALE_LOCK_MS` (30min) nem apagar o arquivo à mão sem confirmação.
 *
 * Recuperação hoje: (1) esperar o timeout de stale, ou (2) `rm` manual do
 * lockfile — sem tooling nem prova de que o processo dono morreu mesmo.
 * Este comando fecha a lacuna: só remove o arquivo depois de confirmar,
 * via checagem de PID vivo, que o processo que criou o lock não está mais
 * rodando — e SÓ quando o lock é deste mesmo host (checagem de PID entre
 * hosts não é confiável: o mesmo número pode estar em uso por outro
 * processo em outra máquina).
 */

/** Resultado de uma tentativa de `--break` — impresso como JSON em stdout por `main()`. */
export interface BreakLockResult {
  /** `true` só quando o lock foi de fato removido nesta chamada. */
  readonly broken: boolean;
  /** Motivo legível — sempre presente, inclusive em sucesso (auditoria/log). */
  readonly reason: string;
  readonly lockPath: string;
  /** `null` quando não havia lock pra quebrar (já não existia). */
  readonly lockInfo: LockInfo | null;
  readonly checkedAt: string;
}

/**
 * `true` se o processo `pid` ainda está rodando NESTE host — via
 * `process.kill(pid, 0)` (sinal 0 não mata nada, só testa existência/
 * permissão; lança `ESRCH` se o PID não existe). Qualquer erro que não seja
 * "processo inexistente" (ex: `EPERM` — existe mas é de outro usuário) é
 * tratado como "ainda vivo": mais seguro recusar destravar do que assumir
 * morto por engano.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH";
  }
}

/**
 * Tenta destravar o lock do ciclo. Puro o suficiente pra testar: recebe
 * `checkPidAlive` injetável (default `isPidAlive`) e `currentHost` (default
 * `hostname()`) — os testes fixam ambos pra simular processo vivo/morto e
 * host local/remoto sem depender de PIDs reais do SO.
 *
 * Regras (nesta ordem):
 * 1. Sem lock no path → nada a fazer, `broken: false`.
 * 2. Lock de OUTRO host → nunca destrava (checagem de PID só vale no mesmo
 *    host) — avisa e recusa.
 * 3. Lock deste host, processo ainda vivo → recusa (rodada genuína em curso).
 * 4. Lock deste host, processo morto → remove e loga quem/quando destravou.
 */
export function breakEnvioLock(
  rootDir: string,
  cycle: string,
  now: Date,
  opts: { checkPidAlive?: (pid: number) => boolean; currentHost?: string } = {},
): BreakLockResult {
  const checkPidAlive = opts.checkPidAlive ?? isPidAlive;
  const currentHost = opts.currentHost ?? hostname();
  const lockPath = lockPathForCycle(rootDir, cycle);
  const checkedAt = now.toISOString();

  const info = readLockInfo(lockPath);
  if (!info) {
    return {
      broken: false,
      reason: existsSync(lockPath)
        ? `${lockPath} existe mas está ilegível/corrompido — não é seguro assumir dono morto sem dados do lock. Recuperação: esperar STALE_LOCK_MS ou inspecionar manualmente.`
        : `${lockPath} não existe — nada a destravar.`,
      lockPath,
      lockInfo: null,
      checkedAt,
    };
  }

  if (info.host !== currentHost) {
    return {
      broken: false,
      reason:
        `Lock pertence ao host "${info.host}" (pid ${info.pid}, label "${info.label}", desde ${info.startedAt}) — ` +
        `esta checagem roda em "${currentHost}". Checagem de PID vivo só é confiável no MESMO host — rode ` +
        `\`--break --cycle ${cycle}\` a partir de "${info.host}" pra confirmar de verdade, ou espere STALE_LOCK_MS.`,
      lockPath,
      lockInfo: info,
      checkedAt,
    };
  }

  if (checkPidAlive(info.pid)) {
    return {
      broken: false,
      reason:
        `Processo dono (pid ${info.pid}, label "${info.label}", desde ${info.startedAt}) ainda está rodando em ` +
        `"${currentHost}" — recusando destravar uma rodada genuinamente em andamento.`,
      lockPath,
      lockInfo: info,
      checkedAt,
    };
  }

  releaseEnvioLock(lockPath);
  return {
    broken: true,
    reason:
      `Lock destravado em ${checkedAt}: processo dono (pid ${info.pid}, label "${info.label}", desde ` +
      `${info.startedAt}) confirmado morto em "${currentHost}" (process.kill(pid, 0) → ESRCH).`,
    lockPath,
    lockInfo: info,
    checkedAt,
  };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function main(argv: string[]): number {
  const { flags, values } = parseArgs(argv);
  if (!flags.has("break")) {
    process.stderr.write(
      "Uso: clarice-envio-lock.ts --break --cycle CONTEUDO-ENVIO\n" +
        "  --break  destrava o lock do ciclo se o processo dono (mesmo pid/host) já morreu\n" +
        "  --cycle  ciclo do envio (ex: 2607-08) — obrigatório\n",
    );
    return 2;
  }
  const cycle = values["cycle"];
  if (!cycle) {
    process.stderr.write("--cycle é obrigatório com --break (ex: --cycle 2607-08)\n");
    return 2;
  }

  const result = breakEnvioLock(ROOT, cycle, new Date());
  console.log(JSON.stringify(result, null, 2));
  process.stderr.write(`${result.reason}\n`);
  return result.broken ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
