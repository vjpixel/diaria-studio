/**
 * scripts/lib/onedrive-sync-alarm.ts (#5548, item 3)
 *
 * Lógica PURA do alarme de sync do OneDrive parado — achado ao vivo em
 * 17/08/2026 (#5548): o serviço `onedrive.service` (systemd --user, máquina
 * `helios`) morreu silenciosamente (`Active: inactive (dead)`, exit
 * status=0 depois de ~7 dias no ar) e ficou 17h parado sem que ninguém
 * percebesse — `systemd` não reinicia uma unit que saiu com exit 0, então
 * nada sinalizou o problema. `data/` (junction/symlink pro OneDrive) continua
 * sendo um diretório local funcional com o daemon morto — nada falha
 * visivelmente, só o sync entre máquinas para. Isso causou o skip silencioso
 * da #5526 numa rodada overnight que dependia de um arquivo escrito por
 * outra máquina.
 *
 * ─── Existe um SEGUNDO detector de sync degradado (#7300) ──────────────
 *
 * `assessCrossMachineSyncFreshness` (`scripts/lib/session-registry.ts`,
 * #7169) cobre a mesma classe de falha por outro caminho — nasceu citando
 * como motivação "onedrive.service morreu em silêncio no helios por 73min,
 * sem alarme", que é literalmente o domínio deste módulo. Os dois são
 * úteis e NÃO devem ser fundidos (um é síncrono no momento da decisão de
 * merge; o outro roda agendado, independente de haver sessão) — mas quem
 * investigar "o sync estava fora?" precisa saber que há duas fontes, e por
 * que elas podem discordar sobre a mesma janela de tempo:
 *
 * | | este alarme | `assessCrossMachineSyncFreshness` |
 * |---|---|---|
 * | quando roda | agendado, independente de sessão | síncrono, no `merge-lock-acquire` |
 * | o que observa | `systemctl is-active` + mtime do canário | `lastHeartbeat` de sessão de OUTRA máquina |
 * | limiar | 6h (`--tolerance-hours`, default) | 10min (`CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS`) |
 * | efeito | e-mail/issue | aviso no terminal de quem vai mergear |
 *
 * **A discordância esperada vem do fator ~36 entre os limiares**, e é
 * assimétrica: uma janela de 20min de sync morto acende o aviso de lá e
 * deixa ESTE alarme em silêncio (dentro da tolerância). O inverso — este
 * alarme aceso e o aviso de lá mudo — acontece quando não há sessão de
 * outra máquina registrada: aquela função só enxerga sync através de
 * heartbeat alheio, e sem peer não tem o que medir. Nenhum dos dois é "o
 * certo"; um silêncio de qualquer um dos lados nunca é evidência de sync
 * saudável.
 *
 * Dois sinais INDEPENDENTES, mesmo padrão de `clarice-postmaster-alarm.ts`
 * (dois checks numa mesma execução, cada achado com fingerprint próprio):
 *
 *   1. **Estado do serviço** — `systemctl --user is-active onedrive` (I/O
 *      feito pelo caller, `scripts/onedrive-sync-alarm.ts`; só leitura,
 *      nunca muta o serviço — ver guard de blast radius no script). Só
 *      alarma quando o serviço está confirmadamente `inactive`/`failed`;
 *      `unknown` (systemctl ausente — sessão cloud sem OneDrive instalado,
 *      ou qualquer erro de consulta) é tratado como "não é possível
 *      verificar", nunca como "está parado" — fail-soft honesto, mesmo
 *      padrão de `scheduled-task-status.ts`.
 *
 *   2. **Canário de frescor** — `data/.onedrive-sync-canary.json` — a cada
 *      execução, o alarme LÊ o conteúdo/mtime EXISTENTE do canário (escrito
 *      por uma execução anterior, possivelmente desta mesma máquina ou, no
 *      futuro, de uma máquina peer que também escreva seu lado) e só DEPOIS
 *      sobrescreve com o timestamp atual desta máquina (side A). Se o
 *      canário não mudou há mais que `toleranceMs`, isso é sinal de
 *      staleness — mesmo com o serviço reportando `active` (rede degradada
 *      sem o daemon detectar, por exemplo). Ausência total do arquivo (1ª
 *      execução, ou `data/` nunca sincronizado) é tratada como `"missing"`,
 *      distinto de `"stale"` — não alarma sozinho na 1ª execução (não é
 *      staleness, é ausência de baseline), mas é logado.
 *
 * **Limitação honesta (documentada em `docs/onedrive-sync-setup.md`):** com
 * uma única máquina escrevendo o canário (`helios`, hoje o único host
 * 24/7 rodando alarmes deste repo), o canário detecta primariamente "este
 * timer está rodando + `data/` é gravável" — não prova por si só que outra
 * máquina RECEBEU a escrita via OneDrive. Combinado com o check de serviço
 * (sinal 1), a dupla cobre o cenário real do #5548 (serviço morto e
 * ninguém percebendo) mesmo sem um peer canário do lado Windows.
 */

