/**
 * plan-safe-backup.ts (#10579)
 *
 * Recuperação de `plan.json` de rodada (overnight/develop/continuo) quando o
 * OneDrive o substitui por uma cópia de conflito `plan-{máquina}-safeBackup-{NNNN}.json`.
 *
 * **Também a cópia do rclone bisync (#12380).** Depois do cutover de `data/`
 * para o Google Drive (#12359) a cópia de conflito vira `plan.json.conflictN`
 * (sufixo depois da extensão, ver `sync-conflict-copy.ts`). Com o
 * `--conflict-resolve newer` atual o vencedor mantém o nome `plan.json` e só
 * o perdedor ganha o sufixo (caso `backup-alongside` abaixo); sem a flag, as
 * duas versões ganham sufixo e o `plan.json` some (caso `restored`). Os dois
 * formatos entram no mesmo contrato; `seq` é o `NNNN` do OneDrive ou o `N`
 * do rclone.
 *
 * ## O incidente (rodada 261019d)
 *
 * No meio da Fase 1, `data/overnight/261019d/plan.json` sumiu e no lugar
 * apareceu `plan-300-safeBackup-0001.json` — o OneDrive resolve conflito de
 * sync renomeando a versão local. Todo leitor do plano trata "arquivo
 * ausente" como "rodada não existe": o resolver de path (`createFsPlanProbe`)
 * devolveria `mode: "fresh"` e o coordenador reescreveria um plano novo por
 * cima do estado vivo (`resume_state`, ondas, timestamps de dispatch); o
 * watchdog deixaria de ver a rodada. Só não houve perda porque o coordenador
 * notou e copiou o backup à mão.
 *
 * ## Contrato de `recoverPlanFromSafeBackup(planPath)`
 *
 * - **Sem backup no diretório** → `status: "clean"`, nada muda.
 * - **`plan.json` ausente + ≥1 backup JSON válido** → copia o backup mais
 *   recente (maior mtime; empate → maior `NNNN`) para `plan.json` (escrita
 *   atômica), preservando o mtime do backup no arquivo restaurado (senão uma
 *   rodada abandonada pareceria ativa pro watchdog, que mede atividade por
 *   mtime). O backup NÃO é apagado — fica como evidência/auditoria.
 *   `status: "restored"`.
 * - **`plan.json` ausente + só backups ilegíveis** → `status: "unrecoverable"`,
 *   nada escrito (nunca promove JSON truncado a plano vivo).
 * - **`plan.json` presente + backups ao lado** → `status: "backup-alongside"`,
 *   só aviso: o backup pode carregar estado divergente que o plano vivo não
 *   tem, e escolher entre os dois sem saber qual é o mais completo é
 *   julgamento — fica para o coordenador (merge manual).
 * - **Exceção (#13687): cópia que está estritamente À FRENTE do plano vivo**
 *   → `status: "promoted"`. O plano é regravado várias vezes por minuto
 *   durante a rodada e o bisync pode deixar o lado errado com o nome
 *   `plan.json` (mtime empatado, relógio). Quando uma cópia válida tem TUDO o
 *   que o vivo tem em `timeline` e `pr` de cada issue (mesmos valores) e algo
 *   a mais, o vivo é só uma versão anterior da mesma sequência de escritas:
 *   ficar com ele faria o coordenador perder `merged`/`pr` e re-despachar
 *   issue já mergeada. Nesse caso (e só nele) a cópia vira `plan.json`, e o
 *   plano vivo anterior é guardado como `plan.json.conflict{N}` (próximo N
 *   livre) antes da troca, para auditoria. Qualquer divergência (valor
 *   diferente, `session_id` diferente, cada lado com algo que o outro não
 *   tem) segue em `backup-alongside`.
 *   **Todos os campos contam, não só `timeline`/`pr` (#13703):** os demais
 *   campos de topo (`waves`, `ci_queue_reawaits`, `state_changed_pending`,
 *   `resume_state`, ...) e de cada issue (`status`, `motivo`, ...) do vivo
 *   precisam estar iguais na cópia, ou ausentes/`null` no vivo (subconjunto:
 *   objeto com as mesmas chaves e valores, array com o vivo como prefixo).
 *   Um `status` ou contador diferente já é divergência: escolher entre os dois
 *   lados seria julgamento, e o vivo fica. Antes da troca o vivo é relido; se
 *   mudou desde a comparação (outro escritor no meio), nada é promovido. O
 *   rebaixado mantém o mtime original do vivo e o restauro (plano ausente)
 *   prefere a cópia que domina as outras, não só a de maior mtime: o
 *   rebaixado nunca volta como "backup mais novo" por cima da versão à frente.
 *
 * Fail-soft: erro de I/O ao listar o diretório → `clean` (o leitor segue com
 * o comportamento de antes, que já trata ausência).
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { issueKeyOfPlanEntry } from "./issue-key.ts";
import { normalizeIssues } from "./plan-issues-normalize.ts";
import { RCLONE_CONFLICT_SUFFIX_RE, rcloneConflictOriginalName } from "./sync-conflict-copy.ts";

/** `plan-300-safeBackup-0001.json` → captura o número da cópia. Aceita
 * qualquer nome de máquina (inclusive com hífen) entre `plan-` e `-safeBackup-`. */
