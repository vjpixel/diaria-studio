/**
 * scripts/lib/sessions/merge-lock.ts (#14004)
 *
 * Merge lock: o arquivo local por repo (`.merge-lock*.json`, exclusão só na
 * mesma máquina, #6182) e as versões `*Shared`, que põem o D1 na frente para a
 * exclusão entre máquinas (#12842), com o arquivo como espelho e fallback.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
  type D1Client,
  d1AcquireLock,
  d1LocksClientFromRepo,
  d1ReadLock,
  d1ReleaseLock,
  d1RenewLock,
  mergeLockD1Name,
  reportD1Failure,
} from "../d1-locks.ts";
import { DEFAULT_ISSUE_REPO } from "../issue-repos.ts";
import { type ActiveSessionRecord, isCoordinatorKind, MERGE_LOCK_TTL_MS, type MergeLockRecord } from "./types.ts";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  machineTag,
  mergeLockPath,
  readJsonSafe,
  sessionsDir,
  warnClockSkew,
  writeJsonSafe,
} from "./store.ts";

/**
 * Primitivas de I/O usadas por `acquireMergeLock` — injetáveis pra teste
 * (mesmo padrão de `execFn` em `.claude/hooks/pr-create-review.mjs`). O
 * default (`REAL_MERGE_LOCK_IO`) usa `node:fs` de verdade; testes injetam um
 * "disco" fake em memória pra simular INTERCALAÇÃO real entre duas sessões
 * concorrentes (coisa que chamadas sequenciais dentro de um único processo
 * Node — de propósito single-threaded — não conseguem exercitar sozinhas).
 */
export interface MergeLockIo {
  /**
   * Cria `path` com `data` de forma EXCLUSIVA — só sucede se `path` ainda não
   * existir. Retorna `true` em criação, `false` em `EEXIST` (path já existe).
   * Qualquer outro erro de I/O deve ser relançado (o caller decide).
   */
  tryCreateExclusive: (path: string, data: string) => boolean;
  /** Lê e parseia `path`; `null` em qualquer falha (ausente/corrompido). */
  readCurrent: (path: string) => MergeLockRecord | null;
  /** Sobrescreve `path` com `data`, sem exclusividade. */
  overwrite: (path: string, data: string) => void;
}

const REAL_MERGE_LOCK_IO: MergeLockIo = {
  tryCreateExclusive: (path, data) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw e;
    }
  },
  readCurrent: (path) => readJsonSafe<MergeLockRecord>(path),
  overwrite: (path, data) => writeJsonSafe(path, JSON.parse(data)),
};

/**
 * Limiar de "cadência de heartbeat esperada" pra sinalizar sync cross-máquina
 * potencialmente degradado (#7169) — deliberadamente bem menor que
 * `SOFT_STALE_MS` (90min, sinal de "sessão morta"). O incidente de origem
 * (02/09/2026): `data/sessions/` do `300` ficou congelado por 1h13
 * (`onedrive.service` morto às 18:37, sem alarme) enquanto uma coordenadora
 * seguia genuinamente ativa lá — 73min < 90min, então o registro dela nunca
 * cruzou `SOFT_STALE_MS` e continuou contando como "ativa" em
 * `listActiveSessions`/`readActiveCoordinatorScan`. O merge lock e o
 * `merge_grant` moram no MESMO diretório sincronizado — se o registro leva
 * 1h+ pra atravessar, os dois levam também, e nada no caminho quente avisava
 * disso.
 *
 * Este limiar não tenta ser preciso sobre a cadência real de heartbeat (não é
 * documentada como constante em lugar nenhum) — só precisa ser um múltiplo
 * generoso dela pra nunca disparar em sync saudável, e ainda assim MUITO
 * menor que `SOFT_STALE_MS` pra dar sinal bem antes da janela de 1h13
 * observada. 10min: heartbeat normal é de minuto a minuto: 10min sem
 * atualização de uma coordenadora que a varredura ainda considera "ativa" (
 * não cruzou `SOFT_STALE_MS`) já é anômalo o bastante pra merecer aviso.
 */
export const CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS = 10 * 60 * 1000;

