/**
 * scripts/lib/diaria/video-publish-authorization.ts (#12654, caminho A)
 *
 * Registro durável das autorizações de publicação dos vídeos da edição:
 * `_internal/video-publish-authorizations.json`. Cada autorização liga a
 * confirmação explícita do editor na conversa ("pode publicar") ao SHA-256 do
 * plano aprovado (`video-publish-plan.ts`) e vale para UM destino de UMA parte,
 * UMA vez.
 *
 * ## Ciclo (decisão do editor de 10/11/2026, caminho A)
 *
 * 1. **grant** (`video-publish-authorize.ts grant`, o coordenador logo depois do
 *    "pode publicar"): confere que o manifesto do dry-run em disco é o que o
 *    editor viu (hash), e grava uma autorização por destino executável da parte
 *    (lista positiva de ações, `isAuthorizableDestination`: os destinos que um
 *    publisher executa, inclusive o repost da página que o `--publish` entrega
 *    à fila do Worker; fora, o dono `timer-300`, autorizado pela config que o
 *    ligou, #11741, e os passos guiados que o publisher não executa).
 * 2. **consume** (o publisher, imediatamente antes do 1º efeito externo):
 *    recalcula o manifesto, confere a projeção de cada destino que vai agir
 *    contra a aprovada (com o modo/instante efetivo, decisão B), o comando
 *    efetivo contra o dono aprovado e a máquina contra a do grant, e marca as
 *    autorizações como consumidas ANTES de enviar qualquer coisa. Tudo ou
 *    nada: um destino sem autorização válida recusa a rodada inteira (exit 2,
 *    nada enviado).
 * 3. **invalidate** (o coordenador, sempre que uma chamada de publisher for
 *    interrompida/rejeitada, ou o editor disser "não"): derruba as ativas da
 *    parte e grava o evento. A invalidação vale mesmo sem nenhuma ativa (a
 *    rejeição pode chegar antes de o processo começar).
 * 4. **retry**: depois de uma invalidação ou de um consumo do destino, o grant
 *    novo só sai com releituras do registro gravadas
 *    (`video-publish-registry-status.ts AAMMDD --since ISO --record`) que cubram
 *    TODOS os eventos (cada um com uma releitura de `since <=` o evento e
 *    gravada depois dele: o `--since` vai até o evento mais antigo ainda não
 *    coberto), sem `unreadable`; destino que a releitura acusou como saído (ou
 *    saindo) não recebe autorização nova. Exceção única: o destino acusado só
 *    por estado incerto (marcador `pending` do upload do horizontal, marca de
 *    envio sem registro) que o editor conferiu na conta, com
 *    `--override-uncertain "{o que foi conferido}"`. O processo que consumiu a
 *    última autorização do destino precisa estar morto nesta máquina.
 *
 * ## Escopo por máquina
 *
 * O lock do registro (`withFileLock`) e a conferência do processo que consumiu
 * (`process.kill(pid, 0)`) só valem na máquina que gravou: o grant grava o
 * host e o consumo vindo de outro host é recusado. O registro sincronizado
 * pelo Drive entre máquinas não é exclusão mútua entre elas.
 *
 * ## Limitação de harness (#11741, documentada, sem promessa)
 *
 * A invalidação é COMUNICADA pelo coordenador. Uma rejeição no app que não
 * chega ao processo (o publisher já rodando segue vivo) não é detectada por
 * nada aqui: o que este registro garante é que (a) o processo só começa com
 * uma autorização ativa da mesma projeção do destino, consumida antes do 1º efeito, e (b) a
 * autorização não serve a uma 2ª execução. O processo sobrevivente é coberto
 * pela releitura do registro (#11741), não por esta trava. O caminho B
 * (evento da conversa via adaptador de harness) foi descartado pelo editor.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { withFileLock } from "../file-lock.ts";
import {
  commandMatchesOwner,
  destinationBindingSha256,
  diffManifests,
  isAuthorizableDestination,
  planSha256,
  type VideoPlanAction,
  type VideoPlanManifest,
  type VideoPlanOwner,
  type VideoPlanPart,
} from "./video-publish-plan.ts";

export const AUTHORIZATION_STORE_SCHEMA = "diaria-video-publish-authorizations/v1";
export const AUTHORIZATION_STORE_FILE = "_internal/video-publish-authorizations.json";

/** Veredito do `video-publish-registry-status.ts` (a releitura gravada com `--record`). */
export type RegistryCheckVerdict = "unreadable" | "registered-since" | "nothing-since" | "no-cutoff";

