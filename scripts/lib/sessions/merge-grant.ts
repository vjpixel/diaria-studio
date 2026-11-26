/**
 * scripts/lib/sessions/merge-grant.ts (#14004)
 *
 * Autorização de merge local: `selfAuthorizeMerge`, concessão de janela
 * (`grantMergeWindow`), leitura do grant vivo e `consumeMergeGrant`.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { join } from "node:path";
import { isSyncConflictCopyName } from "../sync-conflict-copy.ts";
import { DEFAULT_ISSUE_REPO, normalizeRepoSlug } from "../issue-repos.ts";
import {
  type ActiveSessionRecord,
  hasMergeAuthorityKind,
  isCoordinatorKind,
  MERGE_GRANT_TTL_MS,
  type MergeGrant,
  type SelfAuthorizedMerge,
  type SessionKind,
  type SessionRecord,
} from "./types.ts";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  findExistingSessionFileAnyKind,
  listSessionJsonFiles,
  machineTag,
  readJsonSafe,
  recoverAnchorFromOrphanBackups,
  sessionFilePath,
  sessionGroupBackupPaths,
  sessionsDir,
  warnAnchorRecoveredFromOrphanBackups,
  writeJsonSafeWithCas,
} from "./store.ts";
import { listActiveSessions } from "./registry.ts";
import { readMergeGrantConsumptions, recordMergeGrantConsumption, withLedgerConsumption } from "./merge-grant-ledger.ts";

// ─── Concessão de janela de merge (#6296) ──────────────────────────────────

export type SelfAuthorizeMergeReason =
  | "authorized"
  | "reason-required"
  | "no-active-coordinator"
  | "responsive-coordinator-active"
  | "caller-is-coordinator"
  | "session-not-registered";

export interface SelfAuthorizeMergeResult {
  ok: boolean;
  reason: SelfAuthorizeMergeReason;
  record?: SelfAuthorizedMerge;
  /** Populado só em `responsive-coordinator-active` — os kinds das
   * coordenadoras que NÃO são `continuo` e por isso continuam alcançáveis
   * via `grant-merge` normal. */
  coordinatorKinds?: SessionKind[];
}

/**
 * Auto-autoriza UM merge quando a sessão chamadora está bloqueada pelo guard
 * do #5716 e não há NENHUMA coordenadora ativa capaz de conceder `grant-merge`
 * (#7303) — só `continuo` (cron, não conversa) está ativa.
 *
 * Escopo deliberadamente ESTREITO — as 4 recusas existem pra nunca abrir mão
 * de nenhuma proteção que já vale pra uma rodada supervisionada normal:
 *
 * - **`no-active-coordinator`** — sem coordenadora nenhuma ativa, `gh pr
 *   merge` nem seria bloqueado pelo guard (#5716 só bloqueia havendo rodada
 *   ativa) — não há nada pra contornar.
 * - **`caller-is-coordinator`** — quem chama já É uma coordenadora
 *   registrada, já tem direito de mergear por si (via `isCoordinator` no
 *   guard); auto-autorizar seria decorativo.
 * - **`responsive-coordinator-active`** — existe pelo menos UMA coordenadora
 *   `overnight`/`develop` ativa (kind que CONVERSA). O caminho normal
 *   (`grant-merge` dela) continua sendo o único — este mecanismo não é um
 *   atalho pra evitar pedir, é a saída só quando pedir é estruturalmente
 *   impossível. Isto também é o que impede uma sessão bloqueada por uma
 *   rodada `develop` normal (o caso que o #5716 protege) de se
 *   auto-autorizar só porque, entre várias coordenadoras ativas, uma delas
 *   por acaso é `continuo`.
 * - **`session-not-registered`** — a auto-autorização é gravada no PRÓPRIO
 *   record da sessão chamadora (nunca no de uma coordenadora — inverso de
 *   `grantMergeWindow`), e ela precisa já ter um arquivo em
 *   `data/sessions/` (escrito pelo beacon na 1ª chamada de ferramenta desta
 *   sessão). Praticamente sempre verdade no momento em que `gh pr merge` já
 *   foi tentado (o próprio comando bloqueado já passou pelo beacon antes) —
 *   registrado como recusa explícita, não suposto.
 *
 * `reason` é OBRIGATÓRIO (não-vazio) — nunca uma auto-autorização silenciosa,
 * conforme a Direção 2 da issue ("registro explícito de que agiu sem
 * concessão"). O guard mecânico (`.claude/hooks/block-gh-pr-merge-subagent.mjs`)
 * trata a auto-autorização viva exatamente como `merge_grant`: destrava
 * IDENTIDADE, nunca TEMPO — quem a usa ainda precisa adquirir o merge lock
 * antes de `gh pr merge` de fato suceder (`merge-lock-acquire`), então a
 * serialização com um merge que a própria `continuo` esteja fazendo naquele
 * instante continua garantida pelo lock.
 */