/**
 * Direção (c) da #7169 — "guard de frescor": não impede nada (o lock
 * continua sendo advisory entre máquinas, #6182, e esta função não muda
 * isso — só torna VISÍVEL um sinal que hoje é mudo), mas transforma o modo
 * de falha SILENCIOSO em RUIDOSO, que é a fatia mais barata recomendada no
 * corpo da issue: "(c) Guard de frescor... degrada para 'não mergeie agora'
 * em vez de mergear cego" — aqui implementado como aviso explícito no
 * caminho de `merge-lock-acquire` (ver o CLI abaixo), não como bloqueio
 * mecânico: um bloqueio duro sobre esta heurística arriscaria false
 * positive em sync genuinamente lento mas vivo, e a decisão de arquitetura
 * mais funda (mover o lock pra um substrato com semântica real — direção
 * (b) da issue) segue em aberto, não decidida.
 *
 * Devolve as sessões COORDENADORAS ativas (`!session.stale`) de OUTRA
 * máquina cujo `lastHeartbeat` está mais velho que
 * `CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS` — candidatas a "sync pode estar
 * degradado, este registro pode não refletir o estado real daquela
 * máquina agora". Sessões da PRÓPRIA máquina nunca entram (leitura local,
 * sem sync no caminho — não há o que avisar).
 *
 * ─── Existe um SEGUNDO detector de sync degradado (#7300) ──────────────
 *
 * `scripts/lib/onedrive-sync-alarm.ts` cobre a mesma classe de falha por
 * outro caminho. Os dois são úteis e NÃO devem ser fundidos — mas quem
 * investigar "o sync estava fora?" precisa saber que há duas fontes, e por
 * que elas podem discordar sobre a mesma janela de tempo:
 *
 * | | esta função | `onedrive-sync-alarm.ts` |
 * |---|---|---|
 * | quando roda | síncrono, no `merge-lock-acquire` | agendado, independente de sessão |
 * | o que observa | `lastHeartbeat` de sessão de OUTRA máquina | `systemctl is-active` + mtime de um canário |
 * | limiar | 10min (`CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS`) | 6h (`--tolerance-hours`, default) |
 * | efeito | aviso no terminal de quem vai mergear | e-mail/issue |
 *
 * **A discordância esperada vem do fator ~36 entre os limiares**, e é
 * assimétrica: uma janela de 20min de sync morto acende ESTE aviso e deixa
 * o alarme em silêncio (ainda dentro da tolerância de 6h). O inverso —
 * alarme aceso e este aviso mudo — acontece quando não há sessão de outra
 * máquina registrada, porque esta função só enxerga sync através de
 * heartbeat alheio: sem peer, ela não tem o que medir.
 *
 * Nenhum dos dois é "o certo": este é sensível e local à decisão de merge;
 * o outro é lento e independente de haver alguém trabalhando. Um silêncio
 * aqui NUNCA é evidência de que o sync está saudável.
 */
export function assessCrossMachineSyncFreshness(
  sessions: readonly ActiveSessionRecord[],
  now: number = Date.now(),
  myMachineTag: string = machineTag(),
): { stale: boolean; staleSessions: ActiveSessionRecord[] } {
  const staleSessions = sessions.filter((session) => {
    if (session.machineTag === myMachineTag) return false;
    if (!isCoordinatorKind(session.kind)) return false;
    if (session.stale) return false; // já é sinalizada por outro caminho (GC-eligible)
    const heartbeatMs = Date.parse(session.lastHeartbeat);
    if (!Number.isFinite(heartbeatMs)) return false; // ilegível — não inventa idade
    const ageMs = now - heartbeatMs;
    if (ageMs < 0) return false; // "no futuro" é clock skew, não sync degradado — não é o sinal que esta função procura
    return ageMs > CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS;
  });
  return { stale: staleSessions.length > 0, staleSessions };
}

