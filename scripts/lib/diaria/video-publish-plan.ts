/**
 * scripts/lib/diaria/video-publish-plan.ts (#12654, filha de #12622)
 *
 * Manifesto canônico e versionado do plano de publicação de uma parte do
 * vídeo da edição (horizontal no YouTube, vertical nos destinos do
 * `publish-shorts.ts`). O SHA-256 do manifesto é o que o editor aprova na
 * conversa ("pode publicar" sobre o plano do dry-run); o publisher recalcula
 * o manifesto imediatamente antes de qualquer efeito externo e recusa se o
 * plano mudou (`video-publish-authorization.ts`).
 *
 * ## O que entra
 *
 * - edição (`edition`) e parte (`part`);
 * - hashes dos bytes de vídeo, capa e legenda (`media`, `null` = arquivo ausente);
 * - título/descrição/tags (`metadata`);
 * - fuso (`timezone`) e, por destino, horário planejado (`at`) e o modo/instante
 *   efetivo (`effective_at`: `scheduledAt ?? "now"`);
 * - destinos com o texto que sai em cada um (`content`) e o dono/comando
 *   (`owner`) que executa;
 * - hashes das fontes editoriais (`sources`: `02-reviewed.md`, `03-social.md`,
 *   roteiro, links do horizontal e da edição) — é o que prende o texto de um
 *   destino cujo texto ainda não existe no plano aprovado (`content: null`:
 *   `skip_late`, o repost da página que espera o perfil).
 *
 * ## Campos voláteis (ignorados no hash)
 *
 * Só `generated_at` (o instante do dry-run), listado em
 * `VOLATILE_MANIFEST_FIELDS`. Nada de conteúdo editorial sai do hash.
 *
 * ## Dois hashes
 *
 * - `planSha256(manifest)`: o plano inteiro da parte, o que o editor aprova e
 *   o que a autorização registra junto da confirmação;
 * - `destinationBindingSha256(manifest, id)`: a projeção do plano que vale para
 *   UM destino (núcleo comum + o destino, com o modo/instante efetivo; +
 *   `sources` quando o texto não está no plano). É o que o publisher confere ao
 *   executar: a rodada principal e a task one-shot que publica um destino
 *   adiado recalculam o plano em momentos diferentes, com ações diferentes
 *   (`pending_schedule` vira `publish` na hora da task), então o plano inteiro
 *   nunca bateria; a projeção do destino, sim, enquanto nada editorial, de
 *   mídia, de horário ou de modo mudar.
 *
 * ## Modo/instante efetivo (`effective_at`, decisão B do editor, 11/11/2026)
 *
 * `scheduledAt ?? "now"` do item do plano: o instante em que o destino sai
 * (ISO) ou `"now"`. Entra na projeção do destino: um destino aprovado para
 * sair agendado e executado com `--now` muda de projeção e é recusado. A única
 * passagem de agendado para "na hora" aceita é a da task one-shot de um
 * `pending_schedule` (sem `--now`, com o relógio já em `>=` o instante
 * aprovado), conferida no consumo (`video-publish-authorization.ts`). `null` =
 * o modo não é decidido pelo plano (passo guiado, repost que espera o perfil:
 * o instante vem da grade, conferida pelo `at` e pelas fontes).
 *
 * A ação planejada e o dono ficam no plano aprovado (`planSha256`), fora da
 * projeção: eles mudam por definição entre a aprovação e a execução de um
 * destino adiado. O dono é conferido à parte: na criação da task
 * (`checkTaskAuthorization`) e no consumo, contra o comando efetivo
 * (`commandMatchesOwner`).
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

export const VIDEO_PLAN_MANIFEST_SCHEMA = "diaria-video-publish-plan/v1";
export const VIDEO_PLAN_TIMEZONE = "America/Sao_Paulo";

/** Campos de topo comprovadamente voláteis: o instante em que o dry-run rodou. */
export const VOLATILE_MANIFEST_FIELDS = ["generated_at"] as const;

export type VideoPlanPart = "horizontal" | "vertical";

export const VIDEO_PLAN_PARTS: readonly VideoPlanPart[] = ["horizontal", "vertical"];

export interface VideoPlanMedia {
  video_sha256: string | null;
  cover_sha256: string | null;
  captions_sha256: string | null;
}

export interface VideoPlanMetadata {
  title: string;
  description: string;
  tags: string[];
}

export interface VideoPlanOwner {
  by: "agent" | "agent-scheduled-task" | "timer-300";
  task?: string;
  command?: string;
}