export function selfAuthorizeMerge(
  repoRoot: string,
  sessionId: string,
  opts: { reason: string; pr?: number; repo?: string; now?: string },
): SelfAuthorizeMergeResult {
  const reason = (opts.reason ?? "").trim();
  if (reason === "") return { ok: false, reason: "reason-required" };
  // #10618: repo presente e ilegível nunca é gravado cru — erro alto.
  const selfAuthRepo = requireWriterRepo(opts.repo);

  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const coordinators = listActiveSessions(repoRoot, Number.isFinite(nowMs) ? nowMs : Date.now()).filter(
    (s) => isCoordinatorKind(s.kind) && !s.stale,
  );
  if (coordinators.length === 0) return { ok: false, reason: "no-active-coordinator" };
  if (coordinators.some((s) => s.sessionId === sessionId)) return { ok: false, reason: "caller-is-coordinator" };
  // #7546 — a pergunta certa é "alcançável?" (`attended !== false`), não
  // "qual o kind?". Antes desta issue, `kind !== "continuo"` assumia que
  // todo overnight/develop conversa — falso pra uma rodada rodando como
  // task agendada/dispatched, sem interlocutor do outro lado (o próprio
  // cenário que motivou o #7303: PR pronto, sem caminho de merge). Ver a
  // docstring de `attended` em `SessionRecord`.
  //
  // **#7743 — a precedência do hook em `block-gh-pr-merge-subagent.mjs`
  // (`onlyUnreachableCoordinatorsActive`) é espelhada aqui.** As duas
  // cópias da mesma lógica divergiam: o hook caía na leitura antiga por
  // `kind` quando o campo `attended` estava ausente (record pré-#7546,
  // `registerSession` só passou a gravá-lo agora), enquanto esta função
  // contava `undefined !== false` como responsiva. Mesmo record dava
  // vereditos opostos — a auto-autorização era concedida e o `gh pr merge`
  // real seguia bloqueado. Precedência por coordenadora, nesta ordem:
  //   1. `attended === false` → inalcançável (sinal explícito, `--unattended`);
  //   2. `attended === true` → alcançável;
  //   3. campo AUSENTE → cai na leitura antiga, `kind === "continuo"` decide
  //      (preserva o comportamento pré-#7546 pros registros já em disco).
  const responsiveCoordinators = coordinators.filter(
    (s) => !(s.attended === false || (s.attended === undefined && s.kind === "continuo")),
  );
  if (responsiveCoordinators.length > 0) {
    const responsiveKinds = [...new Set(responsiveCoordinators.map((s) => s.kind))];
    return { ok: false, reason: "responsive-coordinator-active", coordinatorKinds: responsiveKinds };
  }

  const path = findExistingSessionFileAnyKind(repoRoot, sessionId);
  if (!path) return { ok: false, reason: "session-not-registered" };

  const record: SelfAuthorizedMerge = {
    reason,
    authorizedAt: now,
    ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
    // #10618: só grava quando NÃO é o default — record legado e novo do
    // diaria-studio ficam idênticos.
    ...(selfAuthRepo !== DEFAULT_ISSUE_REPO ? { repo: selfAuthRepo } : {}),
  };
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("selfAuthorizeMerge: sessão sumiu entre a leitura e a escrita");
      return { ...current, self_authorized_merge: record, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.self_authorized_merge?.authorizedAt === record.authorizedAt,
  );
  return { ok: true, reason: "authorized", record };
}