interface VideoPublishAuthorizationBase {
  id: string;
  part: VideoPlanPart;
  destination: string;
  plan_sha256: string;
  binding_sha256: string;
  /** `false` = o texto do destino não estava no plano: o vínculo é pelas fontes editoriais. */
  content_bound: boolean;
  owner: VideoPlanOwner;
  /** Ação do destino no plano aprovado (a task de um `pending_schedule` sai como `publish`). */
  approved_action: VideoPlanAction;
  /** Modo/instante efetivo aprovado (`"now"`, ISO ou `null`), decisão B. */
  effective_at: string | null;
  /** O texto da resposta do editor na conversa (prova da confirmação explícita). */
  confirmation: string;
  confirmed_at: string;
  /** Máquina do grant: o consumo de outra máquina é recusado (o lock é por máquina). */
  granted_host: string;
  /** Destino acusado por estado incerto que o editor conferiu (`--override-uncertain`). */
  override_uncertain?: string;
}

export interface ActiveVideoPublishAuthorization extends VideoPublishAuthorizationBase {
  status: "active";
}

export interface ConsumedVideoPublishAuthorization extends VideoPublishAuthorizationBase {
  status: "consumed";
  consumed_at: string;
  consumed_by: string;
  consumed_host: string;
  consumed_pid?: number;
}

export interface InvalidatedVideoPublishAuthorization extends VideoPublishAuthorizationBase {
  status: "invalidated";
  invalidated_at: string;
  invalidated_reason: string;
  /** `superseded` = trocada por aprovação nova antes de uso (não exige releitura do registro). */
  invalidated_kind: "explicit" | "superseded";
}

/** União discriminada por `status`: cada estado carrega só os campos que existem nele. */
export type VideoPublishAuthorization =
  | ActiveVideoPublishAuthorization
  | ConsumedVideoPublishAuthorization
  | InvalidatedVideoPublishAuthorization;

export const AUTHORIZATION_STATUSES = ["active", "consumed", "invalidated"] as const;

export type VideoPublishAuthorizationEvent =
  | { kind: "invalidated"; at: string; part: VideoPlanPart | "all"; reason: string; destinations: string[] }
  | {
      kind: "registry-check";
      at: string;
      since: string;
      verdict: RegistryCheckVerdict;
      registered: string[];
      /** Subconjunto de `registered` acusado só por estado incerto (marcador `pending`, marca de envio sem registro). */
      uncertain?: string[];
    };

type RegistryCheckEvent = Extract<VideoPublishAuthorizationEvent, { kind: "registry-check" }>;

export interface VideoPublishAuthorizationStore {
  schema: typeof AUTHORIZATION_STORE_SCHEMA;
  edition: string;
  authorizations: VideoPublishAuthorization[];
  events: VideoPublishAuthorizationEvent[];
  /** Manifestos aprovados por hash: a recusa por plano diferente mostra o que mudou. */
  approved_manifests: Record<string, VideoPlanManifest>;
}

/**
 * #12859: por que um destino foi recusado no consumo, em forma estruturada
 * (o alarme da task one-shot diz o destino e o campo que mudou sem reparsear
 * a mensagem). `timing` = instante fora do aprovado (task antes de X, `--now`
 * num destino agendado).
 */
export type AuthorizationRefusalKind =
  | "missing"
  | "consumed"
  | "invalidated"
  | "unknown-status"
  | "other-host"
  | "owner-mismatch"
  | "outside-plan"
  | "plan-changed"
  | "timing";

export interface AuthorizationRefusal {
  destination: string;
  kind: AuthorizationRefusalKind;
  /** A linha da recusa, sem o prefixo do destino. */
  message: string;
  /** `plan-changed`: os campos do plano que mudaram desde a aprovação (vazio = projeção diferente sem campo apontável). */
  changed?: string[];
  /** Dono aprovado na autorização mais recente do destino (ausente = nunca autorizado). */
  approved_owner?: VideoPlanOwner;
}

export type AuthResult<T> =
  | { ok: true; value: T; store: VideoPublishAuthorizationStore }
  | { ok: false; error: string; refusals?: AuthorizationRefusal[] };