export type OnedriveServiceState = "active" | "inactive" | "failed" | "unknown";

/**
 * Pure — interpreta a saída de `systemctl --user is-active onedrive`
 * (stdout trimmed + exit code, ambos vindos do caller via `execFileSync`
 * capturado com try/catch). `systemctl is-active` imprime o estado em
 * stdout mesmo quando o exit code é != 0 (ex: `inactive` sai com status 3,
 * `failed` com status 3 também) — por isso o parse prioriza o CONTEÚDO de
 * stdout sobre o exit code puro.
 */
export function parseSystemctlIsActiveOutput(stdout: string, exitCode: number | null): OnedriveServiceState {
  const value = stdout.trim();
  if (value === "active") return "active";
  if (value === "inactive") return "inactive";
  if (value === "failed") return "failed";
  // "unknown", "activating", "deactivating", string vazia (ENOENT/erro de
  // consulta), unit inexistente ("could not be found") — tudo que não é um
  // dos 3 estados nomeados acima vira "unknown": fail-soft, nunca inventa
  // "parado" a partir de um valor que este parser não reconhece.
  return "unknown";
}

// ---------------------------------------------------------------------------
// Canário de frescor
// ---------------------------------------------------------------------------

export interface OnedriveSyncCanary {
  /** ISO timestamp de quando esta máquina escreveu por último. */
  writtenAt: string;
  /** Identificador da máquina que escreveu (`os.hostname()` do caller) —
   * só informativo/auditoria, não usado na decisão pura hoje (side A único). */
  machineId: string;
}

export function buildOnedriveSyncCanary(now: Date, machineId: string): OnedriveSyncCanary {
  return { writtenAt: now.toISOString(), machineId };
}

export type CanaryFreshnessVerdict = "fresh" | "stale" | "missing";

/**
 * Pure — decide o veredito de frescor a partir do MTIME do arquivo de
 * canário como estava ANTES desta execução sobrescrevê-lo (I/O — `fs.statSync`
 * — feito pelo caller antes de chamar `buildOnedriveSyncCanary`/reescrever).
 * `previousMtime === null` → arquivo nunca existiu (1ª execução, ou `data/`
 * não sincronizado ainda) → `"missing"`, nunca `"stale"` (ausência de
 * baseline não é a mesma coisa que staleness detectada).
 */
export function evaluateCanaryFreshness(
  previousMtime: Date | null,
  now: Date,
  toleranceMs: number,
): CanaryFreshnessVerdict {
  if (previousMtime === null) return "missing";
  const ageMs = now.getTime() - previousMtime.getTime();
  return ageMs <= toleranceMs ? "fresh" : "stale";
}

// ---------------------------------------------------------------------------
// Veredito combinado
// ---------------------------------------------------------------------------

export type OnedriveSyncAlarmVerdict =
  | "ok"
  | "alarm-service-down"
  | "alarm-canary-stale"
  | "canary-missing-baseline";

export interface OnedriveSyncAlarmEvaluation {
  verdict: OnedriveSyncAlarmVerdict;
  serviceState: OnedriveServiceState;
  canaryFreshness: CanaryFreshnessVerdict;
}

