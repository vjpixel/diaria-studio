/**
 * scripts/lib/node-modules-loop-alarm.ts (#5571)
 *
 * Lógica PURA (sem I/O) do alarme de sanity que detecta `node_modules`
 * virando um symlink AUTO-REFERENTE (loop) no checkout principal
 * compartilhado — achado ao vivo na rodada `/diaria-overnight` 260817c: dois
 * processos `npm install`/`npm ci` concorrentes escrevendo no MESMO
 * `node_modules` (um deles rodando FORA de worktree, violando a convenção —
 * ver `context/overnight-dispatch-rules.md` §3 "Bootstrap do worktree")
 * corromperam `node_modules` num symlink apontando pra si mesmo
 * (`node_modules -> {mesmo path absoluto}`), quebrando todo `npx tsx`/`npm`
 * nesse checkout com `FilesystemLoop`/"Too many levels of symbolic links" —
 * sem stdout, exit code opaco (216 na ocorrência observada — ver #5571 pro
 * valor exato; detalhe forense de um incidente, não uma garantia).
 *
 * `family: "estado"` (#5553) — a condição é RE-CHECÁVEL a cada execução;
 * resolve sozinha assim que alguém rodar `rm node_modules && npm ci`
 * (exatamente a recuperação usada ao vivo em #5571, sem perda de dado).
 *
 * `scripts/node-modules-loop-alarm.ts` é quem faz o I/O (lstat/readlink do
 * `node_modules` real do checkout principal) e usa este módulo pra decidir
 * SE/O-QUE alarmar — mesmo molde de `scripts/lib/robots-txt-drift-check.ts`/
 * `scripts/lib/worker-drift-check.ts`.
 *
 * Escopo (#5571 proposta, item 2): só este alarme de sanity. Item 1 (regra
 * documental — nunca `npm ci`/`npm install` no checkout principal) vive em
 * `context/overnight-dispatch-rules.md` §3. Item 3 (guard/restart do
 * `Diaria-Studio-Server`) ficou de fora — maior escopo, follow-up separado.
 */
import { dirname, isAbsolute, normalize, resolve as resolvePath } from "node:path";

export type SymlinkLoopStatus =
  /** `node_modules` não existe, ou existe como diretório normal (não symlink). */
  | "ok"
  /** `node_modules` é um symlink cujo alvo resolve pro PRÓPRIO path do symlink — loop auto-referente. */
  | "loop"
  /** `node_modules` é um symlink mas o alvo não pôde ser lido (readlink falhou). */
  | "unresolved";

export interface SymlinkLoopInput {
  /** Path absoluto de `node_modules` (o path checado, não o que ele aponta). */
  nodeModulesPath: string;
  /** `true` se `node_modules` existe e é um symlink (lstat — NÃO segue o link, seguro mesmo se já for um loop). */
  isSymlink: boolean;
  /** Alvo cru do symlink (`fs.readlinkSync`, também não segue o link), ou `null` se não é symlink ou a leitura falhou. */
  linkTarget: string | null;
}

export interface SymlinkLoopEvaluation {
  status: SymlinkLoopStatus;
  /** Alvo do symlink já resolvido pra path absoluto (relativo ao diretório-pai de `nodeModulesPath` quando o alvo lido é relativo), ou `null` quando `status === "ok"` sem symlink / `"unresolved"`. */
  resolvedTarget: string | null;
  message: string;
}

/** Compara dois paths ABSOLUTOS já normalizados ignorando um único
 * separador final redundante — alguns mecanismos de symlink/junction (ex:
 * junction do Windows, achado no self-review do #5571) podem devolver o
 * alvo lido com um separador a mais no fim; sem essa tolerância, um loop
 * genuíno passaria por "ok" só por causa da formatação do path devolvido
 * pelo SO, não por ele apontar pra outro lugar de verdade. */
function sameResolvedPath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  return strip(a) === strip(b);
}

/**
 * Pura — avalia se `input.nodeModulesPath` é um symlink auto-referente.
 * "Auto-referente" = o alvo resolvido (absolutizado contra o diretório-pai
 * de `node_modules` quando o alvo lido é relativo) é EXATAMENTE igual ao
 * próprio path de `node_modules` — o caso real do achado #5571
 * (`node_modules -> /home/vjpixel/diaria-studio/node_modules`, o mesmo
 * diretório apontando pra si mesmo).
 *
 * Não tenta seguir cadeias de symlink mais longas (A -> B -> A) — fora do
 * escopo do achado original, que era sempre um link direto a si mesmo; um
 * loop indireto ainda quebraria `npx tsx` do mesmo jeito, mas detectar esse
 * caso exigiria `fs.realpathSync` (que por sua vez PODE lançar `ELOOP` num
 * loop de verdade — outra fonte de I/O que este módulo, propositalmente
 * puro, não faz).
 */