/** Modo do agendamento do horizontal (`YouTubeScheduleDecision.mode`). */
export type HorizontalPlanAction = "scheduled" | "immediate";

/** Ações do plano do vertical que entram no manifesto (`ShortsPlanItem.action`, menos os pulos sem efeito). */
export type VerticalPlanAction =
  | "publish"
  | "pending_schedule"
  | "enqueue"
  | "buffer"
  | "guided"
  | "skip_late"
  | "skip_delegated"
  | "skip_invalid"
  | "skip_missing_credentials"
  | "skip_done";

export type VideoPlanAction = HorizontalPlanAction | VerticalPlanAction;

/** O repost da página no LinkedIn (#10772, #11121): passo guiado que o `--publish` entrega à fila do Worker. */
export const PAGE_REPOST_DESTINATION = "linkedin_page_repost";

export interface VideoPlanDestination {
  id: string;
  /** Ação planejada no dry-run (só no plano aprovado, fora da projeção do destino). */
  action: VideoPlanAction;
  /** Horário planejado do destino na grade (ISO); `null` = na hora. */
  at: string | null;
  /**
   * Modo/instante efetivo (`scheduledAt ?? "now"` do item): ISO, `"now"`, ou
   * `null` quando o plano não decide (guiado, repost que espera o perfil).
   * Entra na projeção do destino (decisão B do editor, 11/11/2026).
   */
  effective_at: string | null;
  /** Texto/título que sai no destino; `null` = ainda não existe no plano (vínculo pelas `sources`). */
  content: Record<string, string | string[] | null> | null;
  owner: VideoPlanOwner;
}

export interface VideoPlanManifest {
  schema: typeof VIDEO_PLAN_MANIFEST_SCHEMA;
  edition: string;
  part: VideoPlanPart;
  media: VideoPlanMedia;
  metadata: VideoPlanMetadata;
  timezone: string;
  sources: Record<string, string | null>;
  destinations: VideoPlanDestination[];
  /** Volátil: instante do dry-run. Fora do hash. */
  generated_at?: string;
}

/**
 * JSON canônico: chaves em ordem, sem espaço, `undefined` omitido. Arrays
 * mantêm a ordem (a ordem dos destinos é a do plano, e a das tags é conteúdo).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: tipo não serializável (${typeof value})`);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 dos bytes de um arquivo, lido em blocos (o horizontal passa de 1 GB). `null` = ausente. */
