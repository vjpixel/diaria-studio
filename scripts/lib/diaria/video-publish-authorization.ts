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
 *    (dono `agent` ou `agent-scheduled-task`; `timer-300` e passo guiado ficam
 *    de fora: o timer é autorizado pela config que o ligou, #11741, e o passo
 *    guiado não passa pelo publisher).
 * 2. **consume** (o publisher, imediatamente antes do 1º efeito externo):
 *    recalcula o manifesto, confere a projeção de cada destino que vai agir
 *    contra a aprovada e marca as autorizações como consumidas ANTES de enviar
 *    qualquer coisa. Tudo ou nada: um destino sem autorização válida recusa a
 *    rodada inteira (exit 2, nada enviado).
 * 3. **invalidate** (o coordenador, sempre que uma chamada de publisher for
 *    interrompida/rejeitada, ou o editor disser "não"): derruba as ativas da
 *    parte e grava o evento. A invalidação vale mesmo sem nenhuma ativa (a
 *    rejeição pode chegar antes de o processo começar).
 * 4. **retry**: depois de uma invalidação ou de um consumo do destino, o grant
 *    novo só sai com uma releitura do registro gravada depois do evento
 *    (`video-publish-registry-status.ts AAMMDD --since ISO --record`), cobrindo o
 *    instante do evento, sem `unreadable`; destino que a releitura acusou como
 *    saído (ou saindo) não recebe autorização nova.
 *
 * ## Limitação de harness (#11741, documentada, sem promessa)
 *
 * A invalidação é COMUNICADA pelo coordenador. Uma rejeição no app que não
 * chega ao processo (o publisher já rodando segue vivo) não é detectada por
 * nada aqui: o que este registro garante é que (a) o processo só começa com
 * uma autorização ativa do mesmo plano, consumida antes do 1º efeito, e (b) a
 * autorização não serve a uma 2ª execução. O processo sobrevivente é coberto
 * pela releitura do registro (#11741), não por esta trava. O caminho B
 * (evento da conversa via adaptador de harness) foi descartado pelo editor.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { withFileLock } from "../file-lock.ts";
import {
  destinationBindingSha256,
  diffManifests,
  planSha256,
  type VideoPlanManifest,
  type VideoPlanOwner,
  type VideoPlanPart,
} from "./video-publish-plan.ts";

export const AUTHORIZATION_STORE_SCHEMA = "diaria-video-publish-authorizations/v1";
export const AUTHORIZATION_STORE_FILE = "_internal/video-publish-authorizations.json";

export interface VideoPublishAuthorization {
  id: string;
  part: VideoPlanPart;
  destination: string;
  plan_sha256: string;
  binding_sha256: string;
  /** `false` = o texto do destino não estava no plano: o vínculo é pelas fontes editoriais. */
  content_bound: boolean;
  owner: VideoPlanOwner;
  /** O texto da resposta do editor na conversa (prova da confirmação explícita). */
  confirmation: string;
  confirmed_at: string;
  status: "active" | "consumed" | "invalidated";
  consumed_at?: string;
  consumed_pid?: number;
  consumed_by?: string;
  invalidated_at?: string;
  invalidated_reason?: string;
  /** `superseded` = trocada por aprovação nova antes de uso (não exige releitura do registro). */
  invalidated_kind?: "explicit" | "superseded";
}

export type VideoPublishAuthorizationEvent =
  | { kind: "invalidated"; at: string; part: VideoPlanPart | "all"; reason: string; destinations: string[] }
  | { kind: "registry-check"; at: string; since: string; verdict: string; registered: string[] };

export interface VideoPublishAuthorizationStore {
  schema: typeof AUTHORIZATION_STORE_SCHEMA;
  edition: string;
  authorizations: VideoPublishAuthorization[];
  events: VideoPublishAuthorizationEvent[];
  /** Manifestos aprovados por hash: a recusa por plano diferente mostra o que mudou. */
  approved_manifests: Record<string, VideoPlanManifest>;
}

export type AuthResult<T> = { ok: true; value: T; store: VideoPublishAuthorizationStore } | { ok: false; error: string };

export function emptyAuthorizationStore(edition: string): VideoPublishAuthorizationStore {
  return { schema: AUTHORIZATION_STORE_SCHEMA, edition, authorizations: [], events: [], approved_manifests: {} };
}

function clone(store: VideoPublishAuthorizationStore): VideoPublishAuthorizationStore {
  return JSON.parse(JSON.stringify(store)) as VideoPublishAuthorizationStore;
}

/** Destinos que recebem autorização: os que um publisher executa (o timer do 300 e o passo guiado, não). */
export function authorizableDestinations(m: VideoPlanManifest): string[] {
  return m.destinations.filter((d) => d.owner.by !== "timer-300" && d.action !== "guided").map((d) => d.id);
}

/** Último instante que exige releitura do registro antes de nova autorização do destino. */
function retryBarrier(store: VideoPublishAuthorizationStore, part: VideoPlanPart, destination: string): string | null {
  const times: string[] = [];
  for (const a of store.authorizations) {
    if (a.part !== part || a.destination !== destination) continue;
    if (a.status === "consumed" && a.consumed_at) times.push(a.consumed_at);
  }
  for (const e of store.events) {
    if (e.kind === "invalidated" && (e.part === part || e.part === "all")) times.push(e.at);
  }
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function registryCheckCovering(store: VideoPublishAuthorizationStore, barrier: string): Extract<VideoPublishAuthorizationEvent, { kind: "registry-check" }> | null {
  const b = Date.parse(barrier);
  const checks = store.events.filter(
    (e): e is Extract<VideoPublishAuthorizationEvent, { kind: "registry-check" }> =>
      e.kind === "registry-check" && Date.parse(e.at) >= b && Date.parse(e.since) <= b,
  );
  return checks.length ? checks[checks.length - 1] : null;
}

export interface GrantInput {
  manifest: VideoPlanManifest;
  /** O hash que o editor viu no plano (impresso pelo dry-run). */
  planSha256: string;
  confirmation: string;
  now: Date;
  only?: readonly string[] | null;
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

  const store = clone(storeIn);
  const nowIso = input.now.toISOString();
  for (const dest of targets) {
    const barrier = retryBarrier(store, m.part, dest);
    if (barrier === null) continue;
    const check = registryCheckCovering(store, barrier);
    if (!check) {
      return {
        ok: false,
        error:
          `${m.part}/${dest}: houve consumo ou invalidação em ${barrier}; antes de nova autorização, releia o registro ` +
          `(npx tsx scripts/video-publish-registry-status.ts ${m.edition} --since {ISO da chamada} --record, com --since até ${barrier}) (#12654, #11741)`,
      };
    }
    if (check.verdict !== "nothing-since" && check.verdict !== "registered-since") {
      return { ok: false, error: `${m.part}/${dest}: a releitura do registro de ${check.at} saiu ${check.verdict}: conferir as contas antes de qualquer nova autorização` };
    }
    if (check.registered.includes(dest)) {
      return { ok: false, error: `${m.part}/${dest}: a releitura de ${check.at} acusou o destino como saído (ou saindo): relatar ao editor, nunca publicar de novo (#11741)` };
    }
  }

  const granted: VideoPublishAuthorization[] = [];
  for (const dest of targets) {
    for (const a of store.authorizations) {
      if (a.part === m.part && a.destination === dest && a.status === "active") {
        a.status = "invalidated";
        a.invalidated_at = nowIso;
        a.invalidated_reason = "substituída por nova aprovação";
        a.invalidated_kind = "superseded";
      }
    }
    const d = m.destinations.find((x) => x.id === dest)!;
    const auth: VideoPublishAuthorization = {
      id: `${m.part}:${dest}:${nowIso}`,
      part: m.part,
      destination: dest,
      plan_sha256: actual,
      binding_sha256: destinationBindingSha256(m, dest, { contentBound: d.content !== null })!,
      content_bound: d.content !== null,
      owner: d.owner,
      confirmation,
      confirmed_at: nowIso,
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
}

/**
 * Pure: confere e consome (uso único) as autorizações dos destinos desta
 * rodada. Tudo ou nada: qualquer destino sem autorização ativa do mesmo plano
 * recusa a rodada e nada é consumido.
 */
export function consumeVideoPublishAuthorization(storeIn: VideoPublishAuthorizationStore, input: ConsumeInput): AuthResult<VideoPublishAuthorization[]> {
  const m = input.manifest;
  if (input.edition !== storeIn.edition || m.edition !== input.edition) {
    return { ok: false, error: `edição errada: comando ${input.edition}, plano ${m.edition}, registro de autorização ${storeIn.edition}` };
  }
  if (!input.destinations.length) return { ok: false, error: "nenhum destino nesta rodada: nada a consumir" };
  const store = clone(storeIn);
  const problems: string[] = [];
  const toConsume: VideoPublishAuthorization[] = [];
  for (const dest of input.destinations) {
    const latest = [...store.authorizations].reverse().find((a) => a.part === m.part && a.destination === dest);
    if (!latest) {
      problems.push(`${dest}: sem autorização (o "pode publicar" do editor não foi registrado com video-publish-authorize.ts grant)`);
      continue;
    }
    if (latest.status === "consumed") {
      problems.push(`${dest}: a autorização de ${latest.confirmed_at} já foi consumida em ${latest.consumed_at} (uso único): releia o registro (--record) e peça nova aprovação`);
      continue;
    }
    if (latest.status === "invalidated") {
      problems.push(`${dest}: a autorização de ${latest.confirmed_at} foi invalidada em ${latest.invalidated_at} (${latest.invalidated_reason ?? "sem motivo"})`);
      continue;
    }
    const binding = destinationBindingSha256(m, dest, { contentBound: latest.content_bound });
    if (binding === null) {
      problems.push(`${dest}: fora do plano recalculado desta rodada`);
      continue;
    }
    if (binding !== latest.binding_sha256) {
      const approved = store.approved_manifests[latest.plan_sha256];
      const changed = approved ? diffManifests(approved, m).filter((p) => !p.startsWith("destinations[") || p.startsWith(`destinations[${dest}]`)) : [];
      const fields = changed.filter((p) => !/\.(action|owner)(\.|$)/.test(p));
      problems.push(
        `${dest}: o plano mudou desde a aprovação (${(fields.length ? fields : changed).join(", ") || "projeção do destino diferente"}): refaça o dry-run e peça o "pode publicar" de novo`,
      );
      continue;
    }
    toConsume.push(latest);
  }
  if (problems.length) return { ok: false, error: problems.join("; ") };
  const nowIso = input.now.toISOString();
  for (const a of toConsume) {
    a.status = "consumed";
    a.consumed_at = nowIso;
    a.consumed_by = input.by;
    if (input.pid !== undefined) a.consumed_pid = input.pid;
  }
  return { ok: true, value: toConsume, store };
}

/**
 * Pure: confere, sem consumir, que o destino tem autorização ativa cujo dono
 * aprovado é uma task one-shot com exatamente este comando. A skill roda isto
 * antes de criar a task: task sem autorização não é criada (#12654).
 */
export function checkTaskAuthorization(
  store: VideoPublishAuthorizationStore,
  input: { part: VideoPlanPart; destination: string; command: string },
): { ok: true; authorization: VideoPublishAuthorization } | { ok: false; error: string } {
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
): { store: VideoPublishAuthorizationStore; invalidated: VideoPublishAuthorization[] } {
  const reason = input.reason.trim() || "sem motivo informado";
  const store = clone(storeIn);
  const nowIso = input.now.toISOString();
  const invalidated: VideoPublishAuthorization[] = [];
  for (const a of store.authorizations) {
    if (a.status !== "active" || (input.part !== "all" && a.part !== input.part)) continue;
    a.status = "invalidated";
    a.invalidated_at = nowIso;
    a.invalidated_reason = reason;
    a.invalidated_kind = "explicit";
    invalidated.push(a);
  }
  store.events.push({ kind: "invalidated", at: nowIso, part: input.part, reason, destinations: invalidated.map((a) => a.destination) });
  return { store, invalidated };
}

/** Pure: registra a releitura do registro (`video-publish-registry-status.ts --record`). */
export function recordRegistryCheck(
  storeIn: VideoPublishAuthorizationStore,
  input: { now: Date; since: string; verdict: string; registered: readonly string[] },
): VideoPublishAuthorizationStore {
  const store = clone(storeIn);
  store.events.push({ kind: "registry-check", at: input.now.toISOString(), since: new Date(Date.parse(input.since)).toISOString(), verdict: input.verdict, registered: [...input.registered] });
  return store;
}

// ---------------------------------------------------------------------------
// I/O (registro durável na pasta da edição, sob lock).
// ---------------------------------------------------------------------------

export function authorizationStorePath(editionDir: string): string {
  return join(editionDir, AUTHORIZATION_STORE_FILE);
}

/** Lê o registro; ausente = vazio. Ilegível ou de outra edição lança (falha fechada). */
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
  if (s.schema !== AUTHORIZATION_STORE_SCHEMA || !Array.isArray(s.authorizations) || !Array.isArray(s.events)) {
    throw new Error(`${path}: formato inesperado (schema ${JSON.stringify(s.schema)})`);
  }
  if (s.edition !== edition) throw new Error(`${path} é da edição ${s.edition}, não da ${edition}`);
  return { ...(s as VideoPublishAuthorizationStore), approved_manifests: s.approved_manifests ?? {} };
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
 * gravando o consumo antes de devolver. `null` = pode seguir; senão, a
 * mensagem de recusa (o publisher sai exit 2 sem enviar nada). Qualquer falha
 * de leitura/gravação também recusa.
 */
export function consumeBeforeExternalEffects(input: {
  editionDir: string;
  edition: string;
  manifest: VideoPlanManifest;
  destinations: readonly string[];
  now: Date;
  pid?: number;
  by: string;
}): { ok: true; consumed: VideoPublishAuthorization[] } | { ok: false; error: string } {
  try {
    type Out = { ok: true; consumed: VideoPublishAuthorization[] } | { ok: false; error: string };
    return updateAuthorizationStore<Out>(input.editionDir, input.edition, (store) => {
      const r = consumeVideoPublishAuthorization(store, input);
      return r.ok ? { store: r.store, result: { ok: true, consumed: r.value } } : { store: null, result: { ok: false, error: r.error } };
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
