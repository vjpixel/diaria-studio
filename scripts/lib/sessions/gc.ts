/**
 * scripts/lib/sessions/gc.ts (#14004)
 *
 * GC de registros de sessão encerrada (`planSessionGc`/`garbageCollectSessions`):
 * nunca remove por staleness de heartbeat sozinha.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { conflictCopyBelongsToStem, isSyncConflictCopyName } from "../sync-conflict-copy.ts";
import { ALL_SESSION_KINDS, isCoordinatorKind, type SessionRecord, softStaleMsForKind } from "./types.ts";
import {
  endedAfterLastHeartbeat,
  listSessionJsonFiles,
  machineTag,
  readJsonSafe,
  sessionsDir,
  warnIoError,
} from "./store.ts";
import {
  logSessionLifecycleEvent,
  snapshotClaimedIssues,
  snapshotClaimedIssuesEver,
  snapshotForeignClaims,
} from "./registry.ts";

// ─── GC de registros encerrados (#6130) ────────────────────────────────────

/**
 * Janela CONSERVADORA usada quando não é possível confirmar liveness de
 * processo (sessão registrada por OUTRA máquina, ou sem `pid` gravado) — bem
 * maior que qualquer heartbeat esperado (`SOFT_STALE_MS` = 90min,
 * `MAX_SESSION_AGE_MS` = 24h), de propósito: sem sinal de processo, GC por
 * tempo sozinho é chute (ver "Ressalva importante" do #6130 — um registro
 * `stale: true` correspondeu a uma sessão VIVA que só parou de bater
 * heartbeat). 7 dias é a mesma ordem de grandeza do achado ao vivo da issue
 * (arquivo mais velho encontrado tinha 10 dias) — folgado o bastante pra
 * nunca remover algo que ainda pode estar em uso, curto o bastante pra
 * `data/sessions/` não crescer pra sempre.
 */