export function emptyAuthorizationStore(edition: string): VideoPublishAuthorizationStore {
  return { schema: AUTHORIZATION_STORE_SCHEMA, edition, authorizations: [], events: [], approved_manifests: {} };
}

function clone(store: VideoPublishAuthorizationStore): VideoPublishAuthorizationStore {
  return JSON.parse(JSON.stringify(store)) as VideoPublishAuthorizationStore;
}

/** `true` se o processo `pid` ainda roda NESTA máquina (`EPERM` conta como vivo: mais seguro recusar). */
export function isPidAliveHere(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export function currentHost(): string {
  return hostname();
}

/** Destinos que recebem autorização: a lista positiva de `isAuthorizableDestination`. */
export function authorizableDestinations(m: VideoPlanManifest): string[] {
  return m.destinations.filter((d) => isAuthorizableDestination(m, d)).map((d) => d.id);
}

/** Instantes (consumo do destino, invalidação da parte) que exigem releitura do registro antes de nova autorização. */
function retryEvents(store: VideoPublishAuthorizationStore, part: VideoPlanPart, destination: string): string[] {
  const times: string[] = [];
  for (const a of store.authorizations) {
    if (a.part === part && a.destination === destination && a.status === "consumed") times.push(a.consumed_at);
  }
  for (const e of store.events) {
    if (e.kind === "invalidated" && (e.part === part || e.part === "all")) times.push(e.at);
  }
  return times;
}

function registryChecks(store: VideoPublishAuthorizationStore): RegistryCheckEvent[] {
  return store.events.filter((e): e is RegistryCheckEvent => e.kind === "registry-check");
}

/** A releitura mais recente que cobre o instante (`since <=` instante `<= at`); instante ilegível nunca é coberto. */
function latestCheckCovering(checks: readonly RegistryCheckEvent[], instant: string): RegistryCheckEvent | null {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) return null;
  let found: RegistryCheckEvent | null = null;
  for (const c of checks) {
    const at = Date.parse(c.at);
    const since = Date.parse(c.since);
    if (Number.isNaN(at) || Number.isNaN(since)) continue;
    if (since <= t && at >= t && (found === null || at >= Date.parse(found.at))) found = c;
  }
  return found;
}

export interface GrantInput {
  manifest: VideoPlanManifest;
  /** O hash que o editor viu no plano (impresso pelo dry-run). */
  planSha256: string;
  confirmation: string;
  now: Date;
  only?: readonly string[] | null;
  /** Máquina do grant (default: esta). */
  host?: string;
  /** Conferência do processo que consumiu (default: `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
  /** O editor conferiu na conta o destino acusado só por estado incerto (texto do que foi conferido). */
  overrideUncertain?: string | null;
}