export type GrantMergeReason =
  | "granted"
  | "self-grant-refused"
  | "not-a-coordinator"
  | "grantee-is-coordinator-refused"
  | "no-op-session-missing"
  | "live-grant-would-be-overwritten"
  | "pr-already-granted-elsewhere";

export interface GrantMergeResult {
  ok: boolean;
  reason: GrantMergeReason;
  grant?: MergeGrant;
  /**
   * #7857: só presente quando `reason === "granted"`. `true` quando
   * `grantedTo` bate o `sessionId` de alguma sessão ATIVA no registry no
   * momento da concessão; `false` quando não bate nenhuma. `undefined` para
   * qualquer outro `reason` (recusa não concede nada, não há beneficiário
   * pra reconhecer).
   *
   * Não bloqueia nada — a sessão-alvo pode legitimamente ainda não ter se
   * registrado (concessão "adiantada", torcendo pra ela aparecer antes do
   * TTL expirar). `false` é só o sinal que falta pro CLI avisar sobre a
   * confusão medida ao vivo no #7857: `--granted-to` recebendo o nome CURTO
   * que `ListAgents` exibe (ex: `02d2e8`) em vez do `session_id` real (UUID
   * completo) — `check-merge-grant --session-id <id-errado>` respondia
   * `granted: true` (o registro existe, gravado pro id errado), mas o gate
   * real do #5716 (que compara o `session_id` do processo chamador contra
   * `merge_grant.grantedTo` — `visible_to_merge_gate` é o campo que
   * `check-merge-grant` DERIVA desse resultado, nunca o inverso) nunca
   * reconhecia o id errado, e a concessão ficava invisível pro guard sem
   * nenhum aviso até alguém comparar `check-merge-grant` com e sem
   * `--session-id` manualmente.
   */
  granteeRecognized?: boolean;
}

/**
 * Concede a janela de merge a OUTRA sessão (#6296) — gravada como campo
 * `merge_grant` no record da coordenadora que concede, nunca num arquivo
 * novo.
 *
 * Motivação medida (260826, `300`): o protocolo da Parte F foi executado à
 * mão e cada passo funcionou — `ListAgents` achou o peer, `SendMessage`
 * entregou, o peer conferiu colisão por arquivo nos 3 PRs dele, concedeu a
 * janela, e o `merge-lock-acquire` deu ok. **E o `gh pr merge` foi bloqueado
 * assim mesmo**, porque o guard do #5716 compara `session_id` contra
 * `data/sessions/` e sessão interativa não está lá. A conversa chegou a
 * acordo e não teve efeito nenhum sobre o mecanismo. Esta função é o que dá
 * ao acordo uma representação que o guard consegue ler.
 *
 * Duas recusas, ambas estruturais:
 * - **`self-grant-refused`** — ninguém concede a si mesmo. É o que preserva a
 *   propriedade que o #5716 protege (a coordenadora decide quando entra
 *   merge) em vez de contorná-la; sem isso, "conceder a si mesma" seria só um
 *   relabel com outro nome.
 * - **`not-a-coordinator`** — só overnight/develop concedem
 *   (`MERGE_AUTHORITY_SESSION_KINDS`). `continuo` deixou de qualificar no
 *   #7702: é rodada, mas não decide merge. O nome do motivo ficou por
 *   retrocompatibilidade de quem faz match nele.
 */
/**
 * Repo normalizado de uma concessão/auto-autorização (#10618): ausente =
 * diaria-studio; presente e ilegível = `null` (não casa com repo nenhum).
 */
export function grantRepoOf(grant: { repo?: string } | undefined | null): string | null {
  if (!grant || grant.repo === undefined) return DEFAULT_ISSUE_REPO;
  return normalizeRepoSlug(grant.repo);
}