export const GC_CONSERVATIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Janela conservadora do kind `interactive` (#6168) — 2 horas, contra os 7
 * DIAS dos kinds coordenadores. Sem isto, a Parte B da issue pioraria o
 * problema que ela existe pra resolver: o beacon registra toda sessão
 * interativa automaticamente, e sessão interativa termina sem chamar `end`
 * (não há skill nenhuma pra chamar) — com a janela de 7 dias, `data/sessions/`
 * encheria de registros mortos, cada um segurando as claims dele contra
 * overnight/develop até a staleness resolver.
 *
 * 2h é folgado frente à janela de liveness de 15 min
 * (`INTERACTIVE_SOFT_STALE_MS`) — dá 8× de margem pra uma sessão que só parou
 * de chamar ferramenta por um tempo longo — e curto frente ao dano de um
 * registro órfão. O branch de PID vivo continua vencendo os dois: uma sessão
 * interativa com processo confirmadamente vivo na máquina local nunca é
 * removida, por mais stale que o heartbeat esteja.
 */
export const GC_INTERACTIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Margem de segurança aplicada à janela de liveness do KIND (`SOFT_STALE_MS`/
 * `INTERACTIVE_SOFT_STALE_MS`, via `softStaleMsForKind`) pra decidir remoção
 * de um BACKUP ÓRFÃO — sem arquivo real correspondente (#6595).
 *
 * Por que um limiar distinto da janela conservadora de 7 dias
 * (`GC_CONSERVATIVE_MAX_AGE_MS`): os 7 dias existem pra cobrir a
 * possibilidade de uma sessão estar viva em OUTRA máquina, sem arquivo local
 * pra provar liveness (ver docstring de `GC_CONSERVATIVE_MAX_AGE_MS`). Um
 * backup órfão não tem essa ambiguidade — ausência de arquivo real +
 * heartbeat do backup além da janela de liveness do próprio kind significa que
 * a sessão que o gerou não existe mais, em NENHUMA máquina.
 *
 * **Ressalva do #7002 (a premissa original desta docstring era mais forte do
 * que a realidade):** dizia-se aqui que "por construção, uma sessão viva bate
 * heartbeat no arquivo REAL, nunca só no backup". Isso foi FALSIFICADO ao
 * vivo em 01/09/2026 — o arquivo real de uma coordenadora ativa desapareceu
 * num lost-update sobre o junction OneDrive e as únicas cópias com estado
 * fresco eram os backups. A janela × margem continua correta e o valor não
 * muda; o que não vale mais é o "nunca". Um backup órfão com heartbeat DENTRO
 * da janela pode, sim, ser sessão viva — e é justamente por isso que ele nunca
 * chega a este limiar (branch 1 de `decideSessionGc` o preserva) e que
 * `readMergedSessionGroups` passou a promovê-lo de volta ao read-path. Não é limiar novo/arbitrário:
 * é a mesma janela que `decideSessionGc` já usa pra "claramente ativa"
 * (branch 1), só deixando de ser sobreposta pela janela conservadora no caso
 * em que o conservadorismo não protege nada real.
 *
 * 4× foi escolhido porque ainda deixa folga generosa sobre falhas
 * transitórias de heartbeat (ex: rate limit, hiccup de I/O do OneDrive) sem
 * se aproximar da ordem de grandeza de `GC_CONSERVATIVE_MAX_AGE_MS` — pro
 * kind `overnight` (`SOFT_STALE_MS` = 90min) dá 6h; medição ao vivo do #6595
 * encontrou 27 órfãos `overnight`, o mais novo já 6,5× além dos 90min, então
 * 4× segue conservador mesmo frente ao caso real que motivou a issue.
 */
export const GC_ORPHAN_LIVENESS_MARGIN = 4;

/**
 * Checa se `pid` corresponde a um processo vivo — padrão "kill -0"
 * (`process.kill(pid, 0)` nunca envia sinal de verdade, só testa
 * existência; funciona em POSIX e Windows). `ESRCH` (processo não existe)
 * → `false`; `EPERM` (existe, mas sem permissão de sinalizar) → `true`
 * em POSIX (existe é o que importa aqui, não permissão); qualquer outro
 * erro → `false` por segurança de INTERPRETAÇÃO (nunca finge "vivo" sobre um
 * erro que não sabemos classificar) — mas ver `decideSessionGc`: um
 * resultado `false` por si só só remove o registro se TAMBÉM estiver na
 * mesma máquina E além de `SOFT_STALE_MS`, nunca por PID sozinho.
 *
 * **Ressalva Windows (#7687):** o mapeamento acima é POSIX. No libuv/Windows,
 * `process.kill(pid, 0)` pode lançar `EPERM` tanto pra um processo vivo sem
 * permissão de sinalizar QUANTO pra um PID que simplesmente não existe —
 * `EPERM` sozinho é ambíguo nesta plataforma, não prova existência (medido
 * ao vivo: 2 registros de sessão com PID inexistente confirmados "vivos" por
 * este código antes do fix). Por isso, em `win32`, um `EPERM` dispara uma
 * segunda checagem real via `tasklist` (fonte de verdade do SO) em vez de
 * assumir "vivo" — só confirma `true` se o PID de fato aparecer na listagem.
 * Comportamento POSIX (`EPERM` → `true` direto) não muda.
 *
 * `runTasklist` é um seam injetável pra teste (mesmo padrão de `execImpl` em
 * `openInBrowser`, `scripts/serve-preview.ts`) — default roda o `tasklist`
 * real via `spawnSync`. Mockar o `spawnSync` do módulo `node:child_process`
 * direto não funciona aqui: o binding importado no topo deste arquivo não
 * observa mutação feita via `createRequire`/`mock.method` num teste noutro
 * módulo (verificado ao vivo — chamada real ao `tasklist` continuava indo a
 * despeito do mock), então a injeção de dependência é o caminho real.
 */
export function defaultIsPidAlive(pid: number, runTasklist: TasklistRunner = runTasklistReal): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM") return false;
    if (process.platform === "win32") return isPidAliveViaTasklist(pid, runTasklist);
    return true;
  }
}

/** Resultado bruto de rodar `tasklist` pra um PID — `null` se o comando falhou em rodar. */
export type TasklistResult = { status: number | null; stdout: string; stderr: string } | null;

/** Seam injetável de `defaultIsPidAlive` pro Windows — ver docstring acima. */
export type TasklistRunner = (pid: number) => TasklistResult;