/** Pure: confere a barreira de retry de um destino. `null` = pode autorizar; senão, o motivo. */
function retryRefusal(
  store: VideoPublishAuthorizationStore,
  m: VideoPlanManifest,
  dest: string,
  input: { host: string; isPidAlive: (pid: number) => boolean; overrideUncertain: string | null },
): string | null {
  const events = retryEvents(store, m.part, dest);
  if (!events.length) return null;
  const bad = events.find((t) => Number.isNaN(Date.parse(t)));
  if (bad !== undefined) return `${m.part}/${dest}: evento com instante ilegível (${JSON.stringify(bad)}) no registro de autorização: conferir o arquivo antes de qualquer nova autorização`;

  const lastConsumed = [...store.authorizations]
    .reverse()
    .find((a): a is ConsumedVideoPublishAuthorization => a.part === m.part && a.destination === dest && a.status === "consumed");
  if (lastConsumed) {
    if (lastConsumed.consumed_host !== input.host) {
      return `${m.part}/${dest}: a última autorização foi consumida na máquina ${lastConsumed.consumed_host}; o grant de retry roda nela (só lá dá para conferir se o processo ${lastConsumed.consumed_pid ?? "?"} morreu)`;
    }
    if (lastConsumed.consumed_pid !== undefined && input.isPidAlive(lastConsumed.consumed_pid)) {
      return `${m.part}/${dest}: o processo ${lastConsumed.consumed_pid} que consumiu a autorização de ${lastConsumed.confirmed_at} ainda está vivo nesta máquina: ele pode estar publicando agora. Esperar ele terminar e reler o registro (#11741)`;
    }
  }

  const checks = registryChecks(store);
  const sorted = [...events].sort((a, b) => Date.parse(a) - Date.parse(b));
  const uncovered = sorted.filter((t) => latestCheckCovering(checks, t) === null);
  if (uncovered.length) {
    return (
      `${m.part}/${dest}: houve consumo ou invalidação em ${uncovered.join(", ")} sem releitura do registro que cubra o evento; antes de nova autorização, releia o registro ` +
      `(npx tsx scripts/video-publish-registry-status.ts ${m.edition} --since ${uncovered[0]} --record: o --since vai até o evento mais antigo ainda não coberto) (#12654, #11741)`
    );
  }
  const used = new Set(sorted.map((t) => latestCheckCovering(checks, t)!));
  for (const check of used) {
    if (check.verdict !== "nothing-since" && check.verdict !== "registered-since") {
      return `${m.part}/${dest}: a releitura do registro de ${check.at} saiu ${check.verdict}: conferir as contas antes de qualquer nova autorização`;
    }
    if (check.registered.includes(dest)) {
      const uncertainOnly = (check.uncertain ?? []).includes(dest);
      if (uncertainOnly && input.overrideUncertain) continue;
      return (
        `${m.part}/${dest}: a releitura de ${check.at} acusou o destino como saído (ou saindo): relatar ao editor, nunca publicar de novo (#11741)` +
        (uncertainOnly
          ? `. Só estado incerto (marcador pending ou envio sem registro): depois de o editor conferir a conta e não achar o post, o grant aceita --override-uncertain "{o que foi conferido}"`
          : "")
      );
    }
  }
  return null;
}

/** Pure: grava as autorizações de uso único da parte para o plano aprovado. */
export function grantVideoPublishAuthorization(storeIn: VideoPublishAuthorizationStore, input: GrantInput): AuthResult<VideoPublishAuthorization[]> {
  const m = input.manifest;
  if (m.edition !== storeIn.edition) {
    return { ok: false, error: `o plano é da edição ${m.edition}, não da ${storeIn.edition}: nada autorizado` };
  }
  const actual = planSha256(m);
  if (actual !== input.planSha256.trim().toLowerCase()) {
    return {
      ok: false,
      error: `o plano em disco (sha256 ${actual}) não é o aprovado (${input.planSha256}): refaça o dry-run, mostre o plano ao editor e peça o "pode publicar" de novo`,
    };
  }
  const confirmation = input.confirmation.trim();
  if (!confirmation) {
    return { ok: false, error: "sem a confirmação explícita do editor (--confirmation com o texto da resposta dele): nada autorizado (#11741)" };
  }
  if (m.media.video_sha256 === null) {
    return { ok: false, error: "o plano não tem o vídeo (video_sha256 null): baixe o vídeo, refaça o dry-run e aprove esse plano" };
  }
  const authorizable = authorizableDestinations(m);
  let targets = authorizable;
  if (input.only && input.only.length) {
    const unknown = input.only.filter((d) => !authorizable.includes(d));
    if (unknown.length) return { ok: false, error: `--only fora dos destinos autorizáveis do plano: ${unknown.join(", ")} (autorizáveis: ${authorizable.join(", ") || "nenhum"})` };
    targets = [...input.only];
  }
  if (!targets.length) return { ok: false, error: "o plano não tem destino que um publisher execute: nada a autorizar" };

  const host = input.host ?? currentHost();
  const overrideUncertain = input.overrideUncertain?.trim() || null;
  for (const dest of targets) {
    const refusal = retryRefusal(storeIn, m, dest, { host, isPidAlive: input.isPidAlive ?? isPidAliveHere, overrideUncertain });
    if (refusal) return { ok: false, error: refusal };
  }

  const store = clone(storeIn);
  const nowIso = input.now.toISOString();
  const granted: VideoPublishAuthorization[] = [];
  for (const dest of targets) {
    store.authorizations = store.authorizations.map((a): VideoPublishAuthorization =>
      a.part === m.part && a.destination === dest && a.status === "active"
        ? { ...a, status: "invalidated", invalidated_at: nowIso, invalidated_reason: "substituída por nova aprovação", invalidated_kind: "superseded" }
        : a,
    );
    const d = m.destinations.find((x) => x.id === dest)!;
    const auth: ActiveVideoPublishAuthorization = {
      id: `${m.part}:${dest}:${nowIso}`,
      part: m.part,
      destination: dest,
      plan_sha256: actual,
      binding_sha256: destinationBindingSha256(m, dest, { contentBound: d.content !== null })!,
      content_bound: d.content !== null,
      owner: d.owner,
      approved_action: d.action,
      effective_at: d.effective_at,
      confirmation,
      confirmed_at: nowIso,
      granted_host: host,
      ...(overrideUncertain ? { override_uncertain: overrideUncertain } : {}),
      status: "active",
    };
    store.authorizations.push(auth);
    granted.push(auth);
  }
  store.approved_manifests[actual] = m;
  return { ok: true, value: granted, store };
}