/**
 * Adquire o lock global de merge (item 4 do #5156) — serializa `gh pr merge` +
 * `git pull` entre sessões concorrentes (mesma máquina é atômico via
 * `O_EXCL`; entre máquinas via OneDrive o lock é **advisory** — ver o
 * docblock do módulo e o #6182). TTL curto: um lock mais velho que
 * `MERGE_LOCK_TTL_MS` é tratado como abandonado (coordenador crashou
 * segurando o lock) e liberado automaticamente pro próximo adquirente —
 * nunca trava a máquina pra sempre.
 *
 * **#6334 — deixou de ser reentrante para a MESMA sessão.** Até aqui, uma
 * 2ª chamada da mesma `sessionId` enquanto o lock que ELA MESMA segurava
 * ainda estava dentro do TTL só renovava o `acquiredAt` e retornava `true`
 * na hora, sem esperar nada — pensado como "idempotência segura" pro caso
 * sequencial normal (acquire → merge → release, #5156 item 4). O #6299
 * (fan-out em onda) tornou isso perigoso: a MESMA sessão overnight passou a
 * poder ter 2-3 unidades chegando em "pronto pra mergear" ao mesmo tempo, e
 * a reentrância deixava um 2º `gh pr merge` da mesma sessão passar "ao
 * mesmo tempo" que o 1º sem nenhuma serialização real entre eles — quebrando
 * o invariante de "master recebe um squash por vez" (#636) bem no cenário
 * que o lock existe pra proteger. Nenhum caminho de produção hoje chama
 * `acquireMergeLock` uma 2ª vez pela mesma sessão ANTES de liberar a 1ª —
 * `mergeSoloPr`/`mergeTrainBatch` (`scripts/lib/merge-train-live.ts`) sempre
 * fazem acquire→merge→release num único `try/finally`, e o loop de retry por
 * lock negado (`runMergeTrain`) só tenta de novo DEPOIS que essa `finally` já
 * rodou — então blindar a reentrância não regride nenhum fluxo real. Quem
 * precisa genuinamente estender o TTL de um hold que já é seu (operação
 * longa, mesmo lock, nunca liberado) usa `renewMergeLock` — uma função
 * separada, que só aceita renovar o que a própria sessão já detém, nunca
 * concede um hold novo. Ver `test/session-registry.test.ts` (#6334) pros
 * dois caminhos: renovação explícita ✅ vs. 2ª aquisição concorrente ❌.
 *
 * **#5161 fleet review item 1 (CRÍTICO):** a versão anterior fazia
 * read→check→write sem NENHUMA primitiva atômica — duas sessões podiam ler
 * "sem lock" simultaneamente e ambas escreverem, ambas recebendo `true`,
 * quebrando a exclusão mútua NA MESMA MÁQUINA, que é o mínimo esperado
 * deste mecanismo. (O #5161 descrevia esse bug como sendo "o cenário
 * cross-máquina via `data/` OneDrive que o #5156 existe pra proteger" — o
 * #6182 corrigiu essa parte: o fix abaixo resolve a corrida entre processos
 * do MESMO filesystem; entre máquinas o lock segue advisory, e nenhuma das
 * duas partes muda isso.) Fix em duas partes:
 *   1. **Fast path (mesma máquina — nenhuma concorrência com outro inode):**
 *      criação exclusiva atômica (`writeFileSync(path, data, { flag: "wx" })`,
 *      que mapeia pra `O_CREAT | O_EXCL`). Entre processos DIFERENTES no
 *      MESMO kernel/filesystem, no máximo UMA chamada com o MESMO path
 *      ausente pode suceder. **Entre máquinas via OneDrive, NÃO é atômica:**
 *      cada máquina vê um inode distinto no mesmo junction, ambas podem
 *      criar o arquivo e receber `true`. O lock é advisory nesse caso (#6182).
 *      Nenhuma coordenação em memória deste arquivo entra nessa garantia.
 *   2. **Caso raro — lock existe mas expirou (TTL, coordenador crashou):**
 *      plain `fs` não oferece um "substituir só se o conteúdo não mudou
 *      desde que eu li" (compare-and-swap) sem uma lib de lock externa que
 *      este repo não usa. Mitigação: sobrescrever e então RELER
 *      imediatamente pra verificar se a escrita que está no disco agora é
 *      de fato a NOSSA (`heldBy === sessionId`) — se não for, outra sessão
 *      venceu a corrida, retorna `false`. Isto fecha o caso mais comum do
 *      bug original (nenhuma verificação pós-escrita nenhuma — sempre
 *      retornava `true` incondicionalmente). Continua existindo uma janela
 *      residual estreita (o ciclo inteiro de OUTRA sessão completar entre a
 *      nossa PRÓPRIA leitura de decisão e a nossa PRÓPRIA escrita) — dado
 *      que este é o caminho raro (requer um crash prévio E uma corrida bem
 *      no instante de expiração do TTL), a mitigação abaixo é
 *      deliberadamente proporcional ao risco, não uma prova de CAS perfeito.
 *
 * Retorna `true` quando o lock foi adquirido (ninguém o detinha, ou detinha
 * mas já estava STALE — TTL expirado, tratado como abandonado), `false`
 * quando alguém o segura e ainda está dentro do TTL — **inclusive quando
 * esse "alguém" é a PRÓPRIA sessão chamadora** (#6334): uma 2ª chamada da
 * mesma `sessionId` enquanto o hold dela ainda está fresco NÃO é mais
 * reentrante — é tratada como uma tentativa concorrente de aquisição, e
 * falha como qualquer outra. Isso é deliberado: é exatamente o caso que o
 * #6299 tornou possível (mesma sessão com 2-3 merges "prontos" ao mesmo
 * tempo) e que a reentrância antiga deixava passar sem serialização real.
 * Quem precisa estender o TTL de um hold que genuinamente já é seu (nunca
 * liberado, operação mais longa que o TTL) usa `renewMergeLock`, não uma 2ª
 * chamada a esta função.
 */