export function evaluateNodeModulesSymlink(input: SymlinkLoopInput): SymlinkLoopEvaluation {
  const nodeModulesPath = normalize(input.nodeModulesPath);

  if (!input.isSymlink) {
    return { status: "ok", resolvedTarget: null, message: `${nodeModulesPath} não é um symlink — ok.` };
  }

  if (!input.linkTarget) {
    return {
      status: "unresolved",
      resolvedTarget: null,
      message: `${nodeModulesPath} é um symlink, mas o alvo não pôde ser lido.`,
    };
  }

  const resolvedTarget = normalize(
    isAbsolute(input.linkTarget) ? input.linkTarget : resolvePath(dirname(nodeModulesPath), input.linkTarget),
  );

  if (sameResolvedPath(resolvedTarget, nodeModulesPath)) {
    return {
      status: "loop",
      resolvedTarget,
      message:
        `${nodeModulesPath} é um symlink AUTO-REFERENTE — aponta pra ${resolvedTarget} (o próprio caminho). ` +
        "Recuperação: rm node_modules && npm ci (ver #5571).",
    };
  }

  return {
    status: "ok",
    resolvedTarget,
    message: `${nodeModulesPath} é um symlink normal, aponta pra ${resolvedTarget} (não é loop).`,
  };
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

export interface NodeModulesLoopAlarmState {
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyNodeModulesLoopAlarmState(): NodeModulesLoopAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint estável do achado (inclui o alvo resolvido — se o
 * link mudar de alvo mas continuar em loop por outro motivo, re-alarma). */
export function nodeModulesLoopFindingKey(
  evaluation: Pick<SymlinkLoopEvaluation, "status" | "resolvedTarget">,
): string {
  return `${evaluation.status}:${evaluation.resolvedTarget ?? "-"}`;
}

/** Pura — `true` quando o status indica algo que merece alarme/issue: loop
 * confirmado OU symlink com alvo ILEGÍVEL (`readlink` falhou). Achado do
 * self-review do #5571 (silent-failure-hunter): um `node_modules` cujo
 * alvo não pôde ser lido já é, ele mesmo, uma anomalia no checkout (quebra
 * `npx tsx`/`npm` na prática do mesmo jeito que o loop confirmado quebra)
 * — só `status === "loop"` teria certeza absoluta da CAUSA raiz, mas
 * `"unresolved"` já é sinal suficiente pra investigar, não só um
 * `console.log` que ninguém vê. */
export function isNodeModulesLoopPending(evaluation: Pick<SymlinkLoopEvaluation, "status">): boolean {
  return evaluation.status === "loop" || evaluation.status === "unresolved";
}

/** Pura — avança o cursor. `lastAlarmedFingerprint: null` quando não há
 * achado pendente nesta checagem (re-arma pra próxima ocorrência), mesmo
 * padrão de `advanceRobotsDriftState`/`advanceState` (worker-drift-check). */
export function advanceNodeModulesLoopAlarmState(
  evaluation: SymlinkLoopEvaluation,
  now: Date,
): NodeModulesLoopAlarmState {
  return {
    lastAlarmedFingerprint: isNodeModulesLoopPending(evaluation) ? nodeModulesLoopFindingKey(evaluation) : null,
    lastCheckedAt: now.toISOString(),
  };
}

/** Pura — `true` quando há achado pendente (loop ou alvo ilegível) E o
 * fingerprint difere do último já alarmado. */
export function shouldAlarmNodeModulesLoop(
  state: NodeModulesLoopAlarmState,
  evaluation: SymlinkLoopEvaluation,
): boolean {
  if (!isNodeModulesLoopPending(evaluation)) return false;
  return nodeModulesLoopFindingKey(evaluation) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `buildRobotsDriftAlarmEmail`). `issueRef` (#5339, opcional) cita
 * a issue reconciliada pro achado; `undefined` (dry-run, ou wiring ainda não
 * chamado) omite a citação sem quebrar nada. */
export function buildNodeModulesLoopAlarmEmail(
  evaluation: SymlinkLoopEvaluation,
  nodeModulesPath: string,
  now: Date = new Date(),
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const isLoop = evaluation.status === "loop";
  const subject = isLoop
    ? "[diar.ia.br] node_modules virou symlink auto-referente no checkout principal"
    : "[diar.ia.br] node_modules é um symlink com alvo ilegível no checkout principal";

  const lines: string[] = [
    "O alarme de sanity `Diaria-Node-Modules-Loop-Alarm`",
    "(`scripts/node-modules-loop-alarm.ts`) detectou que node_modules do",
    isLoop
      ? "checkout principal compartilhado virou um symlink AUTO-REFERENTE (aponta"
      : "checkout principal compartilhado é um symlink cujo ALVO NÃO PÔDE SER LIDO",
    isLoop
      ? "pra si mesmo) — o mesmo sintoma do achado #5571."
      : "(readlink falhou) — sintoma correlato ao loop auto-referente do achado #5571 (#5571 self-review).",
    "",
    `Path: ${nodeModulesPath}`,
    `Detalhe: ${evaluation.message}`,
    "",
    ...(isLoop
      ? [
          "Qualquer npx tsx/npm/node neste checkout vai falhar com FilesystemLoop /",
          '"Too many levels of symbolic links", tipicamente sem stdout e com exit code opaco.',
        ]
      : [
          "Um symlink cujo alvo não pode ser lido já indica um problema no",
          "filesystem do checkout (permissão, corrupção, ou uma condição de",
          "corrida no meio de uma gravação) — investigar antes que vire o loop",
          "completo, mesmo sem certeza absoluta ainda de que é o mesmo padrão.",
        ]),
    "",
    "Recuperação (mesma usada ao vivo em #5571, sem perda de dado):",
    `  rm ${nodeModulesPath} && npm ci`,
    "  (rodar dentro do checkout principal — nunca num worktree, que tem o próprio node_modules isolado)",
    "",
    "Causa provável: dois processos npm install/ci concorrentes escrevendo no",
    "MESMO node_modules do checkout principal — normalmente porque uma sessão",
    "rodou npm ci/install FORA de worktree isolado, violando a convenção",
    "(CLAUDE.md / context/overnight-dispatch-rules.md §3 'Bootstrap do worktree').",
  ];

  if (issueRef) {
    lines.push(
      "",
      issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`,
    );
  }

  lines.push("", `(alarme automático — checagem rodou em ${now.toISOString()})`);

  return { subject, body: lines.join("\n") };
}