/** Repo de um escritor de concessão (#10618): ausente = default; ilegível = erro. */
function requireWriterRepo(repo: string | undefined): string {
  if (repo === undefined) return DEFAULT_ISSUE_REPO;
  const slug = normalizeRepoSlug(repo);
  if (!slug) throw new Error(`repo inválido na concessão: "${repo}" (esperado owner/name) (#10618)`);
  return slug;
}

export function grantMergeWindow(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  grantedTo: string,
  meta: { pr?: number; repo?: string; tag?: string; now?: string; force?: boolean } = {},
): GrantMergeResult {
  // #7702: quem concede janela precisa ter AUTORIDADE DE MERGE, não só ser
  // uma rodada. `continuo` deixou de qualificar — ela nunca decidiu merge
  // nenhum (`continuo-pr-review.sh` é a única autoridade do fluxo dela), e
  // conceder o que não se tem era o que sustentava a ficção de que pedir
  // janela a um cron era um caminho real.
  if (!hasMergeAuthorityKind(kind)) return { ok: false, reason: "not-a-coordinator" };
  if (grantedTo === sessionId || grantedTo.trim() === "") return { ok: false, reason: "self-grant-refused" };

  // #6303 review cruzado (P1·a): recusa conceder a OUTRA COORDENADORA.
  //
  // Até aqui só o CONCEDENTE era validado (`isCoordinatorKind(kind)`) e só a
  // auto-concessão era barrada. O kind de `grantedTo` nunca era olhado —
  // então `grant-merge --granted-to {sessionId de outra coordenadora}`
  // sucedia. Combinado com o ramo de concessão que, no guard, saía ANTES da
  // checagem de lock, isso deixava a coordenadora beneficiada pular a
  // serialização. Concessão cruzada (A→B, B→A) e ambas mergeavam sem lock.
  //
  // A concessão existe pra dar caminho a quem NÃO tem identidade de
  // coordenadora — tipicamente uma sessão interativa. Coordenadora já tem o
  // direito por si; o que ela precisa respeitar é o merge lock, e conceder
  // entre pares seria justamente um jeito de contorná-lo.
  //
  // Defesa em profundidade, não redundância: esta recusa responde "quem pode
  // receber"; a reordenação no guard responde "quando pode usar". Fechar só
  // uma das duas deixaria a outra metade aberta a um `merge_grant` gravado
  // por outro caminho.
  const grantee = listActiveSessions(repoRoot).find((s) => s.sessionId === grantedTo);
  if (grantee && isCoordinatorKind(grantee.kind)) {
    return { ok: false, reason: "grantee-is-coordinator-refused" };
  }

  const tag = meta.tag ?? machineTag();
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const now = meta.now ?? new Date().toISOString();
  let existingRecord = readJsonSafe<SessionRecord>(path);
  if (!existingRecord) {
    // #6999 (fix 2): a leitura CRUA do arquivo real não é a pergunta certa —
    // a concedente pode ter perdido a âncora num lost-update com a sessão
    // viva (#7002) e ter o estado inteiro só nas cópias de conflito. Recusar
    // aqui devolvia `no-op (sessão inexistente)` pra uma coordenadora ATIVA,
    // com o agravante de a mensagem não dizer QUAL das duas sessões em jogo
    // (concedente × beneficiária) não foi encontrada — ver a mensagem
    // dedicada no CLI. Reconstrói pelo mesmo caminho do `claim-issue`
    // (#7003); só recusa quando não há nem âncora nem cópia viva.
    const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
    if (!recovered) return { ok: false, reason: "no-op-session-missing" };
    warnAnchorRecoveredFromOrphanBackups("grant-merge", sessionId, path, recovered);
    existingRecord = readJsonSafe<SessionRecord>(path);
  }

  const grant: MergeGrant = { grantedTo, grantedBy: sessionId, grantedAt: now };
  if (meta.pr !== undefined) grant.pr = meta.pr;
  // #10618: só grava o repo não-default; repo presente e ilegível é erro alto
  // (nunca gravado cru — o leitor não saberia a que repo ele pertence).
  const grantRepo = requireWriterRepo(meta.repo);
  if (grantRepo !== DEFAULT_ISSUE_REPO) grant.repo = grantRepo;

  // #7043 achado 1 (1º caminho) — `merge_grant` é campo ÚNICO no record da
  // concedente: uma 2ª chamada de `grant-merge` (outro beneficiário e/ou
  // outro PR) SOBRESCREVE a concessão anterior em silêncio. Medido ao vivo:
  // concedi janela pra PR #6955 e, em seguida, pra #6959, à mesma sessão — o
  // registro ficou só com a 2ª, e `grant-merge` devolveu `ok` NAS DUAS vezes.
  // A beneficiária original nunca soube que perdeu a janela. Recusa (a menos
  // que `meta.force`) quando a concessão que SERIA sobrescrita ainda está
  // viva e tem IDENTIDADE DIFERENTE da nova (outro `grantedTo` e/ou outro
  // `pr`) — reconceder a MESMA identidade (só renovar `grantedAt`) não perde
  // informação nenhuma e continua permitido sem `--force`.
  // #11113: a anterior pode ter sido consumida do outro lado (registro da beneficiária).
  const priorGrant = withLedgerConsumption(existingRecord?.merge_grant, readMergeGrantConsumptions(repoRoot));
  const nowMs = Date.parse(now);
  if (
    !meta.force &&
    priorGrant &&
    isMergeGrantLive(priorGrant, priorGrant.grantedTo, nowMs) &&
    (priorGrant.grantedTo !== grantedTo ||
      priorGrant.pr !== grant.pr ||
      // #10618: mesmo PR em OUTRO repo é outra concessão — sobrescrever perderia a anterior.
      grantRepoOf(priorGrant) !== grantRepo)
  ) {
    return { ok: false, reason: "live-grant-would-be-overwritten", grant: priorGrant };
  }

  // #7043 achado 1 (2º caminho) — duas coordenadoras concedendo janela pra a
  // MESMA PR não se enxergam: cada concessão mora no record de QUEM concede,
  // nunca num lugar comparável entre coordenadoras. Medido ao vivo: duas
  // coordenadoras concederam janela pra a mesma PR (#6988) com 20s de
  // diferença — nenhuma soube da outra, e `grant-merge` respondeu `ok` nas
  // duas. Recusa (a menos que `meta.force`) quando OUTRA coordenadora ativa
  // já tem concessão viva pra este mesmo PR — só se aplica quando `meta.pr`
  // foi informado (concessão genérica, sem PR, não tem identidade de PR pra
  // colidir).
  if (!meta.force && meta.pr !== undefined) {
    const clashing = listActiveSessions(repoRoot).find(
      (s) =>
        s.sessionId !== sessionId &&
        isCoordinatorKind(s.kind) &&
        s.merge_grant?.pr === meta.pr &&
        // #10618: o mesmo número em repos diferentes é outro PR.
        grantRepoOf(s.merge_grant) === grantRepo &&
        isMergeGrantLive(s.merge_grant, s.merge_grant?.grantedTo ?? "", nowMs),
    );
    if (clashing) {
      return { ok: false, reason: "pr-already-granted-elsewhere", grant: clashing.merge_grant };
    }
  }

  // #6952: CAS em vez de read-modify-write solto. O concedente é uma sessão
  // ATIVA e o beacon reescreve este registro a cada chamada de ferramenta —
  // sem isto o grant é apagado pelo próprio concedente antes de a
  // beneficiária consome-lo (exato sintoma do #6952).
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("grant-merge: sessão sumiu entre a leitura e a escrita");
      return { ...current, merge_grant: grant, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.merge_grant?.grantedAt === grant.grantedAt,
  );
  // #7857: reusa o `grantee` já resolvido acima (checagem de
  // grantee-is-coordinator) — não bloqueia (a beneficiária pode ainda não
  // ter se registrado), só informa pro CLI decidir se avisa.
  return { ok: true, reason: "granted", grant, granteeRecognized: grantee !== undefined };
}