export interface ConsumeInput {
  edition: string;
  /** O manifesto recalculado agora, logo antes do 1º efeito externo. */
  manifest: VideoPlanManifest;
  /** Destinos que esta rodada executa. */
  destinations: readonly string[];
  now: Date;
  pid?: number;
  by: string;
  /** Máquina desta execução (default: esta). */
  host?: string;
  /** O comando efetivo do publisher (conferido contra o dono aprovado). Ausente = não confere. */
  command?: string;
  /** Comando da rodada principal: vale para dono cujo comando não é de publisher (re-execução da skill). */
  fallbackCommand?: string;
  /** A rodada foi chamada com `--now` (nunca vale para destino aprovado agendado, decisão B). */
  forceNow?: boolean;
}

/**
 * Pure: a projeção do destino na execução, com a única passagem de modo aceita
 * (decisão B): a task one-shot de um `pending_schedule` aprovado para X sai
 * "na hora" (sem `--now`) só com o relógio em `>= X`, e conta como X.
 */
function executionBinding(
  m: VideoPlanManifest,
  dest: string,
  approved: VideoPublishAuthorization,
  input: { now: Date; forceNow: boolean },
): { binding: string | null; hint?: string } {
  const d = m.destinations.find((x) => x.id === dest);
  if (!d) return { binding: null };
  const approvedAt = approved.effective_at;
  const approvedScheduled = approvedAt !== null && approvedAt !== "now";
  if (approvedScheduled && d.effective_at === "now") {
    if (input.forceNow) {
      return { binding: destinationBindingSha256(m, dest, { contentBound: approved.content_bound }), hint: `aprovado para sair agendado em ${approvedAt}: --now recusado (decisão B, #12654)` };
    }
    if (approved.approved_action === "pending_schedule") {
      if (input.now.getTime() < Date.parse(approvedAt)) {
        return { binding: destinationBindingSha256(m, dest, { contentBound: approved.content_bound }), hint: `a task one-shot só publica a partir de ${approvedAt} (agora ${input.now.toISOString()})` };
      }
      const normalized: VideoPlanManifest = { ...m, destinations: m.destinations.map((x) => (x.id === dest ? { ...x, effective_at: approvedAt } : x)) };
      return { binding: destinationBindingSha256(normalized, dest, { contentBound: approved.content_bound }) };
    }
  }
  return { binding: destinationBindingSha256(m, dest, { contentBound: approved.content_bound }) };
}

/**
 * Pure: confere e consome (uso único) as autorizações dos destinos desta
 * rodada. Tudo ou nada: qualquer destino sem autorização ativa da mesma projeção
 * recusa a rodada e nada é consumido.
 */