function runTasklistReal(pid: number): TasklistResult {
  try {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
      // Mesmo timeout dos outros `spawnSync` deste arquivo (git status/rev-parse)
      // — sem isso, um `tasklist` travado (SO sob carga, AV interceptando)
      // trava `planSessionGc`/`decideSessionGc` inteiro sem saída (achado do
      // review do #7687: `spawnSync` expira devolvendo `status: null`, que
      // `isPidAliveViaTasklist` já trata como `false` corretamente).
      timeout: 10_000,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch {
    return null;
  }
}

/**
 * Confirmação real de PID vivo no Windows via `tasklist /FI "PID eq N"` —
 * usado só quando `process.kill(pid, 0)` lança `EPERM`, que no libuv/Windows
 * é ambíguo entre "existe, sem permissão" e "não existe" (#7687). Qualquer
 * falha em rodar/parsear `tasklist` (comando ausente, saída inesperada)
 * devolve `false` — mesma postura de segurança de interpretação do resto da
 * função: nunca finge "vivo" sobre um sinal que não sabemos ler.
 */
function isPidAliveViaTasklist(pid: number, runTasklist: TasklistRunner): boolean {
  const result = runTasklist(pid);
  if (!result || result.status !== 0 || !result.stdout) return false;
  const output = result.stdout.trim();
  if (!output || /no tasks/i.test(output)) return false;
  // Formato CSV do tasklist: "imagename","pid","sessionname",... — o PID
  // aparece entre aspas como 2º campo; checar a string exata evita casar
  // substring de outro PID (ex: 123 dentro de 1234).
  return output.split(/\r?\n/).some((line) => line.split(",")[1]?.trim() === `"${pid}"`);
}

export interface SessionGcOptions {
  now?: number;
  /** Default `GC_CONSERVATIVE_MAX_AGE_MS`. */
  conservativeMaxAgeMs?: number;
  /** Injetável pra teste — default `defaultIsPidAlive`. */
  isPidAlive?: (pid: number) => boolean;
  /** Default `machineTag()` local. */
  localMachineTag?: string;
}

export type SessionGcAction = "removed" | "kept";

export interface SessionGcResult {
  /** Rótulo legível da identidade avaliada — `{kind}-{machineTag}-{sessionId}`
   * pro grupo ancorado num arquivo real, ou `orphan-backup:{arquivo}` pra um
   * backup sem arquivo real correspondente, ou `worktree-claim-mirror:{stem}`
   * pro espelho que `claimWorktree` gravava até o #14214. */
  identity: string;
  /** Paths ABSOLUTOS de todo arquivo pertencente a esta identidade (arquivo
   * real + backups do grupo, ou só o próprio arquivo pra um órfão). */
  files: string[];
  action: SessionGcAction;
  /** Explicação legível da decisão — sempre populada, inclusive pra `"kept"`
   * (auditabilidade: por que este registro NÃO foi removido). */
  reason: string;
  /** #13114 — presente quando o grupo foi removido porque a sessão já chamou
   * `end` (carimbo numa cópia de conflito). `garbageCollectSessions` não
   * registra `gc-removed-without-end` nesse caso: o `ended` já está no log. */
  endedAt?: string;
  /** #13596 — sessão e kind do registro avaliado, quando legível. Usados para
   * apagar a presença no D1 de coordenadora removida (`clearPresenceForGcRemovals`). */
  sessionId?: string;
  kind?: string;
  /** #13603 — `machineTag` do registro avaliado, quando legível. O GC só apaga
   * a presença no D1 de coordenadora DESTA máquina. */
  machineTag?: string;
}

/**
 * Árvore de decisão pura (sem I/O) usada tanto pro grupo ancorado num
 * arquivo real quanto pra um backup órfão avaliado sozinho — ver docstring
 * de `planSessionGc`.
 *
 * **Nunca remove por staleness de heartbeat sozinha** (ressalva do #6130):
 *   1. Heartbeat mais recente do grupo dentro de `SOFT_STALE_MS` (90min) →
 *      mantém — claramente ativa.
 *   2. Heartbeat "no futuro" (clock skew) → mantém — nunca trata como
 *      abandonado.
 *   3. Além de `SOFT_STALE_MS`: se ALGUM registro do grupo foi escrito pela
 *      MÁQUINA LOCAL e carrega `pid`, `pid` CONFIRMADO VIVO mantém —
 *      INDEPENDENTE de quão velho o heartbeat esteja (é exatamente o
 *      cenário da ressalva: sessão viva que parou de bater heartbeat).
 *      **`pid` "morto" NÃO remove mais na hora (#6294)** — ver nota abaixo;
 *      cai pro branch 4 junto com "sem pid".
 *   4. Sem sinal de VIVO verificável (máquina diferente, nenhum registro do
 *      grupo tem `pid`, ou `pid` reportado morto) → só remove além da
 *      janela conservadora `conservativeMaxAgeMs` (default 7 dias) — chute
 *      deliberadamente caro de errar pro lado seguro.
 *
 * **#6294 — "`pid` morto → remove na hora" foi RETIRADO do branch 3.**
 * `--pid` é sempre preenchido a partir de `process.ppid` (hook
 * `inject-session-id.mjs` e beacon `session-beacon.mjs`), sob a premissa de
 * que esse é o pid do processo da sessão Claude Code corrente porque o
 * harness spawna o hook/beacon como filho direto dela a cada `PreToolUse`.
 * Medição ao vivo (#6294) CONTRADISSE essa premissa: numa sessão
 * `overnight` demonstravelmente viva (heartbeat fresco, gates de PR
 * rodando), o `pid` gravado já não correspondia a processo nenhum —
 * `process.ppid`, neste harness, aponta pra um processo efêmero que morre
 * quase imediatamente após gravar o registro, não pro processo persistente
 * da sessão. Não há como este módulo (nem o hook/beacon) confirmar a partir
 * do repo se isso é sempre assim ou só numa topologia específica do
 * harness — camada opaca, não verificável daqui. Enquanto essa incerteza
 * não for resolvida, tratar "`pid` morto" como sinal positivo de remoção é
 * a mesma classe de risco que motivou a ressalva do #6130 em primeiro
 * lugar: erra pro lado caro (perde `claimed_issues`/registro de uma sessão
 * genuinamente viva) só pra economizar dias de espera na janela
 * conservadora. `pid` VIVO continua um sinal ÚTIL de manter (falso-positivo
 * de "vivo" — outro processo reaproveitando o mesmo pid — só estende
 * proteção, nunca causa remoção indevida); `pid` morto deixou de ser um
 * sinal confiável de remoção e por isso não empurra mais o veredito sozinho
 * — some no branch 4, exatamente como "sem pid".
 *
 * **Limitação do #6130 fechada pelo #6160:** o branch 3 (PID vivo protege
 * incondicionalmente) era alcançável só pro kind `continuo` — `overnight`/
 * `develop` chamavam `register --kind {overnight|develop}` SEM `--pid` (e
 * nenhum dos dois chama `heartbeat`), colapsando a árvore inteira no branch
 * 4 pra eles. Fechado sem exigir mudança nas skills: `.claude/hooks/
 * inject-session-id.mjs` (o mesmo hook que já injeta `--session-id`
 * automaticamente, #5156) agora também injeta `--pid {process.ppid}` em
 * toda chamada standalone de `register` sem a flag — `process.ppid` do
 * hook É o PID da sessão Claude Code corrente, porque o harness spawna o
 * hook como filho direto dela a cada `PreToolUse`. `overnight`/`develop`
 * ainda nunca chamam `heartbeat` DIRETAMENTE — mas **isto não significa
 * `lastHeartbeat === startedAt` a sessão inteira** (correção do #6327: o
 * texto desta seção, até aqui, afirmava exatamente isso, e a medição ao vivo
 * mostrou o oposto — ver a docstring de `heartbeat` acima pro mecanismo
 * completo). Na prática o branch 3 (PID vivo) raramente chega a ser
 * exercitado pra esses 2 kinds porque o branch 1 (heartbeat recente) já
 * resolve primeiro — o beacon mantém `lastHeartbeat` fresco o tempo todo que
 * a sessão está ativa chamando QUALQUER ferramenta, então o branch 3
 * continua existindo como rede de segurança (heartbeat MESMO ASSIM stale —
 * beacon desligado, worktree vinculado, `data/` ausente), não como o
 * caminho comum que este texto descrevia antes — e é nesse caminho de rede
 * de segurança que a checagem de `pid` continua rodando independente de
 * quão stale o heartbeat esteja (só que, desde #6294, só o lado VIVO desse
 * branch pesa sozinho na decisão — "pid morto" não é mais sinal positivo de
 * remoção, ver docstring de `decideSessionGc` abaixo).
 *
 * **`isOrphan` (#6595)** — quando `true` (backup sem arquivo real
 * correspondente), a janela final do branch 4 deixa de ser
 * `conservativeMaxAgeMs` (7 dias, pensada pra "pode estar viva em outra
 * máquina") e passa a ser `softStaleMsForKind(kind) * GC_ORPHAN_LIVENESS_MARGIN`
 * — ver docstring de `GC_ORPHAN_LIVENESS_MARGIN` pro porquê. Sessão COM
 * arquivo real (`isOrphan` ausente/`false`) não muda: os 7 dias continuam
 * valendo integralmente, inclusive pro branch 3 (PID vivo), que nenhum dos
 * dois casos altera.
 */
function decideSessionGc(
  records: readonly SessionRecord[],
  now: number,
  conservativeMaxAgeMs: number,
  isPidAlive: (pid: number) => boolean,
  localTag: string,
  isOrphan = false,
): { action: SessionGcAction; reason: string } {
  let maxHeartbeatMs = -Infinity;
  for (const r of records) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && hb > maxHeartbeatMs) maxHeartbeatMs = hb;
  }
  if (!Number.isFinite(maxHeartbeatMs)) {
    return { action: "kept", reason: "timestamp ilegível em todos os arquivos do grupo — GC nunca remove sem sinal de idade confiável" };
  }

  // #6168: janela de liveness E janela conservadora são POR KIND —
  // `interactive` usa as suas, bem menores, porque nasce do beacon
  // automático e nunca chama `end` (ver INTERACTIVE_SOFT_STALE_MS /
  // GC_INTERACTIVE_MAX_AGE_MS). Kind ausente/desconhecido cai nos valores
  // dos coordenadores, que são os conservadores — nunca remove mais cedo
  // sobre um registro que não se conseguiu classificar.
  const groupKind = records[0]?.kind ?? "";
  const softStaleMs = softStaleMsForKind(groupKind);
  // #6595: órfão (sem arquivo real) usa a janela de liveness do próprio
  // kind × margem, não a janela conservadora de 7 dias — ver docstring de
  // `GC_ORPHAN_LIVENESS_MARGIN`. Sessão ancorada num arquivo real
  // (`isOrphan === false`) preserva o comportamento anterior sem alteração.
  // Restrito a `kind` CONHECIDO (`ALL_SESSION_KINDS`) — igual ao comentário
  // acima sobre kind ausente/desconhecido: um `kind` que este módulo não
  // reconhece não pode se beneficiar da janela mais curta (achado do review
  // do #6595 — sem essa guarda, um registro corrompido/futuro com `kind`
  // vazio cairia em `softStaleMsForKind("") = SOFT_STALE_MS` × margem em vez
  // da janela conservadora, o oposto do "nunca remove mais cedo sobre um
  // registro que não se conseguiu classificar").
  const isKnownKind = (ALL_SESSION_KINDS as readonly string[]).includes(groupKind);
  const effectiveMaxAgeMs =
    isOrphan && isKnownKind
      ? softStaleMs * GC_ORPHAN_LIVENESS_MARGIN
      : groupKind === "interactive"
        ? Math.min(conservativeMaxAgeMs, GC_INTERACTIVE_MAX_AGE_MS)
        : conservativeMaxAgeMs;

  const ageMs = now - maxHeartbeatMs;
  if (ageMs < 0) {
    return { action: "kept", reason: "heartbeat no futuro (possível clock skew) — nunca tratado como abandonado" };
  }
  if (ageMs <= softStaleMs) {
    return {
      action: "kept",
      reason:
        `heartbeat recente (${Math.round(ageMs / 60000)}min, dentro da janela de liveness de ` +
        `${Math.round(softStaleMs / 60000)}min pro kind "${groupKind || "desconhecido"}") — sessão claramente ativa`,
    };
  }

  // #6294: só o lado VIVO deste branch decide sozinho. `pid` reportado
  // MORTO não é mais tratado como sinal positivo de remoção — a fonte do
  // pid (`process.ppid`, ver docstring acima) foi medida ao vivo gravando
  // o pid de um processo efêmero, não o da sessão real, então "morto" aqui
  // pode só significar "a fonte estava errada", nunca "a sessão acabou".
  // Cai pro branch 4 (janela conservadora), igual a "sem pid".
  for (const r of records) {
    if (r.machineTag === localTag && typeof r.pid === "number" && isPidAlive(r.pid)) {
      return {
        action: "kept",
        reason:
          `heartbeat stale (${Math.round(ageMs / 60000)}min) mas processo pid=${r.pid} confirmado VIVO na máquina ` +
          `local (${localTag}) — nunca remove registro de sessão viva (ressalva #6130)`,
      };
    }
  }

  const orphanWindowApplies = isOrphan && isKnownKind;

  if (ageMs > effectiveMaxAgeMs) {
    if (orphanWindowApplies) {
      // #6595 + #7002: `claimed_issues` deste órfão não fazem parte da união
      // que `isIssueClaimedByOther`/`listActiveSessions`/Triagem leem — não
      // porque órfão nunca entre no read-path (desde o #7002 ele ENTRA, se o
      // grupo ainda parecer vivo), mas porque este branch só é alcançado
      // muito DEPOIS disso: aqui o heartbeat já passou de
      // `GC_ORPHAN_LIVENESS_MARGIN`× a janela de liveness do kind, então
      // `isOrphanBackupGroupLive` já respondia `false` havia bastante tempo.
      // Não é isso que a remoção "libera": o que muda é só a existência EM
      // DISCO destes números, pra qualquer consumidor que leia
      // `data/sessions/` diretamente, sem passar pela união.
      const claimedIssues = Array.from(new Set(records.flatMap((r) => r.claimed_issues ?? []))).sort((a, b) => a - b);
      // #10618: claims de outro repo (`owner/repo#N`) entram no mesmo aviso.
      const claimLabels = [
        ...claimedIssues.map((n) => `#${n}`),
        ...Array.from(new Set(records.flatMap((r) => r.claimed_foreign_issues ?? []))).sort(),
      ];
      const claimsNote =
        claimLabels.length > 0
          ? ` — leva junto ${claimLabels.length} claim(s) que estavam registrados neste arquivo órfão: ${claimLabels.join(", ")}`
          : " — sem claimed_issues";
      return {
        action: "removed",
        reason:
          `#6595: backup ÓRFÃO (sem arquivo real correspondente) — heartbeat stale há ${Math.round(ageMs / 60_000)}min, ` +
          `além de ${GC_ORPHAN_LIVENESS_MARGIN}× a janela de liveness do kind "${groupKind || "desconhecido"}" ` +
          `(${Math.round(softStaleMs / 60_000)}min × ${GC_ORPHAN_LIVENESS_MARGIN} = ${Math.round(effectiveMaxAgeMs / 60_000)}min). ` +
          "Sem arquivo real E sem heartbeat dentro da janela de liveness, não há sessão viva por trás (#7002: o " +
          "backup órfão RECENTE pode ser sessão viva que perdeu a âncora, e por isso é preservado no branch 1 e " +
          "promovido no read-path — este aqui já passou muito dessa janela) — removível sem o conservadorismo de " +
          `7 dias, que só se justifica quando o real pode existir noutra máquina${claimsNote}`,
      };
    }
    return {
      action: "removed",
      reason:
        `heartbeat stale há ${Math.round(ageMs / 60_000)}min, sem sinal de processo VIVO verificável ` +
        `(máquina diferente, sem pid registrado, ou pid reportado morto — #6294: um pid "morto" não é mais ` +
        `tratado como sinal de remoção, a fonte não é confiável o suficiente) — além da janela conservadora de ` +
        `${Math.round(effectiveMaxAgeMs / 60_000)}min pro kind "${groupKind || "desconhecido"}"`,
    };
  }
  return {
    action: "kept",
    reason: orphanWindowApplies
      ? `#6595: backup ÓRFÃO com heartbeat stale (${Math.round(ageMs / 60000)}min) mas ainda dentro da janela de ` +
        `liveness do kind × ${GC_ORPHAN_LIVENESS_MARGIN} (${Math.round(effectiveMaxAgeMs / 60_000)}min pro kind ` +
        `"${groupKind || "desconhecido"}") — GC não arrisca remover cedo demais`
      : isOrphan
        ? `backup ÓRFÃO de kind não reconhecido ("${groupKind || "desconhecido"}") — cai na janela conservadora ` +
          "por segurança de interpretação, mesmo sendo órfão (#6595: só kind conhecido usa a janela mais curta)"
        : `heartbeat stale (${Math.round(ageMs / 60000)}min) mas sem sinal de processo VIVO verificável e ainda dentro ` +
          "da janela conservadora — GC não arrisca remover sessão que pode estar viva",
  };
}