const PLAN_SAFE_BACKUP_RE = /^plan-.+-safeBackup-(\d+)\.json$/;

/** Número da cópia de conflito de `plan.json` (`NNNN` do OneDrive ou `N` do
 * rclone, #12380); `null` se `name` não é cópia de conflito do plano. */
function planConflictSeq(name: string): number | null {
  const onedrive = PLAN_SAFE_BACKUP_RE.exec(name);
  if (onedrive) return Number(onedrive[1]);
  if (rcloneConflictOriginalName(name) === "plan.json") {
    return Number(RCLONE_CONFLICT_SUFFIX_RE.exec(name)![1]);
  }
  return null;
}

/** Cópia de conflito de `plan.json`: `plan-{máquina}-safeBackup-NNNN.json`
 * (OneDrive) ou `plan.json.conflictN` (rclone bisync, #12380). */
export function isPlanSafeBackupName(name: string): boolean {
  return planConflictSeq(name) !== null;
}

export interface PlanSafeBackupFile {
  path: string;
  name: string;
  seq: number;
  mtimeMs: number;
}

/** Lista as cópias de conflito do plano em `dir` (`plan-*-safeBackup-*.json`
 * e `plan.json.conflictN`, #12380), mais recente primeiro. */
export function findPlanSafeBackups(dir: string): PlanSafeBackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PlanSafeBackupFile[] = [];
  for (const name of names) {
    const seq = planConflictSeq(name);
    if (seq === null) continue;
    const path = join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    out.push({ path, name, seq, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.seq - a.seq);
}

export type PlanSafeBackupRecovery =
  | { status: "clean" }
  | { status: "restored"; from: string; backups: string[] }
  | { status: "unrecoverable"; backups: string[] }
  | { status: "backup-alongside"; backups: string[] }
  | { status: "promoted"; from: string; demotedTo: string; backups: string[] };

/** Marcos por issue que a dominância compara (#13687): `timeline` e `pr`. */
interface PlanProgressFacts {
  timeline: Map<string, Map<string, string>>;
  pr: Map<string, string>;
}

function planProgressFacts(plan: Record<string, unknown>): PlanProgressFacts {
  const timeline = new Map<string, Map<string, string>>();
  const pr = new Map<string, string>();
  for (const entry of normalizeIssues<Record<string, unknown>>(plan)) {
    const key = issueKeyOfPlanEntry(entry);
    if (!key) continue;
    const tl = entry?.timeline;
    if (tl && typeof tl === "object" && !Array.isArray(tl)) {
      const events = new Map<string, string>();
      for (const [event, ts] of Object.entries(tl as Record<string, unknown>)) {
        if (ts !== null && ts !== undefined && ts !== "") events.set(event, String(ts));
      }
      if (events.size > 0) timeline.set(key, events);
    }
    const rawPr = entry?.pr;
    if ((typeof rawPr === "number" && Number.isFinite(rawPr)) || (typeof rawPr === "string" && rawPr.trim() !== "")) {
      pr.set(key, String(rawPr).trim().replace(/^#/, ""));
    }
  }
  return { timeline, pr };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * `true` quando o valor do vivo está contido no da cópia (#13703): `null`/
 * ausente no vivo cabe em qualquer coisa; objeto → cada chave do vivo
 * contida na mesma chave da cópia; array → o vivo é prefixo da cópia
 * (elemento a elemento, com a mesma regra); escalar → igual. Pura.
 */
function liveValueContainedIn(live: unknown, copy: unknown): boolean {
  if (live === null || live === undefined) return true;
  if (Array.isArray(live)) {
    if (!Array.isArray(copy) || copy.length < live.length) return false;
    return live.every((v, i) => liveValueContainedIn(v, copy[i]));
  }
  if (isPlainObject(live)) {
    if (!isPlainObject(copy)) return false;
    return Object.keys(live).every((k) => liveValueContainedIn(live[k], copy[k]));
  }
  return Object.is(live, copy);
}

/** Campos de cada issue que a dominância trata à parte: identidade (`number`,
 * `ref`, já usados na chave) e os marcos normalizados por `planProgressFacts`. */
const ISSUE_FIELDS_COMPARED_APART = new Set(["number", "ref", "timeline", "pr"]);

/**
 * `true` quando todo campo do vivo fora de `timeline`/`pr` está contido na
 * cópia (#13703): os de topo (exceto `issues`) e os de cada issue, pareadas
 * pela chave. Issue do vivo ausente da cópia → `false`. Pura.
 */
function planOtherFieldsContained(live: Record<string, unknown>, copy: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(live)) {
    if (k === "issues") continue;
    if (!liveValueContainedIn(v, copy[k])) return false;
  }
  const copyByKey = new Map<string, Record<string, unknown>>();
  for (const entry of normalizeIssues<Record<string, unknown>>(copy)) {
    const key = isPlainObject(entry) ? issueKeyOfPlanEntry(entry) : null;
    if (key) copyByKey.set(key, entry);
  }
  for (const entry of normalizeIssues<Record<string, unknown>>(live)) {
    if (!isPlainObject(entry)) continue;
    const key = issueKeyOfPlanEntry(entry);
    if (!key) continue;
    const other = copyByKey.get(key);
    if (!other) return false;
    for (const [field, v] of Object.entries(entry)) {
      if (ISSUE_FIELDS_COMPARED_APART.has(field)) continue;
      if (!liveValueContainedIn(v, other[field])) return false;
    }
  }
  return true;
}

/**
 * `true` quando `copy` está estritamente à frente de `live` (#13687, #13703):
 * mesmo `session_id` (quando algum dos dois tem), cada marco de `timeline` e
 * cada `pr` do vivo aparece na cópia com o MESMO valor, todo outro campo do
 * vivo (topo e por issue) está contido na cópia, e a cópia tem ao menos um
 * marco ou `pr` que o vivo não tem. Pura.
 */
export function planCopyIsAheadOf(live: Record<string, unknown>, copy: Record<string, unknown>): boolean {
  if ((live.session_id ?? null) !== (copy.session_id ?? null)) return false;
  if (!planOtherFieldsContained(live, copy)) return false;
  const a = planProgressFacts(live);
  const b = planProgressFacts(copy);
  for (const [key, events] of a.timeline) {
    const other = b.timeline.get(key);
    if (!other) return false;
    for (const [event, ts] of events) if (other.get(event) !== ts) return false;
  }
  for (const [key, value] of a.pr) if (b.pr.get(key) !== value) return false;
  for (const [key, events] of b.timeline) {
    const mine = a.timeline.get(key);
    for (const event of events.keys()) if (!mine?.has(event)) return true;
  }
  for (const key of b.pr.keys()) if (!a.pr.has(key)) return true;
  return false;
}

function parsePlanObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Próximo `plan.json.conflictN` livre em `dir`. */
function nextFreeConflictPath(dir: string): string {
  for (let n = 1; ; n++) {
    const p = join(dir, `plan.json.conflict${n}`);
    if (!existsSync(p)) return p;
  }
}

function isValidPlanJson(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Detecta cópias de conflito (OneDrive ou rclone, #12380) ao lado de `planPath` e, se o plano
 * vivo sumiu, restaura a mais recente. Ver contrato no docblock do módulo.
 * Só age quando o basename é `plan.json`.
 */
export function recoverPlanFromSafeBackup(planPath: string): PlanSafeBackupRecovery {
  if (basename(planPath) !== "plan.json") return { status: "clean" };
  const backups = findPlanSafeBackups(dirname(planPath));
  if (backups.length === 0) return { status: "clean" };
  const backupPaths = backups.map((b) => b.path);

  if (existsSync(planPath)) return promoteCopyAheadOrWarn(planPath, backups, backupPaths);

  const b = pickRestoreCandidate(backups);
  if (b === null) return { status: "unrecoverable", backups: backupPaths };
  try {
    writeFileAtomic(planPath, b.raw);
  } catch {
    return { status: "unrecoverable", backups: backupPaths };
  }
  try {
    const mtime = new Date(b.mtimeMs);
    utimesSync(planPath, mtime, mtime);
  } catch {
    // mtime é refinamento (watchdog); o conteúdo já foi restaurado.
  }
  return { status: "restored", from: b.path, backups: backupPaths };
}

/**
 * Cópia a restaurar quando o plano sumiu (#13703): parte da válida de maior
 * mtime e troca por qualquer outra que esteja à frente dela
 * (`planCopyIsAheadOf`), até nenhuma estar. Sem isso, um vivo rebaixado numa
 * promoção anterior (`plan.json.conflictN`, atrasado mas com o mtime do vivo,
 * que no bisync `--conflict-resolve newer` é o maior) voltaria no lugar da
 * versão à frente. `null` se nenhuma cópia é um objeto JSON válido.
 */
function pickRestoreCandidate(
  backups: PlanSafeBackupFile[],
): { path: string; raw: string; mtimeMs: number } | null {
  const valid: { path: string; raw: string; mtimeMs: number; plan: Record<string, unknown> }[] = [];
  for (const b of backups) {
    const raw = isValidPlanJson(b.path);
    if (raw !== null) valid.push({ path: b.path, raw, mtimeMs: b.mtimeMs, plan: parsePlanObject(raw)! });
  }
  if (valid.length === 0) return null;
  let best = valid[0];
  // "À frente" é estrito (cada troca acrescenta marco), então o laço termina.
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of valid) {
      if (c !== best && planCopyIsAheadOf(best.plan, c.plan)) {
        best = c;
        changed = true;
      }
    }
  }
  return best;
}

/**
 * Plano vivo presente (#13687): promove a cópia válida mais à frente (ver
 * `planCopyIsAheadOf`), guardando antes o vivo como `plan.json.conflict{N}`.
 * Sem cópia à frente, ou se qualquer escrita falhar, fica o comportamento de
 * sempre (`backup-alongside`, vivo intocado).
 */
function promoteCopyAheadOrWarn(
  planPath: string,
  backups: PlanSafeBackupFile[],
  backupPaths: string[],
): PlanSafeBackupRecovery {
  const alongside: PlanSafeBackupRecovery = { status: "backup-alongside", backups: backupPaths };
  let liveRaw: string;
  let liveMtimeMs: number;
  try {
    liveRaw = readFileSync(planPath, "utf8");
    liveMtimeMs = statSync(planPath).mtimeMs;
  } catch {
    return alongside;
  }
  const live = parsePlanObject(liveRaw);
  if (live === null) return alongside;

  let best: { path: string; raw: string; plan: Record<string, unknown> } | null = null;
  for (const b of backups) {
    const raw = isValidPlanJson(b.path);
    if (raw === null) continue;
    const plan = parsePlanObject(raw)!;
    if (planCopyIsAheadOf(best?.plan ?? live, plan)) best = { path: b.path, raw, plan };
  }
  if (best === null) return alongside;

  const demotedTo = nextFreeConflictPath(dirname(planPath));
  try {
    writeFileAtomic(demotedTo, liveRaw);
  } catch {
    return alongside;
  }
  try {
    // #13703: o rebaixado guarda o mtime do vivo, não "agora" — senão vira a
    // cópia mais nova e o restauro (plano ausente) a escolheria.
    const mtime = new Date(liveMtimeMs);
    utimesSync(demotedTo, mtime, mtime);
  } catch {
    // mtime é refinamento; o restauro também ranqueia por dominância.
  }
  // #13703: relê o vivo logo antes da troca. Se outro escritor (log-event,
  // watchdog) gravou desde a comparação, a decisão foi sobre um conteúdo que
  // não existe mais: não promove e desfaz o rebaixado recém-criado.
  let currentRaw: string | null;
  try {
    currentRaw = readFileSync(planPath, "utf8");
  } catch {
    currentRaw = null;
  }
  if (currentRaw !== liveRaw) {
    try {
      unlinkSync(demotedTo);
    } catch {
      // cópia idêntica a uma versão antiga do vivo: inofensiva se ficar.
    }
    return alongside;
  }
  try {
    writeFileAtomic(planPath, best.raw);
  } catch {
    return alongside;
  }
  return { status: "promoted", from: best.path, demotedTo, backups: backupPaths };
}

/**
 * Leitura SOMENTE LEITURA da cópia de conflito (#11768): devolve o conteúdo
 * do `plan-*-safeBackup-*.json` válido mais recente ao lado de `planPath`,
 * sem gravar nada no disco. Para exibidores (statusline) que rodam a cada
 * ~30s em toda máquina e não podem virar escritores no `data/` sincronizado
 * pelo OneDrive — o restauro (`recoverPlanFromSafeBackup`) fica com os
 * leitores da própria rodada (coordenador, gates, run-nightly-chain).
 * `null` quando o basename não é `plan.json`, não há backup ou nenhum é um
 * objeto JSON válido.
 */
export function readLatestPlanSafeBackup(planPath: string): Record<string, unknown> | null {
  return findLatestValidPlanSafeBackup(planPath)?.plan ?? null;
}

/**
 * Mesmo critério de `readLatestPlanSafeBackup`, devolvendo também o arquivo e
 * o mtime da cópia lida — a statusline mede a idade da rodada pelo mtime
 * (`isStaleDevelopPlan`); sem `plan.json` em disco, a idade é a do backup
 * (o que o restauro de `recoverPlanFromSafeBackup` preservaria). Só leitura.
 */
export function findLatestValidPlanSafeBackup(
  planPath: string,
): { path: string; mtimeMs: number; plan: Record<string, unknown> } | null {
  if (basename(planPath) !== "plan.json") return null;
  for (const b of findPlanSafeBackups(dirname(planPath))) {
    const raw = isValidPlanJson(b.path);
    if (raw !== null) return { path: b.path, mtimeMs: b.mtimeMs, plan: JSON.parse(raw) as Record<string, unknown> };
  }
  return null;
}

/** Mensagem humana (stderr) para os status que exigem atenção; `null` em `clean`. */
export function describePlanSafeBackupRecovery(planPath: string, r: PlanSafeBackupRecovery): string | null {
  switch (r.status) {
    case "clean":
      return null;
    case "restored":
      return (
        `[plan-safe-backup] ${planPath} tinha sumido (conflito de sync) — restaurado de ${r.from}. ` +
        `Backup mantido; confira se as últimas escritas da rodada (dispatch, ondas) estão no plano (#10579).`
      );
    case "unrecoverable":
      return (
        `[plan-safe-backup] ${planPath} ausente e nenhuma cópia de conflito pôde ser restaurada (JSON inválido ou falha de escrita) ` +
        `(${r.backups.join(", ")}) — nada restaurado; recuperar à mão (#10579).`
      );
    case "backup-alongside":
      return (
        `[plan-safe-backup] cópia(s) de conflito de sync ao lado de ${planPath}: ${r.backups.join(", ")} — ` +
        `o plano vivo foi mantido; compare e mescle à mão se o backup tiver estado mais novo (#10579).`
      );
    case "promoted":
      return (
        `[plan-safe-backup] ${planPath} estava ATRÁS de uma cópia de conflito de sync (timeline/pr) — ` +
        `promovida ${r.from}; o plano anterior foi guardado em ${r.demotedTo} (#13687).`
      );
  }
}

/** Atalho para leitores: recupera e imprime o aviso em stderr. */
export function recoverPlanFromSafeBackupWithWarning(planPath: string): PlanSafeBackupRecovery {
  const r = recoverPlanFromSafeBackup(planPath);
  const msg = describePlanSafeBackupRecovery(planPath, r);
  if (msg) console.error(msg);
  return r;
}

/**
 * Resultado de `readPlanJson` (#11721). `missing` e `unreadable` nunca se
 * confundem com "plano vazio": quem consome decide falhar alto ou seguir
 * fail-soft, mas não pode tratar a ausência como "rodada sem PRs".
 */
export type PlanJsonRead =
  | { status: "ok"; plan: Record<string, unknown>; recovery: PlanSafeBackupRecovery }
  | { status: "missing"; message: string; recovery: PlanSafeBackupRecovery }
  | { status: "unreadable"; message: string; recovery: PlanSafeBackupRecovery };

/**
 * Leitor único de `plan.json` de rodada (#11721, recorrência da #10579 na
 * rodada 261030c). Antes de ler, tenta recuperar a cópia de conflito do
 * OneDrive (`plan-*-safeBackup-*.json`) ou do rclone (`plan.json.conflictN`,
 * #12380) e emite o aviso pelo `warn` (default
 * stderr). Depois:
 *
 * - plano presente e objeto JSON → `ok`;
 * - plano ausente (sem backup, ou backup irrecuperável) → `missing`, com a
 *   lista de backups na mensagem quando houver;
 * - JSON inválido ou não-objeto → `unreadable`.
 */
export function readPlanJson(
  planPath: string,
  opts: { warn?: (msg: string) => void } = {},
): PlanJsonRead {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const recovery = recoverPlanFromSafeBackup(planPath);
  const note = describePlanSafeBackupRecovery(planPath, recovery);
  if (note) warn(note);

  if (!existsSync(planPath)) {
    const backups = recovery.status === "unrecoverable" ? ` (cópias de conflito ilegíveis: ${recovery.backups.join(", ")})` : "";
    return { status: "missing", message: `plan.json não encontrado: ${planPath}${backups}`, recovery };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (err) {
    return { status: "unreadable", message: `plan.json ilegível (${planPath}): ${(err as Error).message}`, recovery };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", message: `plan.json não é um objeto JSON (${planPath})`, recovery };
  }
  return { status: "ok", plan: parsed as Record<string, unknown>, recovery };
}