export function sha256File(path: string | null | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  if (statSync(path).size === 0) return sha256Hex("");
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** O manifesto sem os campos voláteis: a base dos dois hashes. */
export function stableManifest(m: VideoPlanManifest): Omit<VideoPlanManifest, "generated_at"> {
  const out: Record<string, unknown> = { ...m };
  for (const f of VOLATILE_MANIFEST_FIELDS) delete out[f];
  return out as Omit<VideoPlanManifest, "generated_at">;
}

/** SHA-256 do plano inteiro da parte (o que o editor aprova). */
export function planSha256(m: VideoPlanManifest): string {
  return sha256Hex(canonicalJson(stableManifest(m)));
}

/**
 * Projeção do plano para um destino: núcleo comum (edição, parte, mídia,
 * metadados, fuso) + o destino (id, horário, texto). Sem o texto no plano,
 * entram as fontes editoriais no lugar dele. `null` = destino fora do plano.
 */
export function destinationProjection(
  m: VideoPlanManifest,
  destinationId: string,
  opts: { contentBound?: boolean } = {},
): Record<string, unknown> | null {
  const found = m.destinations.find((x) => x.id === destinationId);
  if (!found) return null;
  // Aprovado sem o texto (`content_bound: false`): a execução, que já tem o texto, é conferida pelas
  // mesmas fontes que o determinam, nunca pelo texto novo contra um `null`.
  const d = opts.contentBound === false ? { ...found, content: null } : found;
  return {
    schema: m.schema,
    edition: m.edition,
    part: m.part,
    media: m.media,
    metadata: m.metadata,
    timezone: m.timezone,
    destination: { id: d.id, at: d.at, effective_at: d.effective_at, content: d.content },
    ...(d.content === null ? { sources: m.sources } : {}),
  };
}

export function destinationBindingSha256(m: VideoPlanManifest, destinationId: string, opts: { contentBound?: boolean } = {}): string | null {
  const p = destinationProjection(m, destinationId, opts);
  return p === null ? null : sha256Hex(canonicalJson(p));
}

/**
 * Destinos de um manifesto que recebem autorização de uso único: lista
 * POSITIVA de ações que um publisher executa. Fora: dono `timer-300`
 * (autorizado pela config que o ligou, #11741) e passos guiados que o
 * publisher não executa. O repost da página entra (guiado ou esperando o
 * perfil): o `--publish` o entrega à fila do Worker.
 */
export const AUTHORIZABLE_VERTICAL_ACTIONS: ReadonlySet<VerticalPlanAction> = new Set<VerticalPlanAction>([
  "publish",
  "enqueue",
  "buffer",
  "pending_schedule",
  "skip_late",
]);

export function isAuthorizableDestination(m: VideoPlanManifest, d: VideoPlanDestination): boolean {
  if (d.owner.by === "timer-300") return false;
  if (m.part === "horizontal") return d.id === "youtube" && (d.action === "scheduled" || d.action === "immediate");
  if ((AUTHORIZABLE_VERTICAL_ACTIONS as ReadonlySet<string>).has(d.action)) return true;
  return d.id === PAGE_REPOST_DESTINATION && (d.action === "guided" || d.action === "skip_invalid");
}

/** Forma de um comando de publisher para comparar dono aprovado e comando efetivo. */
interface CommandShape {
  script: string | null;
  only: string[] | null;
  flags: string[];
}

/** Flags com valor que não mudam o que sai (a mesma edição, a mesma pasta): fora da comparação. */
const COMMAND_VALUE_FLAGS_IGNORED = new Set(["--confirm-publish", "--edition-dir"]);
/** Flags sem valor que não mudam o que sai (o escape da pasta fora da canônica, manter o arquivo local). */
const COMMAND_BOOLEAN_FLAGS_IGNORED = new Set(["--allow-unwatched-dir", "--keep-video"]);

export function commandShape(command: string): CommandShape {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let script: string | null = null;
  let only: string[] | null = null;
  const flags = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (script === null && /(^|\/)scripts\/[\w.-]+\.ts$/.test(t)) {
      script = t.replace(/^.*?(scripts\/)/, "$1");
      continue;
    }
    if (!t.startsWith("--")) continue;
    const [name, inline] = t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
    const next = tokens[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith("--") ? next : undefined);
    if (name === "--only") {
      only = (value ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort();
      if (inline === undefined && value !== undefined) i++;
      continue;
    }
    if (COMMAND_VALUE_FLAGS_IGNORED.has(name)) {
      if (inline === undefined && value !== undefined) i++;
      continue;
    }
    if (COMMAND_BOOLEAN_FLAGS_IGNORED.has(name)) continue;
    flags.add(name);
  }
  return { script, only, flags: [...flags].sort() };
}

/**
 * Pure: o comando efetivo do publisher executa o destino como o dono aprovado
 * previa? Mesmo script e mesmas flags (`--now`, flag de timer...); o `--only`
 * do dono, se houver, tem de ser o mesmo conjunto; dono sem `--only` (rodada
 * principal) aceita um `--only` que contenha o destino. Dono cujo comando não
 * é de publisher (a re-execução da skill) vale como a rodada principal
 * (`fallbackCommand`). `null` = confere; senão, o motivo.
 */
export function commandMatchesOwner(
  effective: string,
  owner: VideoPlanOwner,
  destination: string,
  fallbackCommand?: string,
): string | null {
  const approvedRaw = owner.command && commandShape(owner.command).script !== null ? owner.command : fallbackCommand;
  if (!approvedRaw) return null;
  const a = commandShape(approvedRaw);
  const e = commandShape(effective);
  if (a.script !== e.script) return `o comando efetivo (${e.script ?? "?"}) não é o do dono aprovado (${a.script ?? "?"})`;
  if (canonicalJson(a.flags) !== canonicalJson(e.flags)) {
    return `as flags do comando efetivo (${e.flags.join(" ") || "nenhuma"}) não são as do dono aprovado (${a.flags.join(" ") || "nenhuma"}): ${approvedRaw}`;
  }
  if (a.only !== null) {
    if (e.only === null || canonicalJson(a.only) !== canonicalJson(e.only)) {
      return `o --only do comando efetivo (${e.only?.join(",") ?? "nenhum"}) não é o do dono aprovado (${a.only.join(",")})`;
    }
  } else if (e.only !== null && !e.only.includes(destination)) {
    return `o --only do comando efetivo (${e.only.join(",")}) não inclui ${destination}`;
  }
  return null;
}

/**
 * Pure: caminhos (`a.b[id].c`) em que dois manifestos diferem, ignorando os
 * campos voláteis. Vazio = o mesmo plano. Serve à mensagem de recusa: o editor
 * vê o que mudou desde a aprovação.
 */
export function diffManifests(a: VideoPlanManifest, b: VideoPlanManifest): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (canonicalJson(x ?? null) === canonicalJson(y ?? null)) return;
    if (Array.isArray(x) && Array.isArray(y) && path.endsWith("destinations")) {
      const ids = [...new Set([...x, ...y].map((d) => (d as VideoPlanDestination).id))];
      for (const id of ids) {
        walk(x.find((d) => (d as VideoPlanDestination).id === id), y.find((d) => (d as VideoPlanDestination).id === id), `${path}[${id}]`);
      }
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    out.push(path || "(raiz)");
  };
  walk(stableManifest(a), stableManifest(b), "");
  return out;
}