export function consumeVideoPublishAuthorization(storeIn: VideoPublishAuthorizationStore, input: ConsumeInput): AuthResult<VideoPublishAuthorization[]> {
  const m = input.manifest;
  if (input.edition !== storeIn.edition || m.edition !== input.edition) {
    return { ok: false, error: `edição errada: comando ${input.edition}, plano ${m.edition}, registro de autorização ${storeIn.edition}` };
  }
  if (!input.destinations.length) return { ok: false, error: "nenhum destino nesta rodada: nada a consumir" };
  const host = input.host ?? currentHost();
  const refusals: AuthorizationRefusal[] = [];
  const latestOf = (dest: string) => [...storeIn.authorizations].reverse().find((a) => a.part === m.part && a.destination === dest);
  const refuse = (destination: string, kind: AuthorizationRefusalKind, message: string, changed?: string[]) => {
    const owner = latestOf(destination)?.owner;
    refusals.push({ destination, kind, message, ...(changed ? { changed } : {}), ...(owner ? { approved_owner: owner } : {}) });
  };
  const toConsume: ActiveVideoPublishAuthorization[] = [];
  for (const dest of input.destinations) {
    const latest = latestOf(dest);
    if (!latest) {
      refuse(dest, "missing", `sem autorização (o "pode publicar" do editor não foi registrado com video-publish-authorize.ts grant)`);
      continue;
    }
    if (latest.status === "consumed") {
      refuse(dest, "consumed", `a autorização de ${latest.confirmed_at} já foi consumida em ${latest.consumed_at} (uso único): releia o registro (--record) e peça nova aprovação`);
      continue;
    }
    if (latest.status === "invalidated") {
      refuse(dest, "invalidated", `a autorização de ${latest.confirmed_at} foi invalidada em ${latest.invalidated_at} (${latest.invalidated_reason})`);
      continue;
    }
    if (latest.status !== "active") {
      // Falha fechada: estado fora da união (registro editado à mão ou de outra versão) nunca autoriza.
      refuse(dest, "unknown-status", `autorização em estado desconhecido (${JSON.stringify((latest as { status: unknown }).status)}): nada consumido`);
      continue;
    }
    if (latest.granted_host !== host) {
      refuse(dest, "other-host", `a autorização foi gravada na máquina ${latest.granted_host} e esta execução roda em ${host}: o lock do registro é por máquina, publique de lá ou peça nova aprovação aqui`);
      continue;
    }
    if (input.command !== undefined) {
      const ownerErr = commandMatchesOwner(input.command, latest.owner, dest, input.fallbackCommand);
      if (ownerErr) {
        refuse(dest, "owner-mismatch", ownerErr);
        continue;
      }
    }
    const { binding, hint } = executionBinding(m, dest, latest, { now: input.now, forceNow: input.forceNow === true });
    if (binding === null) {
      refuse(dest, "outside-plan", "fora do plano recalculado desta rodada");
      continue;
    }
    if (binding !== latest.binding_sha256 || hint) {
      const approved = storeIn.approved_manifests[latest.plan_sha256];
      const changed = approved
        ? diffManifests(approved, m).filter(
            (p) =>
              (!p.startsWith("destinations[") || p.startsWith(`destinations[${dest}]`)) &&
              // Destino com o texto no plano não se prende às fontes: a recusa não as lista.
              !(latest.content_bound && p.startsWith("sources")),
          )
        : [];
      const fields = changed.filter((p) => !/\.(action|owner)(\.|$)/.test(p));
      const shown = fields.length ? fields : changed;
      const message = `${hint ?? `o plano mudou desde a aprovação (${shown.join(", ") || "projeção do destino diferente"})`}: refaça o dry-run e peça o "pode publicar" de novo`;
      if (hint) refuse(dest, "timing", message);
      else refuse(dest, "plan-changed", message, shown);
      continue;
    }
    toConsume.push(latest);
  }
  if (refusals.length) {
    return { ok: false, error: refusals.map((r) => `${r.destination}: ${r.message}`).join("; "), refusals };
  }
  const store = clone(storeIn);
  const nowIso = input.now.toISOString();
  const consumed: ConsumedVideoPublishAuthorization[] = [];
  store.authorizations = store.authorizations.map((a): VideoPublishAuthorization => {
    if (a.status !== "active" || !toConsume.some((t) => t.id === a.id)) return a;
    const c: ConsumedVideoPublishAuthorization = {
      ...a,
      status: "consumed",
      consumed_at: nowIso,
      consumed_by: input.by,
      consumed_host: host,
      ...(input.pid !== undefined ? { consumed_pid: input.pid } : {}),
    };
    consumed.push(c);
    return c;
  });
  return { ok: true, value: consumed, store };
}

/**
 * Pure: confere, sem consumir, que o destino tem autorização ativa cujo dono
 * aprovado é uma task one-shot com exatamente este comando. A skill roda isto
 * antes de criar a task: task sem autorização não é criada (#12654).
 */