/**
 * `true` quando `grant` ainda vale em `now`: não consumida, dentro do TTL, e
 * emitida para `sessionId`. Pura. Timestamp ilegível nunca vale (nunca
 * concede sobre estado que não se conseguiu interpretar).
 */
export function isMergeGrantLive(
  grant: MergeGrant | undefined,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_GRANT_TTL_MS,
): boolean {
  if (!grant || grant.grantedTo !== sessionId) return false;
  if (grant.consumedAt) return false;
  if (grant.grantedTo === grant.grantedBy) return false; // auto-concessão nunca vale, mesmo se gravada à mão
  const grantedMs = Date.parse(grant.grantedAt);
  if (!Number.isFinite(grantedMs)) return false;
  const ageMs = now - grantedMs;
  // Idade negativa além da tolerância de skew: não trata como válida por
  // tempo indefinido, mas também não rouba — mesma disciplina do merge lock.
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= ttlMs;
}

/**
 * Espelha `isMergeGrantLive` para `SelfAuthorizedMerge` (#7303) — dentro do
 * TTL (mesmo `MERGE_GRANT_TTL_MS`, com a mesma tolerância de clock skew).
 * Sem checagem de `consumedAt`/identidade cruzada porque não existem aqui
 * (ver docblock de `SelfAuthorizedMerge`: não há terceiro a proteger contra).
 * Pura.
 */