/** Arquivo do último manifesto do dry-run da parte (lido pelo `video-publish-authorize.ts grant`). */
export function videoPlanManifestPath(editionDir: string, part: VideoPlanPart): string {
  return join(editionDir, "_internal", `video-publish-plan.${part}.json`);
}

export function writeVideoPlanManifest(editionDir: string, m: VideoPlanManifest): string {
  const path = videoPlanManifestPath(editionDir, m.part);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileAtomic(path, JSON.stringify(m, null, 2) + "\n");
  return path;
}

/** Valida a forma mínima de um manifesto lido do disco (lança com o motivo). */
export function parseVideoPlanManifest(raw: string, where: string): VideoPlanManifest {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message})`);
  }
  const o = m as Partial<VideoPlanManifest>;
  if (!o || typeof o !== "object") throw new Error(`${where}: manifesto não é objeto`);
  if (o.schema !== VIDEO_PLAN_MANIFEST_SCHEMA) throw new Error(`${where}: schema ${JSON.stringify(o.schema)} (esperado ${VIDEO_PLAN_MANIFEST_SCHEMA})`);
  if (typeof o.edition !== "string" || !/^\d{6}$/.test(o.edition)) throw new Error(`${where}: edition inválida`);
  if (o.part !== "horizontal" && o.part !== "vertical") throw new Error(`${where}: part inválida`);
  if (!o.media || !o.metadata || !Array.isArray(o.destinations) || !o.sources) throw new Error(`${where}: manifesto incompleto`);
  return o as VideoPlanManifest;
}

export function readVideoPlanManifest(editionDir: string, part: VideoPlanPart): VideoPlanManifest | null {
  const path = videoPlanManifestPath(editionDir, part);
  if (!existsSync(path)) return null;
  return parseVideoPlanManifest(readFileSync(path, "utf8"), path);
}

/**
 * Fontes editoriais da edição que determinam os textos: hash do conteúdo de
 * cada arquivo (`null` = ausente). Os links do horizontal e da edição entram
 * aqui: o link do horizontal gerado depois da aprovação do vertical muda a
 * fonte, e a autorização deixa de valer (o plano é regenerado e aprovado de
 * novo, nunca alterado em silêncio).
 */
export const VIDEO_PLAN_SOURCE_FILES: Readonly<Record<string, string>> = {
  reviewed: "02-reviewed.md",
  social: "03-social.md",
  roteiro: "_internal/roteiro-falas.json",
  horizontal_link: "_internal/05-video-url.txt",
  edition_url: "_internal/05-edition-url.txt",
};

export function readVideoPlanSources(editionDir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, rel] of Object.entries(VIDEO_PLAN_SOURCE_FILES)) out[k] = sha256File(join(editionDir, rel));
  return out;
}

// ---------------------------------------------------------------------------
// Construção a partir dos planos dos publishers (pura).
// ---------------------------------------------------------------------------

export interface HorizontalManifestInput {
  aammdd: string;
  metadata: { title: string; description: string; tags: string[] };
  schedule: { mode: HorizontalPlanAction; publishAt: string | null };
  privacy: string;
  media: VideoPlanMedia;
  sources: Record<string, string | null>;
  command: string;
  generatedAt?: string;
}

/** Pure: manifesto do horizontal (um destino, `youtube`). */
export function buildHorizontalManifest(input: HorizontalManifestInput): VideoPlanManifest {
  return {
    schema: VIDEO_PLAN_MANIFEST_SCHEMA,
    edition: input.aammdd,
    part: "horizontal",
    media: input.media,
    metadata: { title: input.metadata.title, description: input.metadata.description, tags: [...input.metadata.tags] },
    timezone: VIDEO_PLAN_TIMEZONE,
    sources: input.sources,
    destinations: [
      {
        id: "youtube",
        action: input.schedule.mode,
        at: input.schedule.publishAt,
        effective_at: input.schedule.publishAt ?? "now",
        content: { title: input.metadata.title, description: input.metadata.description, tags: [...input.metadata.tags], privacy: input.privacy },
        owner: { by: "agent", command: input.command },
      },
    ],
    ...(input.generatedAt ? { generated_at: input.generatedAt } : {}),
  };
}

/** Item do plano do vertical, na forma mínima que o manifesto lê (estrutural, sem importar `publish-shorts.ts`). */
export interface VerticalPlanItemLike {
  destination: string;
  action: VerticalPlanAction;
  caption?: string;
  title?: string;
  retryAt?: string;
  /** Instante do agendamento do item (`null` = na hora); ausente = o item não agenda. */
  scheduledAt?: string | null;
}

/** Pure: modo/instante efetivo de um item do vertical (`scheduledAt ?? "now"`; atrasado sai na hora; guiado, `null`). */
export function verticalEffectiveAt(item: VerticalPlanItemLike): string | null {
  if (item.scheduledAt !== undefined) return item.scheduledAt ?? "now";
  return item.action === "skip_late" ? "now" : null;
}

export interface VerticalOwnerLike {
  destination: string;
  by: VideoPlanOwner["by"];
  task?: string;
  command?: string;
}

export interface VerticalManifestInput {
  aammdd: string;
  items: readonly VerticalPlanItemLike[];
  owners: readonly VerticalOwnerLike[];
  destinationAt: (id: string) => string | null;
  horizontalLink: (id: string) => string | null;
  metadata: { title: string; description: string; tags?: string[] };
  media: VideoPlanMedia;
  sources: Record<string, string | null>;
  /** Comando da rodada principal (`--publish`), dono dos destinos que saem nela. */
  publishCommand: string;
  generatedAt?: string;
}

/** Ações do vertical que saem pela rodada `--publish` (o efeito externo é do publisher). */
export const VERTICAL_RUN_ACTIONS: ReadonlySet<VerticalPlanAction> = new Set<VerticalPlanAction>(["publish", "enqueue", "buffer"]);
/** Ações que não entram no plano: nada a publicar (já feito, sem credencial, inválido). */
const VERTICAL_SKIPPED_ACTIONS: ReadonlySet<VerticalPlanAction> = new Set<VerticalPlanAction>(["skip_done", "skip_missing_credentials", "skip_invalid"]);

/** Pure: manifesto do vertical. Destinos na ordem do plano. */
export function buildVerticalManifest(input: VerticalManifestInput): VideoPlanManifest {
  const destinations: VideoPlanDestination[] = [];
  for (const item of input.items) {
    // O repost da página que espera o perfil (#12761) tem dono e entra no plano.
    if (VERTICAL_SKIPPED_ACTIONS.has(item.action) && !(item.action === "skip_invalid" && item.retryAt !== undefined)) continue;
    const owner = input.owners.find((o) => o.destination === item.destination);
    const content =
      item.caption !== undefined || item.title !== undefined
        ? {
            ...(item.caption !== undefined ? { caption: item.caption } : {}),
            ...(item.title !== undefined ? { title: item.title } : {}),
            horizontal_link: input.horizontalLink(item.destination),
          }
        : null;
    // Destino que sai pela rodada principal sem comando no owners[] (Buffer: o --publish sobe o vertical) é da rodada principal.
    const command = owner?.command ?? (!owner || VERTICAL_RUN_ACTIONS.has(item.action) ? input.publishCommand : undefined);
    destinations.push({
      id: item.destination,
      action: item.action,
      at: input.destinationAt(item.destination),
      effective_at: verticalEffectiveAt(item),
      content,
      owner: { by: owner?.by ?? "agent", ...(owner?.task ? { task: owner.task } : {}), ...(command ? { command } : {}) },
    });
  }
  return {
    schema: VIDEO_PLAN_MANIFEST_SCHEMA,
    edition: input.aammdd,
    part: "vertical",
    media: input.media,
    metadata: { title: input.metadata.title, description: input.metadata.description, tags: [...(input.metadata.tags ?? [])] },
    timezone: VIDEO_PLAN_TIMEZONE,
    sources: input.sources,
    destinations,
    ...(input.generatedAt ? { generated_at: input.generatedAt } : {}),
  };
}