export function checkTaskAuthorization(
  store: VideoPublishAuthorizationStore,
  input: { part: VideoPlanPart; destination: string; command: string },
): { ok: true; authorization: ActiveVideoPublishAuthorization } | { ok: false; error: string } {
  const latest = [...store.authorizations].reverse().find((a) => a.part === input.part && a.destination === input.destination);
  if (!latest || latest.status !== "active") {
    return { ok: false, error: `${input.part}/${input.destination}: sem autorização ativa${latest ? ` (${latest.status})` : ""}: a task não é criada` };
  }
  if (latest.owner.by !== "agent-scheduled-task") {
    return { ok: false, error: `${input.part}/${input.destination}: o dono aprovado é ${latest.owner.by}, não uma task one-shot` };
  }
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  if (norm(latest.owner.command ?? "") !== norm(input.command)) {
    return { ok: false, error: `${input.part}/${input.destination}: o comando da task não é o do plano aprovado (aprovado: ${latest.owner.command ?? "(nenhum)"})` };
  }
  return { ok: true, authorization: latest };
}

/** Pure: invalidação comunicada pelo coordenador (interrupção, rejeição, "não" do editor). */
export function invalidateVideoPublishAuthorization(
  storeIn: VideoPublishAuthorizationStore,
  input: { part: VideoPlanPart | "all"; reason: string; now: Date },
): { store: VideoPublishAuthorizationStore; invalidated: InvalidatedVideoPublishAuthorization[] } {
  const reason = input.reason.trim() || "sem motivo informado";
  const store = clone(storeIn);
  const nowIso = input.now.toISOString();
  const invalidated: InvalidatedVideoPublishAuthorization[] = [];
  store.authorizations = store.authorizations.map((a): VideoPublishAuthorization => {
    if (a.status !== "active" || (input.part !== "all" && a.part !== input.part)) return a;
    const inv: InvalidatedVideoPublishAuthorization = { ...a, status: "invalidated", invalidated_at: nowIso, invalidated_reason: reason, invalidated_kind: "explicit" };
    invalidated.push(inv);
    return inv;
  });
  store.events.push({ kind: "invalidated", at: nowIso, part: input.part, reason, destinations: invalidated.map((a) => a.destination) });
  return { store, invalidated };
}

/** Pure: registra a releitura do registro (`video-publish-registry-status.ts --record`). */
export function recordRegistryCheck(
  storeIn: VideoPublishAuthorizationStore,
  input: { now: Date; since: string; verdict: RegistryCheckVerdict; registered: readonly string[]; uncertain?: readonly string[] },
): VideoPublishAuthorizationStore {
  const sinceMs = Date.parse(input.since);
  if (Number.isNaN(sinceMs)) throw new Error(`--since ilegível: ${JSON.stringify(input.since)}`);
  const store = clone(storeIn);
  store.events.push({
    kind: "registry-check",
    at: input.now.toISOString(),
    since: new Date(sinceMs).toISOString(),
    verdict: input.verdict,
    registered: [...input.registered],
    ...(input.uncertain && input.uncertain.length ? { uncertain: [...input.uncertain] } : {}),
  });
  return store;
}

// ---------------------------------------------------------------------------
// I/O (registro durável na pasta da edição, sob lock).
// ---------------------------------------------------------------------------

export function authorizationStorePath(editionDir: string): string {
  return join(editionDir, AUTHORIZATION_STORE_FILE);
}

/** Pure: valida cada autorização e evento lidos do disco (falha fechada: lança com o motivo). */
function validateStoreEntries(s: VideoPublishAuthorizationStore, path: string): void {
  s.authorizations.forEach((a, i) => {
    const where = `${path}: authorizations[${i}]`;
    if (!a || typeof a !== "object") throw new Error(`${where} não é objeto`);
    if (!(AUTHORIZATION_STATUSES as readonly string[]).includes((a as { status: unknown }).status as string)) {
      throw new Error(`${where}: status ${JSON.stringify((a as { status: unknown }).status)} fora de ${AUTHORIZATION_STATUSES.join("/")}`);
    }
    for (const k of ["id", "destination", "plan_sha256", "binding_sha256", "confirmed_at", "granted_host"] as const) {
      if (typeof a[k] !== "string" || !a[k]) throw new Error(`${where}: ${k} ausente`);
    }
    if (a.part !== "horizontal" && a.part !== "vertical") throw new Error(`${where}: part inválida`);
    if (a.status === "consumed" && (typeof a.consumed_at !== "string" || typeof a.consumed_host !== "string")) {
      throw new Error(`${where}: consumida sem consumed_at/consumed_host`);
    }
    if (a.status === "invalidated" && typeof a.invalidated_at !== "string") throw new Error(`${where}: invalidada sem invalidated_at`);
  });
  s.events.forEach((e, i) => {
    if (!e || (e.kind !== "invalidated" && e.kind !== "registry-check") || typeof e.at !== "string") {
      throw new Error(`${path}: events[${i}] com formato inesperado`);
    }
  });
}