export function isSelfAuthorizedMergeLive(
  record: SelfAuthorizedMerge | undefined,
  now: number = Date.now(),
  ttlMs: number = MERGE_GRANT_TTL_MS,
): boolean {
  if (!record) return false;
  const authorizedMs = Date.parse(record.authorizedAt);
  if (!Number.isFinite(authorizedMs)) return false;
  const ageMs = now - authorizedMs;
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= ttlMs;
}

/**
 * De ONDE veio a concessão vencedora da união do #6952 (#6972).
 *
 * - `"real"` — existe num arquivo REAL de `data/sessions/` (sem sufixo
 *   `-safeBackup-`). É o único caso que o gate de merge
 *   (`.claude/hooks/block-gh-pr-merge-subagent.mjs`) enxerga e honra.
 * - `"backup"` — vive SÓ em cópia(s) de conflito do OneDrive. `check-merge-grant`
 *   responde `granted: true` (a união do #6952 a encontra) e o gate bloqueia
 *   assim mesmo — de propósito, ver abaixo.
 */
export type MergeGrantSource = "real" | "backup";

/** Duas cópias da MESMA concessão — tripla de identidade do #6952. */
function isSameMergeGrant(a: MergeGrant | undefined, b: MergeGrant): boolean {
  return (
    a !== undefined && a.grantedBy === b.grantedBy && a.grantedTo === b.grantedTo && a.grantedAt === b.grantedAt
  );
}

/**
 * Responde a pergunta do #6972: esta concessão existe em algum arquivo REAL —
 * isto é, o gate de merge vai enxergá-la?
 *
 * Varre `data/sessions/` com a MESMA regra do gate (ignora todo nome que
 * contenha `-safeBackup-`), em vez de derivar o path do record mesclado: o
 * gate não sabe de kind nem de identidade fundida, ele lê arquivo por arquivo.
 * Reproduzir a regra dele é o que faz esta resposta valer alguma coisa.
 */
function mergeGrantLivesInRealFile(repoRoot: string, grant: MergeGrant): boolean {
  const dir = sessionsDir(repoRoot);
  for (const name of listSessionJsonFiles(repoRoot)) {
    if (isSyncConflictCopyName(name)) continue;
    const record = readJsonSafe<SessionRecord>(join(dir, name));
    if (isSameMergeGrant(record?.merge_grant, grant)) return true;
  }
  return false;
}

