/**
 * Fases do corte avulso no `--publish` (#14327 item 5): a autorização
 * ("pode publicar", #11912) entre as validações que abortam e o 1º envio, e o
 * lock do timer do corte que a rodada manual toma antes de publicar destinos
 * do timer (#12001).
 *
 * Movido de `mainUnlocked` (`run.ts`) sem mudança de comportamento; as
 * condições (`corte`) e a posição de cada chamada seguem lá.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORTE_SPEC_FILE, CORTE_TIMER_LOCK_FILE, parseCorteSpec, type CorteSpec } from "../lib/diaria/short-corte.ts";
import { corteContentFingerprintFromBytes } from "../lib/diaria/corte-content.ts";
import { acquireTimerLock, TIMER_LOCK_HEARTBEAT_MS } from "../lib/diaria/timer-lock.ts";
import type { ShortsPlanItem } from "./_shared.ts";
import { corteManualTimerDestinations, registerCorteLockCleanup, corteTimerLockBusyError } from "./run-checks.ts";
import { type CorteAuthorizationRefusal, corteTimerChildRefusal, recordCortePublishAuthorization } from "./corte.ts";

/**
 * #11912: só o `--publish` confirmado do corte grava o "pode publicar" (e o
 * `--only` usado) no corte.json; o filho do timer (`--require-corte-authorization`)
 * só confere. Devolve `2` (recusa ou gravação falha) ou `null` (segue para o envio).
 */
export function authorizeCortePublish(input: {
  corte: CorteSpec;
  dir: string;
  /** Bytes do vídeo que esta rodada sobe. */
  file: Buffer;
  /** Bytes da capa já lidos (`readShortCover`), os mesmos que sobem. */
  coverBytes: Buffer | null;
  coverUnreadable: string | undefined;
  requireCorteAuth: boolean;
  /** `--only` como veio (o que a autorização grava). */
  onlyArg: string | undefined;
  onlyList: string[] | null;
  known: ReadonlySet<string>;
}): number | null {
  const { corte, dir } = input;
  // #11912: a impressão digital é dos bytes que esta rodada sobe (o vídeo já lido, a capa do readShortCover).
  const corteContent = corteContentFingerprintFromBytes(input.file, input.coverBytes);
  if (input.requireCorteAuth) {
    // #11912: o filho do timer só confere (autorização presente, cobre o --only, o mesmo plano com que montou
    // título e gancho, vídeo/capa iguais aos aprovados). A recusa sai em JSON: o timer alarma o motivo certo.
    const specPath = join(dir, CORTE_SPEC_FILE);
    let refusal: { refused: CorteAuthorizationRefusal; reason: string } | null;
    try {
      refusal = corteTimerChildRefusal(parseCorteSpec(readFileSync(specPath, "utf8"), specPath), corte, input.onlyList, corteContent);
    } catch (e) {
      // #11923: falha ao reler o corte.json (EBUSY do OneDrive, JSON pela metade) não é revogação.
      refusal = { refused: "spec-unreadable", reason: `corte.json ilegível nesta rodada: ${(e as Error).message}` };
    }
    if (refusal) {
      console.error(`publish-shorts: --require-corte-authorization: ${refusal.reason} — nada publicado`);
      console.log(JSON.stringify({ dry_run: false, authorization_refused: refusal.refused, reason: refusal.reason }, null, 2));
      return 2;
    }
  } else {
    try {
      recordCortePublishAuthorization(dir, input.onlyArg, input.known, corteContent, new Date().toISOString(), (l) => console.error(l), input.coverUnreadable);
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
  }
  return null;
}

/**
 * #12001: a rodada manual que publica destinos do timer do corte (a última hora antes do teto,
 * #11996) toma o MESMO lock do timer: o timer que passar junto acha o lock e sai sem publicar,
 * e se o timer já está com ele, esses destinos não saem por aqui. Falha ao tomar = recusa
 * (`busy` com o motivo, que o laço dá a cada destino do lock).
 */
export function takeCorteManualLock(
  items: readonly ShortsPlanItem[],
  dir: string,
  corte: CorteSpec | null,
  requireCorteAuth: boolean,
): { dests: string[]; busy: string | null; release: () => void } {
  const dests = corteManualTimerDestinations(items, corte ? { timerRun: requireCorteAuth } : null);
  let busy: string | null = null;
  let release = () => {};
  if (corte && dests.length) {
    let rel: (() => void) | null = null;
    try {
      rel = acquireTimerLock(join(dir, CORTE_TIMER_LOCK_FILE), Date.now(), { heartbeatMs: TIMER_LOCK_HEARTBEAT_MS }); // #12005: rodada sem teto renova o lock
    } catch (e) {
      busy = `lock do timer do corte não tomado (${(e as Error).message}): nada enviado neste destino para não duplicar o post com o timer (#12001)`;
    }
    if (rel) {
      release = registerCorteLockCleanup(rel);
    } else if (!busy) {
      busy = corteTimerLockBusyError(corte.slug);
    }
  }
  return { dests, busy, release };
}