/** Lê o registro; ausente = vazio. Ilegível, de outra edição ou com entrada inválida lança (falha fechada). */
export function readAuthorizationStore(editionDir: string, edition: string): VideoPublishAuthorizationStore {
  const path = authorizationStorePath(editionDir);
  if (!existsSync(path)) return emptyAuthorizationStore(edition);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} ilegível (${(e as Error).message}): nenhuma autorização vale até o arquivo ser conferido`);
  }
  const s = parsed as Partial<VideoPublishAuthorizationStore>;
  if (!s || s.schema !== AUTHORIZATION_STORE_SCHEMA || !Array.isArray(s.authorizations) || !Array.isArray(s.events)) {
    throw new Error(`${path}: formato inesperado (schema ${JSON.stringify(s?.schema)})`);
  }
  if (s.edition !== edition) throw new Error(`${path} é da edição ${s.edition}, não da ${edition}`);
  const store = { ...(s as VideoPublishAuthorizationStore), approved_manifests: s.approved_manifests ?? {} };
  validateStoreEntries(store, path);
  return store;
}

/**
 * Lê, aplica `fn` e grava sob lock. `fn` devolve o registro novo (ou `null`
 * para não gravar) e o resultado.
 */
export function updateAuthorizationStore<T>(
  editionDir: string,
  edition: string,
  fn: (store: VideoPublishAuthorizationStore) => { store: VideoPublishAuthorizationStore | null; result: T },
): T {
  const path = authorizationStorePath(editionDir);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    const out = fn(readAuthorizationStore(editionDir, edition));
    if (out.store) writeFileAtomic(path, JSON.stringify(out.store, null, 2) + "\n");
    return out.result;
  });
}

/**
 * O passo do publisher: confere e consome as autorizações desta rodada,
 * gravando o consumo antes de devolver. `{ ok: true, consumed }` = pode seguir
 * (as autorizações já estão gravadas como consumidas); `{ ok: false, error }`
 * = a mensagem de recusa (o publisher sai exit 2 sem enviar nada). Qualquer
 * falha de leitura/gravação também recusa.
 */
export function consumeBeforeExternalEffects(input: {
  editionDir: string;
  edition: string;
  manifest: VideoPlanManifest;
  destinations: readonly string[];
  now: Date;
  pid?: number;
  by: string;
  host?: string;
  command?: string;
  fallbackCommand?: string;
  forceNow?: boolean;
}): { ok: true; consumed: ConsumedVideoPublishAuthorization[] } | { ok: false; error: string; refusals?: AuthorizationRefusal[] } {
  try {
    type Out = { ok: true; consumed: ConsumedVideoPublishAuthorization[] } | { ok: false; error: string; refusals?: AuthorizationRefusal[] };
    return updateAuthorizationStore<Out>(input.editionDir, input.edition, (store) => {
      const r = consumeVideoPublishAuthorization(store, input);
      return r.ok
        ? { store: r.store, result: { ok: true, consumed: r.value as ConsumedVideoPublishAuthorization[] } }
        : { store: null, result: { ok: false, error: r.error, ...(r.refusals ? { refusals: r.refusals } : {}) } };
    });
  } catch (e) {
    return { ok: false, error: `registro de autorização indisponível (${(e as Error).message})` };
  }
}

/** Mensagem de recusa padrão do publisher (exit 2). */
export function authorizationRefusalMessage(script: string, part: VideoPlanPart, edition: string, error: string): string {
  return (
    `${script}: publicação recusada pela autorização do plano (#12654): ${error}. Nada foi enviado. ` +
    `Para publicar: dry-run, plano (com plan_sha256) ao editor, "pode publicar" explícito, ` +
    `npx tsx scripts/video-publish-authorize.ts grant ${edition} --part ${part} --plan-sha256 {hash} --confirmation "{resposta do editor}" e só então o comando.`
  );
}