/**
 * Procura, entre as sessões COORDENADORAS ativas, uma concessão viva emitida
 * pra `sessionId` (#6296). Retorna a concessão + quem concedeu + a PROVENIÊNCIA
 * dela (#6972), ou `null`.
 *
 * **#6972 — por que a proveniência precisa sair daqui.** Desde o #6952,
 * `mergeSessionRecords` UNE o `merge_grant` entre o arquivo real e as cópias de
 * conflito do OneDrive, então uma concessão que vive só numa cópia passou a ser
 * ENCONTRADA — e `check-merge-grant` responde `granted: true`. Mas o gate
 * (`block-gh-pr-merge-subagent.mjs`) continua cego a `-safeBackup-` por decisão
 * deliberada do review da PR #6969: *grant é autorização, e autorização não se
 * infere de detrito* — uma cópia de conflito é artefato de uma corrida de sync,
 * não algo que alguém escreveu. Resultado: a beneficiária lê `granted: true`,
 * tenta o merge e é bloqueada, e o diagnóstico natural ("a coordenadora não
 * concedeu" / "expirou") é falso nas duas leituras. Custou o tempo de duas
 * sessões em 01/09/2026.
 *
 * O conserto alinha o diagnóstico PARA BAIXO — quem afirma a concessão avisa
 * que ela não será honrada. O gate **não muda**; esta função só passa a dizer
 * de onde o grant veio, e `check-merge-grant` transforma isso no aviso
 * acionável ("peça reconcessão à coordenadora").
 */
export function findLiveMergeGrant(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
): { grant: MergeGrant; grantedBy: ActiveSessionRecord; source: MergeGrantSource } | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (!isCoordinatorKind(session.kind)) continue;
    if (session.stale) continue;
    if (isMergeGrantLive(session.merge_grant, sessionId, now)) {
      const grant = session.merge_grant!;
      return {
        grant,
        grantedBy: session,
        source: mergeGrantLivesInRealFile(repoRoot, grant) ? "real" : "backup",
      };
    }
  }
  return null;
}

/**
 * Marca a concessão como consumida (uso único, #6296). Chamado logo após o
 * `gh pr merge` que a janela autorizou. Retorna `false` quando não havia
 * concessão viva pra consumir — nunca lança.
 */