export function acquireMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_LOCK_TTL_MS,
  io: MergeLockIo = REAL_MERGE_LOCK_IO,
  repo: string = DEFAULT_ISSUE_REPO,
): boolean {
  const path = mergeLockPath(repoRoot, repo);
  const data = JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);

  // Fast path: nenhum lock existia — criação exclusiva atômica (ver docblock).
  try {
    if (io.tryCreateExclusive(path, data)) return true;
  } catch {
    // Erro de I/O inesperado (não-EEXIST) — nunca assumir que adquirimos o
    // lock sobre um estado que não conseguimos nem determinar.
    return false;
  }

  const current = io.readCurrent(path);
  if (current) {
    const acquiredMs = Date.parse(current.acquiredAt);
    if (Number.isFinite(acquiredMs)) {
      const ageMs = now - acquiredMs;
      // #5161 item 2: idade negativa (lock "no futuro" pro nosso relógio) NUNCA
      // é tratada como "abandonado" — um clock adiantado em OUTRA máquina não
      // pode fazer um lock genuinamente fresco parecer roubável. Só logamos
      // quando o delta passa da tolerância de jitter normal (potencial skew
      // real entre máquinas, vale investigar); dentro da tolerância é
      // silencioso, é só o lock sendo tratado como fresco mesmo.
      if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) warnClockSkew("acquireMergeLock", `lock de ${current.heldBy}`, ageMs);
      // #6334: este teto vale IGUALMENTE quando `current.heldBy === sessionId`
      // — um hold fresco da própria sessão bloqueia uma 2ª aquisição dela
      // tanto quanto bloquearia a de outra sessão. Ver docblock da função.
      if (ageMs <= ttlMs) return false; // ainda dentro do TTL (com folga de tolerância) — alguém (possivelmente nós mesmos) segura de verdade
    }
    // acquiredAt ilegível (campo corrompido, mas JSON válido) — cai pro
    // tratamento de "stale" abaixo, mesma política de antes.
  }

  // Stale (TTL expirado) ou corrompido/ilegível: contesta. Não-atômico — ver
  // docblock acima pro racional e a janela residual aceita.
  io.overwrite(path, data);
  const verify = io.readCurrent(path);
  return verify?.heldBy === sessionId;
}

/**
 * #11380: texto do resultado de `merge-lock-acquire` no stdout. Na recusa
 * em que o lock é da PRÓPRIA sessão (#6334, não reentrante), a mensagem diz
 * isso em vez de "held by another session", que mandava procurar uma sessão
 * que não existe. A palavra "denied" fica nas duas recusas: `merge-train-live.ts`
 * e `publish-edition-site-page.ts` detectam a negação por `/denied/i`.
 */
export function mergeLockAcquireOutcome(ok: boolean, sessionId: string, holder: MergeLockRecord | null | undefined): string {
  if (ok) return "ok";
  if (holder?.heldBy === sessionId) {
    return (
      `denied (lock já detido por esta sessão (desde ${holder.acquiredAt}); ` +
      "use merge-lock-renew para estender ou siga com o merge)"
    );
  }
  return "denied (held by another session)";
}