/**
 * Reconhece o espelho `worktree_claim` que `claimWorktree` gravava até o
 * #14214 (`{kind fixo "continuo"}-{tag da máquina}-{sessionId}.json`, com
 * conteúdo `{ session_id, worktree_claim }`, sem `sessionId` nem `kind`).
 * Só casa o formato exato do espelho: um record de sessão de verdade sempre
 * tem `sessionId` e `kind`, e um JSON corrompido ou de outro formato segue
 * caindo em "ilegível" (mantido).
 */
function isWorktreeClaimMirror(raw: unknown): raw is {
  session_id: string;
  worktree_claim: { expires_at: number };
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if ("sessionId" in r || "kind" in r) return false;
  if (typeof r.session_id !== "string" || r.session_id === "") return false;
  const claim = r.worktree_claim as Record<string, unknown> | undefined;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  return typeof claim.expires_at === "number" && Number.isFinite(claim.expires_at);
}

/**
 * Plano PURO (sem tocar disco) de GC de `data/sessions/` (#6130) — avalia
 * todo grupo ancorado num arquivo real (arquivo real + seus backups, ver
 * `readMergedSessionGroups`) e todo backup ÓRFÃO (sem arquivo real
 * correspondente — o caso canônico de "sessão encerrada, sobrou o
 * straggler") via `decideSessionGc`. Arquivo(s) ilegível(is)/corrompido(s)
 * nunca são removidos (mantém por segurança de interpretação — GC nunca
 * remove estado que não consegue entender).
 */