export function consumeMergeGrant(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  opts: { localTag?: string } = {},
): boolean {
  const found = findLiveMergeGrant(repoRoot, sessionId, now);
  if (!found) return false;
  const owner = found.grantedBy;
  const path = sessionFilePath(repoRoot, owner.kind, owner.machineTag, owner.sessionId);
  const consumedAt = new Date(now).toISOString();
  const grant = found.grant;

  // #11113: coordenadora de OUTRA máquina — nunca escrever no arquivo dela.
  // O consumo vai para o registro da beneficiária (ver bloco acima).
  if (owner.machineTag !== (opts.localTag ?? machineTag())) {
    return recordMergeGrantConsumption(repoRoot, grant, consumedAt, now) && findLiveMergeGrant(repoRoot, sessionId, now) === null;
  }

  // #6952 (achado do review INDEPENDENTE da PR): consumir percorre o GRUPO
  // inteiro — arquivo real + toda cópia `-safeBackup-*` —, não só o real.
  //
  // Por que isto passou a ser obrigatório NESTA PR e não era antes: a 2ª
  // metade fez `mergeSessionRecords` UNIR o `merge_grant`, então uma concessão
  // que vive só numa cópia de conflito do OneDrive passou a ser ENCONTRADA por
  // `findLiveMergeGrant`. Consertar a leitura sem consertar a escrita cria um
  // estado novo e pior que o bug original: um grant **encontrável e
  // inconsumível**, vivo pelo TTL inteiro, porque o `consumedAt` era gravado
  // só no arquivo real — que nesse cenário nem carrega o grant. Reproduzido ao
  // vivo: `findLiveMergeGrant` acha, `consumeMergeGrant` devolve `false`, e o
  // grant continua vivo na leitura seguinte.
  //
  // O molde é o do `unclaimIssue` (#6567) logo acima, pelo mesmo motivo e com
  // a mesma disciplina: reescrita cirúrgica de UM campo por cópia, nunca o
  // registro mesclado inteiro por cima de um arquivo do grupo.
  //
  // O retorno passa a afirmar a PÓS-CONDIÇÃO, não o número de escritas: só é
  // `true` se a concessão de fato deixou de estar viva. Um `true` com o grant
  // ainda vivo seria exatamente a mentira que abre uso duplo — o chamador
  // acredita que a janela fechou e ela não fechou.
  // Type guard (não só boolean): os dois call sites precisam do estreitamento
  // pra mexer no grant sem `!`.
  const identityMatches = (g: MergeGrant | undefined): g is MergeGrant =>
    g !== undefined &&
    g.grantedTo === grant.grantedTo &&
    g.grantedBy === grant.grantedBy &&
    g.grantedAt === grant.grantedAt;

  let stamped = false;
  for (const groupPath of [path, ...sessionGroupBackupPaths(repoRoot, path)]) {
    const record = readJsonSafe<SessionRecord>(groupPath);
    // Nada a fazer neste arquivo: ilegível, sem grant, com OUTRA concessão, ou
    // já consumido. Nenhum dos casos é erro — a concessão pode viver em
    // qualquer subconjunto das cópias.
    if (!record || !identityMatches(record.merge_grant) || record.merge_grant?.consumedAt) continue;
    try {
      writeJsonSafeWithCas(
        groupPath,
        (current) => {
          // RECONFERE a identidade DENTRO do lock. O `identityMatches` acima
          // roda antes de pedir o lock, e entre uma coisa e outra a concessão
          // pode ter sido trocada por OUTRA — viva, legítima e de outro
          // beneficiário. Sem esta checagem, carimbamos `consumedAt` na janela
          // alheia e a matamos em silêncio, devolvendo `ok`: o mesmo dano que
          // esta função existe pra evitar, por outra porta.
          //
          // Não basta `if (!current?.merge_grant)`: "existe UMA concessão" não
          // é "existe A concessão que eu vim consumir".
          const onDiskGrant = current?.merge_grant;
          if (!current || !identityMatches(onDiskGrant)) {
            throw new Error(
              "consumeMergeGrant: a concessão neste arquivo mudou entre a conferência e o lock — não é a que veio ser consumida",
            );
          }
          return { ...current, merge_grant: { ...onDiskGrant, consumedAt } };
        },
        // `verify` também confere identidade: só `consumedAt` presente diria
        // "alguma coisa foi carimbada", não "a NOSSA foi".
        (onDisk) =>
          identityMatches(onDisk?.merge_grant) && onDisk?.merge_grant?.consumedAt === consumedAt,
      );
      stamped = true;
    } catch {
      // Uma cópia que falhou não impede consumir as outras — e são as OUTRAS
      // que mantêm a concessão viva na leitura. A pós-condição abaixo é quem
      // decide o desfecho.
    }
  }

  // Fail-open no contrato ("nunca lança"), mas honesto no valor. As DUAS
  // condições são necessárias, e cada uma cobre uma mentira diferente:
  //
  // - `stamped`: carimbamos de fato pelo menos uma cópia da NOSSA concessão.
  //   Sem isto, o caso "a concessão foi trocada por outra enquanto
  //   esperávamos o lock" devolveria `true` — `findLiveMergeGrant` para ESTE
  //   sessionId volta `null` (a janela viva agora é de outro beneficiário), e
  //   reportaríamos "janela consumida" sem ter consumido nada.
  // - a releitura: a janela realmente fechou. Sem isto, uma cópia que falhou
  //   de gravar deixaria a concessão viva e ainda assim diríamos `ok`.
  //
  // Um `true` em qualquer dos dois casos é a mentira que abre uso duplo: o
  // chamador acredita que a janela fechou e age sobre isso.
  return stamped && findLiveMergeGrant(repoRoot, sessionId, now) === null;
}