/**
 * Pure — combina os dois sinais independentes. Ordem de prioridade: serviço
 * confirmadamente parado (`inactive`/`failed`) é o achado mais direto do
 * #5548 e vence sozinho; canário `stale` alarma mesmo com serviço `active`
 * OU `unknown` (cobre o caso "daemon reporta ativo mas parou de sincronizar
 * de fato", e o caso "não dá pra checar o serviço nesta máquina, mas o
 * arquivo compartilhado parou de mudar"). `unknown` + `fresh`/`missing` →
 * `"ok"` (nada de errado detectado) ou `"canary-missing-baseline"` (achado
 * informativo, não alarma — ver `shouldSendOnedriveSyncAlarm`).
 */
export function evaluateOnedriveSyncAlarm(
  serviceState: OnedriveServiceState,
  canaryFreshness: CanaryFreshnessVerdict,
): OnedriveSyncAlarmEvaluation {
  if (serviceState === "inactive" || serviceState === "failed") {
    return { verdict: "alarm-service-down", serviceState, canaryFreshness };
  }
  if (canaryFreshness === "stale") {
    return { verdict: "alarm-canary-stale", serviceState, canaryFreshness };
  }
  if (canaryFreshness === "missing") {
    return { verdict: "canary-missing-baseline", serviceState, canaryFreshness };
  }
  return { verdict: "ok", serviceState, canaryFreshness };
}

/** Verdicts que representam um achado real (dispara e-mail/issue) — exclui
 * `"ok"` e `"canary-missing-baseline"` (informativo, nunca alarma sozinho). */
export function isAlarmingVerdict(verdict: OnedriveSyncAlarmVerdict): boolean {
  return verdict === "alarm-service-down" || verdict === "alarm-canary-stale";
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por verdict "ativo" (não reenvia
// enquanto o MESMO problema persistir; reenvia se o veredito mudar, ex:
// service-down → canary-stale, ou volta a "ok" e piora de novo depois).
// ---------------------------------------------------------------------------

export interface OnedriveSyncAlarmState {
  lastAlarmedVerdict: OnedriveSyncAlarmVerdict | null;
}

export function emptyOnedriveSyncAlarmState(): OnedriveSyncAlarmState {
  return { lastAlarmedVerdict: null };
}

export function shouldSendOnedriveSyncAlarm(
  evaluation: OnedriveSyncAlarmEvaluation,
  state: OnedriveSyncAlarmState,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  return state.lastAlarmedVerdict !== evaluation.verdict;
}

export function markOnedriveSyncAlarmed(verdict: OnedriveSyncAlarmVerdict): OnedriveSyncAlarmState {
  return { lastAlarmedVerdict: verdict };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

function verdictMessage(evaluation: OnedriveSyncAlarmEvaluation): string {
  switch (evaluation.verdict) {
    case "alarm-service-down":
      return (
        `O serviço onedrive.service (systemd --user) está "${evaluation.serviceState}" — o sync entre ` +
        `máquinas parou. \`data/\` continua sendo um diretório local funcional (nada falha visivelmente), ` +
        `só as escritas param de propagar pra outra ponta. Religar: \`systemctl --user restart onedrive\` ` +
        `(NUNCA rodado por este alarme — só leitura; a religada é ação manual do editor).`
      );
    case "alarm-canary-stale":
      return (
        `O canário data/.onedrive-sync-canary.json não muda há mais tempo que a tolerância configurada — ` +
        `mesmo com o serviço reportando "${evaluation.serviceState}". Pode indicar sync degradado sem o ` +
        `daemon detectar, ou a task deste alarme parada de rodar.`
      );
    default:
      return `Estado: verdict=${evaluation.verdict}, service=${evaluation.serviceState}, canary=${evaluation.canaryFreshness}.`;
  }
}

export function buildOnedriveSyncAlarmEmail(
  evaluation: OnedriveSyncAlarmEvaluation,
  issueLine: string,
): { subject: string; body: string } {
  return {
    subject: `⚠️ OneDrive sync: ${evaluation.verdict}`,
    body:
      `${verdictMessage(evaluation)}\n\n` +
      `Achado automático de \`Diaria-OneDrive-Sync-Alarm\` (\`scripts/onedrive-sync-alarm.ts\`, #5548).${issueLine}`,
  };
}