export function planSessionGc(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const now = opts.now ?? Date.now();
  const conservativeMaxAgeMs = opts.conservativeMaxAgeMs ?? GC_CONSERVATIVE_MAX_AGE_MS;
  // #6130 (achado do fleet review, P2): a validação de positividade existia
  // só no parser da CLI (`main()`, case "gc") — um caller programático
  // passando 0/negativo/NaN derrubava em silêncio a janela conservadora que
  // é a rede de segurança inteira do branch 4 de `decideSessionGc` (sem
  // sinal de processo verificável). Falha alto e cedo em vez de degradar.
  if (!Number.isFinite(conservativeMaxAgeMs) || conservativeMaxAgeMs <= 0) {
    throw new Error(
      `planSessionGc: conservativeMaxAgeMs precisa ser finito e positivo (recebido: ${conservativeMaxAgeMs})`,
    );
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const localTag = opts.localMachineTag ?? machineTag();

  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !isSyncConflictCopyName(n));
  const backupNames = names.filter((n) => isSyncConflictCopyName(n));
  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);

  const backupsByRealStem = new Map<string, string[]>();
  const orphanBackups: string[] = [];
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => conflictCopyBelongsToStem(backup, stem, ".json"));
    if (matchStem) {
      const list = backupsByRealStem.get(matchStem) ?? [];
      list.push(backup);
      backupsByRealStem.set(matchStem, list);
    } else {
      orphanBackups.push(backup);
    }
  }

  const results: SessionGcResult[] = [];
  // #14214: espelhos `worktree_claim` são decididos depois do laço, quando já
  // se sabe se a sessão dona tem grupo mantido (viva ou sem sinal confiável).
  const mirrorCandidates: { stem: string; paths: string[]; sessionId: string; expiresAt: number }[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const groupNames = [realName, ...(backupsByRealStem.get(stem) ?? [])];
    const groupPaths = groupNames.map((n) => join(dir, n));
    const raws = groupNames.map((n) => readJsonSafe<unknown>(join(dir, n)));
    const records = raws.filter(
      (r): r is SessionRecord => r !== null && !!(r as SessionRecord).sessionId && !!(r as SessionRecord).kind,
    );
    if (records.length === 0 && raws.length > 0 && raws.every(isWorktreeClaimMirror)) {
      const mirrors = raws as { session_id: string; worktree_claim: { expires_at: number } }[];
      const sessionIds = new Set(mirrors.map((m) => m.session_id));
      if (sessionIds.size === 1) {
        mirrorCandidates.push({
          stem,
          paths: groupPaths,
          sessionId: mirrors[0]!.session_id,
          expiresAt: Math.max(...mirrors.map((m) => m.worktree_claim.expires_at)),
        });
        continue;
      }
    }
    if (records.length === 0) {
      results.push({
        identity: stem,
        files: groupPaths,
        action: "kept",
        reason: "arquivo(s) ilegível(is)/corrompido(s) — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const identity = `${records[0]!.kind}-${records[0]!.machineTag}-${records[0]!.sessionId}`;
    const who = {
      sessionId: records[0]!.sessionId,
      kind: records[0]!.kind,
      ...(typeof records[0]!.machineTag === "string" ? { machineTag: records[0]!.machineTag } : {}),
    };
    // #13114: sessão que já chamou `end` e teve o real ressuscitado pelo sync.
    // O read-path já a ignora; o GC recolhe os arquivos sem esperar a janela
    // conservadora, porque o próprio carimbo é o sinal positivo de fim.
    const endedAt = endedAfterLastHeartbeat(records);
    if (endedAt !== null) {
      results.push({
        identity,
        files: groupPaths,
        action: "removed",
        reason:
          `#13114: a sessão chamou \`end\` (endedAt=${endedAt} numa cópia de conflito) e nenhum registro do grupo tem ` +
          "heartbeat posterior — o arquivo real é ressurreição do sync, não sessão viva",
        endedAt,
        ...who,
      });
      continue;
    }
    const decision = decideSessionGc(records, now, conservativeMaxAgeMs, isPidAlive, localTag);
    results.push({ identity, files: groupPaths, ...decision, ...who });
  }

  // #14214: o espelho segue a vida da sessão dona. Fica enquanto algum grupo
  // com o mesmo `sessionId` foi mantido (sessão viva, ou sem sinal confiável
  // de fim) e enquanto a claim espelhada não venceu há mais que a janela de
  // liveness (folga para relógio adiantado de outra máquina). Fora disso,
  // sessão dona removida ou já ausente do disco e claim vencida, sai.
  const mirrorGraceMs = softStaleMsForKind("continuo");
  for (const m of mirrorCandidates) {
    const ownerKept = results.find((r) => r.sessionId === m.sessionId && r.action === "kept");
    const identity = `worktree-claim-mirror:${m.stem}`;
    if (ownerKept) {
      results.push({
        identity,
        files: m.paths,
        action: "kept",
        reason: `espelho worktree_claim (#14214) da sessão ${m.sessionId}, que o GC manteve (${ownerKept.identity})`,
        sessionId: m.sessionId,
      });
    } else if (m.expiresAt + mirrorGraceMs > now) {
      results.push({
        identity,
        files: m.paths,
        action: "kept",
        reason: "espelho worktree_claim (#14214) com claim ainda dentro da validade (mais a folga de liveness)",
        sessionId: m.sessionId,
      });
    } else {
      results.push({
        identity,
        files: m.paths,
        action: "removed",
        reason:
          "espelho worktree_claim (#14214) órfão: claim vencida e nenhum registro mantido da sessão dona — " +
          "resíduo do mirror que claimWorktree gravava com kind/tag errados",
        sessionId: m.sessionId,
      });
    }
  }

  for (const backup of orphanBackups) {
    const path = join(dir, backup);
    const record = readJsonSafe<SessionRecord>(path);
    if (!record) {
      results.push({
        identity: `orphan-backup:${backup}`,
        files: [path],
        action: "kept",
        reason: "backup órfão ilegível/corrompido — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const decision = decideSessionGc([record], now, conservativeMaxAgeMs, isPidAlive, localTag, /* isOrphan */ true);
    results.push({
      identity: `orphan-backup:${backup}`,
      files: [path],
      ...decision,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      ...(typeof record.machineTag === "string" ? { machineTag: record.machineTag } : {}),
    });
  }

  return results;
}

/**
 * Aplica `planSessionGc` — remove (best-effort, `rmSync` por arquivo, nunca
 * lança) todo arquivo de todo grupo com `action: "removed"`. Fail-soft por
 * arquivo: se um `rmSync` individual falhar (ex: I/O transitório do
 * OneDrive), os demais arquivos do plano continuam sendo processados — a
 * próxima execução retenta o que sobrou.
 *
 * #6624: quando o grupo removido tem ARQUIVO REAL coordenador (não é
 * `orphan-backup:*` — esse é resíduo de uma sessão que já chamou `end`
 * corretamente) e `kind` está em `COORDINATOR_SESSION_KINDS`, registra
 * `"gc-removed-without-end"` no log de ciclo de vida — é o sinal direto de
 * "esta sessão nunca chamou `end`", a pergunta que a issue faz.
 */
export function garbageCollectSessions(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const plan = planSessionGc(repoRoot, opts);
  const now = opts.now ?? Date.now();
  for (const entry of plan) {
    if (entry.action !== "removed") continue;
    // #6624: lê o record ANTES de remover, só pra grupos coordenadores com
    // arquivo real (identity sem o prefixo "orphan-backup:") — instrumentação,
    // nunca afeta a decisão de remoção em si.
    const isOrphanGroup =
      entry.identity.startsWith("orphan-backup:") || entry.identity.startsWith("worktree-claim-mirror:");
    let lifecycleRecord: SessionRecord | null = null;
    // #13114: grupo de sessão que já chamou `end` não é "removido sem end".
    if (!isOrphanGroup && entry.endedAt === undefined) {
      const realFile = entry.files.find((f) => !isSyncConflictCopyName(f));
      lifecycleRecord = realFile ? readJsonSafe<SessionRecord>(realFile) : null;
    }
    // #6130 (achado HIGH do fleet review): antes disto, uma falha de rmSync
    // era engolida em silêncio E a entry continuava reportando "removed" —
    // o operador via "removido" no output do CLI mesmo com o arquivo ainda
    // no disco. Agora: loga a falha (mesmo padrão de `warnIoError`) e
    // rebaixa a entry pra "kept" quando pelo menos 1 arquivo do grupo não
    // foi confirmadamente removido — próxima execução do GC retenta.
    let allRemoved = true;
    for (const file of entry.files) {
      try {
        if (existsSync(file)) rmSync(file);
        if (existsSync(file)) allRemoved = false; // rmSync "teve sucesso" mas o arquivo persiste (raro, ex: lock de outro processo)
      } catch (e) {
        allRemoved = false;
        warnIoError(file, e);
      }
    }
    if (!allRemoved) {
      entry.action = "kept";
      entry.reason = `${entry.reason} [remoção falhou parcialmente — reportado como "kept", próxima execução retenta]`;
      continue;
    }
    if (lifecycleRecord && isCoordinatorKind(lifecycleRecord.kind)) {
      const startedMs = Date.parse(lifecycleRecord.startedAt ?? "");
      logSessionLifecycleEvent(repoRoot, {
        event: "gc-removed-without-end",
        kind: lifecycleRecord.kind,
        machineTag: lifecycleRecord.machineTag,
        sessionId: lifecycleRecord.sessionId,
        ts: new Date(now).toISOString(),
        ageMs: Number.isFinite(startedMs) ? now - startedMs : undefined,
        startedAt: lifecycleRecord.startedAt ?? null,
        lastHeartbeat: lifecycleRecord.lastHeartbeat ?? null,
        claimed_issues: snapshotClaimedIssues(lifecycleRecord),
        claimed_issues_ever: snapshotClaimedIssuesEver(lifecycleRecord),
        ...snapshotForeignClaims(lifecycleRecord),
      });
    }
  }
  return plan;
}