/**
 * Estende o TTL de um lock de merge que a PRÓPRIA sessão já detém (#6334) —
 * o caminho correto pra "operação mais longa que o TTL, mesmo hold, nunca
 * liberado", que antes era coberto (incorretamente, ver #6334) pela
 * reentrância de `acquireMergeLock`. Só renova o que a sessão chamadora já
 * segura: `false` se não há lock, ou se o lock pertence a OUTRA sessão —
 * nunca cria um hold novo, nunca rouba lock alheio. Diferente de
 * `acquireMergeLock`, não checa staleness do TTL antes de renovar — se o
 * arquivo ainda diz `heldBy === sessionId`, ninguém mais contestou o lock
 * ainda, então renovar é seguro independente de quanto tempo se passou desde
 * o último `acquiredAt`.
 */
export function renewMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  io: MergeLockIo = REAL_MERGE_LOCK_IO,
  repo: string = DEFAULT_ISSUE_REPO,
): boolean {
  const path = mergeLockPath(repoRoot, repo);
  const current = io.readCurrent(path);
  if (!current || current.heldBy !== sessionId) return false;
  const data = JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);
  io.overwrite(path, data);
  return true;
}

/**
 * Libera o lock de merge. Retorna `true` quando já estava livre ou foi
 * liberado por quem o segurava; `false` quando outra sessão é a dona atual
 * (nunca libera lock alheio por engano).
 */
export function releaseMergeLock(repoRoot: string, sessionId: string, repo: string = DEFAULT_ISSUE_REPO): boolean {
  const path = mergeLockPath(repoRoot, repo);
  const current = readJsonSafe<MergeLockRecord>(path);
  if (!current) return true;
  if (current.heldBy !== sessionId) return false;
  if (existsSync(path)) rmSync(path);
  return true;
}

// ─── #12842: merge lock e consumo de concessão no D1 (entre máquinas) ───────
//
// O arquivo `.merge-lock*.json` só exclui na MESMA máquina (#6182). As versões
// `*Shared` abaixo põem o D1 na frente (exclusão real entre máquinas, ver
// `scripts/lib/d1-locks.ts`) e mantêm o arquivo como espelho e fallback:
//   - D1 respondeu: a decisão é do D1. O arquivo é espelho e não veta: se
//     ele diz outra sessão (sync defasado, hold de fallback), é regravado com
//     aviso que nomeia o holder antigo. Exceção #6334: hold fresco da PRÓPRIA
//     sessão no arquivo segue recusando a 2ª aquisição (o D1 o adota).
//   - D1 sem resposta: só o arquivo, com aviso explícito em stderr
//     (`d1FallbackWarning`; erro permanente vira ERRO + run-log, ver
//     `reportD1Failure`). Falha do D1 nunca bloqueia merge legítimo.
//   - D1 não provisionado (`d1_locks.database_id` vazio): só o arquivo, em
//     silêncio — é o comportamento de antes desta issue.
// Os hooks de merge leem o mesmo nome no D1 (`.claude/hooks/lib/d1-locks.mjs`).

export type MergeLockBackend = "d1" | "local" | "local-fallback";

export interface SharedMergeLockResult {
  ok: boolean;
  backend: MergeLockBackend;
  /** Quem segura no D1 quando a recusa veio de lá. */
  d1Holder?: string | null;
}

export interface SharedLockOptions {
  /** `undefined` = resolve do checkout; `null` = sem D1 (só arquivo). */
  d1?: D1Client | null;
  now?: number;
  /** Relógio injetado no D1 (teste). Omitido = relógio do servidor. */
  d1Now?: number;
  ttlMs?: number;
  io?: MergeLockIo;
  warn?: (msg: string) => void;
}

export function stderrWarn(msg: string): void {
  process.stderr.write(msg);
}

export function resolveD1ForRepo(repoRoot: string, opts: SharedLockOptions): D1Client | null {
  if (opts.d1 !== undefined) return opts.d1;
  const warn = opts.warn ?? stderrWarn;
  return d1LocksClientFromRepo(repoRoot, process.env, (reason) =>
    warn(`⚠️  d1-locks (#12842): D1 configurado mas indisponível (${reason}) — seguindo com o lock LOCAL de data/.\n`),
  );
}

function d1LockMeta(): string {
  return JSON.stringify({ machine: machineTag() });
}

/**
 * #12967: `id` é o `session_id` de uma sessão registrada em `data/sessions/`
 * (arquivo `{kind}-{tag}-{id}.json`)? Holder sintético de quem não é sessão
 * (o waiter de merge da página do site) devolve `false`. Diretório ilegível
 * também devolve `false`: na dúvida o hold fresco não é sobrescrito.
 */
export function isRegisteredSessionId(repoRoot: string, id: string): boolean {
  if (!id) return false;
  try {
    const suffix = `-${id}.json`;
    return readdirSync(sessionsDir(repoRoot)).some((f) => f.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * Devolve um lock que acabamos de tomar no D1 (rollback). Falha ao devolver
 * nunca passa em silêncio: o lock ficaria órfão até vencer o TTL, segurando
 * o recurso para toda máquina — o aviso nomeia o lock.
 */
async function rollbackD1Lock(
  d1: D1Client,
  name: string,
  sessionId: string,
  d1Opts: { now?: number },
  warn: (msg: string) => void,
  what: string,
): Promise<void> {
  const r = await d1ReleaseLock(d1, name, sessionId, d1Opts);
  if (r.ok && r.value !== "held_by_other") return;
  warn(
    `⚠️  d1-locks (#12842): ${what}: não consegui devolver o lock "${name}" no D1 ` +
      `(${r.ok ? r.value : r.error}) — ele fica órfão até vencer o TTL.\n`,
  );
}

export async function acquireMergeLockShared(
  repoRoot: string,
  sessionId: string,
  repo: string = DEFAULT_ISSUE_REPO,
  opts: SharedLockOptions = {},
): Promise<SharedMergeLockResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? MERGE_LOCK_TTL_MS;
  const io = opts.io ?? REAL_MERGE_LOCK_IO;
  const warn = opts.warn ?? stderrWarn;
  const local = () => acquireMergeLock(repoRoot, sessionId, now, ttlMs, io, repo);
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return { ok: local(), backend: "local" };
  const name = mergeLockD1Name(repo);
  const r = await d1AcquireLock(d1, name, sessionId, ttlMs, {
    meta: d1LockMeta(),
    ...(opts.d1Now !== undefined ? { now: opts.d1Now } : {}),
  });
  if (!r.ok) {
    reportD1Failure(repoRoot, "merge-lock-acquire", r, warn);
    return { ok: local(), backend: "local-fallback" };
  }
  if (!r.value.acquired) return { ok: false, backend: "d1", d1Holder: r.value.current?.holder ?? null };
  if (local()) return { ok: true, backend: "d1" };
  // O D1 respondeu e concedeu: ele é a autoridade, o arquivo é espelho e não
  // veta (#12842 review). Um arquivo que diz outra sessão é sync defasado ou
  // hold tomado no fallback, com o D1 fora do ar.
  const path = mergeLockPath(repoRoot, repo);
  const fileHolder = io.readCurrent(path)?.heldBy;
  if (fileHolder === sessionId) {
    // #6334: hold fresco da PRÓPRIA sessão no arquivo (tomado no fallback). O
    // D1 o adota (a linha fica), e a 2ª aquisição segue recusada.
    return { ok: false, backend: "d1", d1Holder: sessionId };
  }
  if (fileHolder !== undefined && !isRegisteredSessionId(repoRoot, fileHolder)) {
    // #12967: holder que não é sessão registrada (o waiter de merge da página
    // do site, `site-page-merge-waiter:pr-N:pid-X`) só usa o arquivo e nunca
    // escreve no D1. O hold dele é fresco (o `local()` acabou de recusar), então
    // é um merge em curso nesta máquina: sobrescrever daria dois merges
    // simultâneos no mesmo repo. Devolve o D1 e recusa, como o O_EXCL fazia.
    await rollbackD1Lock(d1, name, sessionId, opts.d1Now !== undefined ? { now: opts.d1Now } : {}, warn, "merge-lock-acquire");
    return { ok: false, backend: "local", d1Holder: null };
  }
  io.overwrite(path, JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord));
  warn(
    `⚠️  d1-locks (#12842): merge-lock-acquire: o D1 concedeu o lock, mas o arquivo local dizia ` +
      `${fileHolder ?? "(ilegível)"} (sync defasado ou hold de fallback) — vale o D1; espelho local regravado.\n`,
  );
  return { ok: true, backend: "d1" };
}

export async function releaseMergeLockShared(
  repoRoot: string,
  sessionId: string,
  repo: string = DEFAULT_ISSUE_REPO,
  opts: SharedLockOptions = {},
): Promise<SharedMergeLockResult> {
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return { ok: releaseMergeLock(repoRoot, sessionId, repo), backend: "local" };
  const name = mergeLockD1Name(repo);
  const d1Opts = opts.d1Now !== undefined ? { now: opts.d1Now } : {};
  const warn = opts.warn ?? stderrWarn;
  let r = await d1ReleaseLock(d1, name, sessionId, d1Opts);
  // #13007: falha transitória ganha uma 2ª tentativa — a linha que fica no D1
  // recusa todo mundo (o próprio dono incluído) até vencer o TTL.
  if (!r.ok && !r.permanent) r = await d1ReleaseLock(d1, name, sessionId, d1Opts);
  // O arquivo só é apagado se for desta sessão — sempre seguro tentar.
  const local = releaseMergeLock(repoRoot, sessionId, repo);
  if (!r.ok) {
    reportD1Failure(repoRoot, "merge-lock-release", r, warn);
    warn(
      `⚠️  d1-locks (#13007): merge-lock-release: o arquivo local foi solto, mas a linha "${name}" pode ter ficado no D1 ` +
        `até vencer o TTL (${Math.round(MERGE_LOCK_TTL_MS / 60_000)} min) — até lá o merge-lock-acquire de qualquer sessão, ` +
        "esta incluída, é recusado. Espere o TTL ou rode merge-lock-release de novo.\n",
    );
    return { ok: local, backend: "local-fallback" };
  }
  if (r.value === "held_by_other") {
    const cur = await d1ReadLock(d1, name, d1Opts);
    return { ok: false, backend: "d1", d1Holder: cur.ok ? (cur.value?.holder ?? null) : null };
  }
  // Soltou no D1: é a autoridade, o espelho local é secundário.
  if (r.value === "released") return { ok: true, backend: "d1" };
  // `not_held`: o hold pode ter sido tomado no fallback, só no arquivo.
  return { ok: local, backend: "d1" };
}

export async function renewMergeLockShared(
  repoRoot: string,
  sessionId: string,
  repo: string = DEFAULT_ISSUE_REPO,
  opts: SharedLockOptions = {},
): Promise<SharedMergeLockResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? MERGE_LOCK_TTL_MS;
  const io = opts.io ?? REAL_MERGE_LOCK_IO;
  const warn = opts.warn ?? stderrWarn;
  const local = () => renewMergeLock(repoRoot, sessionId, now, io, repo);
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return { ok: local(), backend: "local" };
  const name = mergeLockD1Name(repo);
  const d1Opts = opts.d1Now !== undefined ? { now: opts.d1Now } : {};
  const r = await d1RenewLock(d1, name, sessionId, ttlMs, d1Opts);
  if (!r.ok) {
    reportD1Failure(repoRoot, "merge-lock-renew", r, warn);
    return { ok: local(), backend: "local-fallback" };
  }
  if (r.value) {
    if (!local()) {
      warn("⚠️  d1-locks (#12842): merge-lock-renew renovou no D1, mas o arquivo local não era desta sessão (sync?).\n");
    }
    return { ok: true, backend: "d1" };
  }
  // Sem linha nossa no D1: o hold pode ter sido tomado no fallback, com o D1
  // fora do ar. Só é adotado se o arquivo for nosso E o D1 estiver livre.
  const current = readJsonSafe<MergeLockRecord>(mergeLockPath(repoRoot, repo));
  if (current?.heldBy !== sessionId) return { ok: false, backend: "d1" };
  const a = await d1AcquireLock(d1, name, sessionId, ttlMs, { meta: d1LockMeta(), ...d1Opts });
  if (!a.ok) {
    reportD1Failure(repoRoot, "merge-lock-renew", a, warn);
    return { ok: local(), backend: "local-fallback" };
  }
  if (!a.value.acquired) return { ok: false, backend: "d1", d1Holder: a.value.current?.holder ?? null };
  return { ok: local(), backend: "d1" };
}
