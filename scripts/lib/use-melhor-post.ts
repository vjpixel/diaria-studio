/**
 * use-melhor-post.ts (#9568)
 *
 * 4º post social diário: o item de MAIOR `score` da seção USE MELHOR vira um
 * post próprio (além de D1/D2/D3) em LinkedIn página, Facebook, Instagram
 * (carrossel tipográfico de N slides), Threads e X — num slot único, igual nas
 * 5 redes. Decisões do editor (04/10/2026) no corpo da #9568.
 *
 * ── Feature INERTE até o slot ser medido ───────────────────────────────────
 * O horário (`publishing.social.use_melhor_time`) ainda não foi escolhido —
 * o item 1 da #9568 pede que ele seja derivado de dado de engajamento por
 * horário antes de ser fixado. Enquanto a chave estiver ausente/`null` em
 * `platform.config.json`, TODA a feature fica desligada: o Stage 2 não pede
 * a seção `## um` aos writers, o Stage 3 não gera cards, o Stage 4 mostra só
 * a linha "4º post desligado" e nada é agendado. O fluxo de D1/D2/D3 é o de
 * sempre, byte a byte. A chave vive em `publishing.social` (a issue escreve
 * `publishing.socials`, mas a chave real do config é `social` — é lá que já
 * moram `fallback_schedule` e `timezone`).
 *
 * ── Qual item ──────────────────────────────────────────────────────────────
 * O de maior `score` entre os USE MELHOR RENDERIZADOS na edição final
 * (`02-reviewed.md`). No Stage 2 o `02-reviewed.md` ainda não existe (os
 * social agents rodam em paralelo com o writer), então a 1ª seleção usa o
 * `use_melhor` de `01-approved-capped.json` — que é exatamente o que o
 * `stitch-newsletter.ts` renderiza. Os Stages 4/5 re-selecionam contra o
 * `02-reviewed.md` final e acusam divergência (editor mexeu na seção no gate).
 * Score vem sempre do JSON aprovado: item que o editor colou à mão no
 * `02-reviewed.md`, sem entrada no JSON, não tem score e não é elegível.
 *
 * ── Fail-soft ──────────────────────────────────────────────────────────────
 * Sem item elegível → `item: null` + `reason`, o 4º post é pulado com aviso
 * no gate. Nada aqui lança por falta de item: a edição nunca bloqueia por
 * causa do 4º post.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSections } from "./newsletter-parse.ts";

/** Id da seção do 4º post em `03-social.md` (`## um`, sob `# Social` e `# Curto`). */
export const USE_MELHOR_POST_ID = "um";

/** `utm_content` próprio do 4º post — mede separado dos destaques. */
export const USE_MELHOR_UTM_CONTENT = "usemelhor";

/**
 * Os publicadores do Stage 5 (LinkedIn/Facebook/Instagram/Threads/X) ainda NÃO
 * despacham o `## um` — eles só enumeram `## d{N}` (`parseDestaqueHeaders`),
 * então mesmo com o slot definido nada é publicado. Virar `true` junto com o
 * PR que ligar o dispatch, pra o gate parar de avisar.
 */
export const USE_MELHOR_STAGE5_DISPATCH_IMPLEMENTED = false;

/** Linha do gate/preview enquanto o slot não foi definido. */
export const USE_MELHOR_DISABLED_LABEL = "4º post desligado (use_melhor_time não definido)";

/** Arquivo de estado escrito no Stage 2 pelo seletor. */
export function useMelhorPostStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "use-melhor-post.json");
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface UseMelhorPostConfigState {
  enabled: boolean;
  /** "HH:MM" (BRT) quando `enabled`; `null` caso contrário. */
  time: string | null;
  /** Por que está desligado — sempre presente quando `enabled === false`. */
  reason?: string;
}

/**
 * Pure: lê `publishing.social.use_melhor_time` do config já parseado.
 *
 * Desligado quando: chave ausente/`null`/vazia (estado default — slot ainda
 * não medido); valor fora do formato `HH:MM`; ou valor igual a um dos slots
 * de destaque (`fallback_schedule.d{1,2,3}_time`) — a #9568 pede um slot
 * FORA dos atuais, e cair em cima de um deles publicaria 2 posts no mesmo
 * minuto em cada rede.
 */
export function useMelhorPostConfigState(config: unknown): UseMelhorPostConfigState {
  const social = (config as { publishing?: { social?: Record<string, unknown> } } | null)?.publishing?.social;
  const raw = social?.use_melhor_time;
  if (raw === undefined || raw === null || raw === "") {
    return { enabled: false, time: null, reason: USE_MELHOR_DISABLED_LABEL };
  }
  if (typeof raw !== "string" || !HHMM_RE.test(raw.trim())) {
    return {
      enabled: false,
      time: null,
      reason: `4º post desligado (use_melhor_time inválido: ${JSON.stringify(raw)} — esperado "HH:MM")`,
    };
  }
  const time = raw.trim();
  const fallback = (social?.fallback_schedule ?? {}) as Record<string, unknown>;
  const clash = (["d1_time", "d2_time", "d3_time"] as const).find((k) => fallback[k] === time);
  if (clash) {
    return {
      enabled: false,
      time: null,
      reason: `4º post desligado (use_melhor_time ${time} colide com fallback_schedule.${clash} — escolha um slot fora dos destaques)`,
    };
  }
  return { enabled: true, time };
}

/** Lê `platform.config.json` de `rootDir` e devolve o estado. Config ilegível = desligado. */
export function loadUseMelhorPostConfigState(rootDir: string): UseMelhorPostConfigState {
  const path = resolve(rootDir, "platform.config.json");
  try {
    return useMelhorPostConfigState(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    return {
      enabled: false,
      time: null,
      reason: `4º post desligado (platform.config.json ilegível: ${(err as Error).message})`,
    };
  }
}

export interface UseMelhorCandidate {
  url: string;
  title: string;
  summary: string;
  score: number;
}

/**
 * Pure: candidatos do bucket `use_melhor` do JSON aprovado. Item sem `score`
 * numérico ou sem `url` não é candidato (não dá pra ranquear).
 */
export function useMelhorCandidatesFromApproved(approved: unknown): UseMelhorCandidate[] {
  const list = (approved as { use_melhor?: unknown } | null)?.use_melhor;
  if (!Array.isArray(list)) return [];
  const out: UseMelhorCandidate[] = [];
  for (const raw of list) {
    // Tolera o wrapper {article} (formato de highlights) além do item flat.
    const it = (raw && typeof raw === "object" && "article" in raw ? (raw as { article: unknown }).article : raw) as
      | Record<string, unknown>
      | null;
    if (!it) continue;
    const score = (raw as Record<string, unknown>).score ?? it.score;
    if (typeof it.url !== "string" || !it.url || typeof score !== "number" || !Number.isFinite(score)) continue;
    out.push({
      url: it.url,
      title: typeof it.title === "string" ? it.title : "",
      summary: typeof it.summary === "string" ? it.summary : "",
      score,
    });
  }
  return out;
}

/**
 * Pure: normalização mínima pra casar a URL do JSON com a do markdown —
 * host minúsculo, sem `www.`, sem fragmento, sem parâmetros `utm_*`, sem
 * barra final. Não segue redirect nem resolve canônica.
 */
export function normalizeUseMelhorUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Pure: URLs dos itens da seção USE MELHOR renderizada em `02-reviewed.md`,
 * na ordem em que aparecem. `[]` quando a seção não existe ou está vazia.
 */
export function renderedUseMelhorUrls(reviewedMd: string): string[] {
  const section = parseSections(reviewedMd).find((s) => s.name === "USE MELHOR");
  return section ? section.items.map((i) => i.url) : [];
}

export interface UseMelhorSelection {
  item: UseMelhorCandidate | null;
  /** Presente quando `item === null`. */
  reason?: string;
  /** De onde veio a lista de elegíveis. */
  selected_from: "approved" | "reviewed";
}

/**
 * Pure: escolhe o candidato de maior score.
 *
 * `renderedUrls === null` → ainda não há `02-reviewed.md` (Stage 2): todos os
 * candidatos do JSON aprovado são elegíveis. Lista presente (Stages 4/5) →
 * só os candidatos cuja URL aparece renderizada. Empate de score → o que vem
 * primeiro na ordem renderizada (ou na ordem do JSON, no Stage 2).
 */
export function selectUseMelhorItem(
  candidates: UseMelhorCandidate[],
  renderedUrls: string[] | null,
): UseMelhorSelection {
  const selected_from = renderedUrls === null ? "approved" : "reviewed";
  let pool: UseMelhorCandidate[];
  if (renderedUrls === null) {
    pool = candidates;
  } else {
    if (renderedUrls.length === 0) {
      return { item: null, reason: "edição sem seção USE MELHOR renderizada", selected_from };
    }
    const byUrl = new Map(candidates.map((c) => [normalizeUseMelhorUrl(c.url), c]));
    pool = renderedUrls
      .map((u) => byUrl.get(normalizeUseMelhorUrl(u)))
      .filter((c): c is UseMelhorCandidate => c !== undefined);
    if (pool.length === 0) {
      return {
        item: null,
        reason: "nenhum item USE MELHOR renderizado tem score no JSON aprovado (itens colados à mão não são elegíveis)",
        selected_from,
      };
    }
  }
  if (pool.length === 0) {
    return { item: null, reason: "edição sem item USE MELHOR com score", selected_from };
  }
  let best = pool[0];
  for (const c of pool.slice(1)) if (c.score > best.score) best = c;
  return { item: best, selected_from };
}

export interface UseMelhorPostState {
  enabled: boolean;
  time: string | null;
  item: UseMelhorCandidate | null;
  reason?: string;
  selected_from?: "approved" | "reviewed";
  generated_at: string;
}

/** Lê o estado gravado pelo Stage 2. Ausente/ilegível → `null`. */
export function readUseMelhorPostState(editionDir: string): UseMelhorPostState | null {
  const path = useMelhorPostStatePath(editionDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as UseMelhorPostState;
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    console.warn(`use-melhor-post: warn — ${path} não parseou (${(err as Error).message}); tratando como ausente.`);
    return null;
  }
}

export function writeUseMelhorPostState(editionDir: string, state: UseMelhorPostState): string {
  const path = useMelhorPostStatePath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * Lê o JSON aprovado da edição — `01-approved-capped.json` (o que o stitch
 * renderiza) com fallback pro `01-approved.json`. `null` se nenhum existir.
 */
export function readApprovedForUseMelhor(editionDir: string): unknown | null {
  for (const name of ["01-approved-capped.json", "01-approved.json"]) {
    const p = resolve(editionDir, "_internal", name);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Seleção do Stage 2 (sem `02-reviewed.md`). Devolve o estado a gravar.
 * Desligado no config → `enabled: false`, sem item (o chamador não grava nada).
 */
export function computeStage2UseMelhorPostState(
  editionDir: string,
  configState: UseMelhorPostConfigState,
  now: Date = new Date(),
): UseMelhorPostState {
  const generated_at = now.toISOString();
  if (!configState.enabled) {
    return { enabled: false, time: null, item: null, reason: configState.reason, generated_at };
  }
  const approved = readApprovedForUseMelhor(editionDir);
  if (approved === null) {
    return {
      enabled: true,
      time: configState.time,
      item: null,
      reason: "01-approved(-capped).json ausente — 4º post pulado",
      generated_at,
    };
  }
  const sel = selectUseMelhorItem(useMelhorCandidatesFromApproved(approved), null);
  return { enabled: true, time: configState.time, ...sel, generated_at };
}

export interface UseMelhorPostStatusInput {
  config: UseMelhorPostConfigState;
  /** Estado gravado no Stage 2 (`_internal/use-melhor-post.json`), ou `null`. */
  state: UseMelhorPostState | null;
  /** `02-reviewed.md` final, ou `null` se ainda não existe. */
  reviewedMd: string | null;
  /** JSON aprovado (scores), ou `null`. */
  approved: unknown | null;
  /** `## um` presente em `# Social` / `# Curto` de `03-social.md`. */
  hasSocialSection: boolean;
  hasCurtoSection: boolean;
  /** Slots do carrossel gerado no Stage 3 (carimbo), ou `null` se não gerado. */
  carouselSlots: string[] | null;
}

export interface UseMelhorPostStatus {
  /** `off` = desligado no config; `ok` = pronto; `warn` = vai ser pulado/degradado. */
  level: "off" | "ok" | "warn";
  lines: string[];
}

/**
 * Pure: linha(s) do 4º post pro resumo do gate do Stage 4 e pro preview.
 * Nunca bloqueia — `warn` é aviso visível, o 4º post é fail-soft.
 */
export function describeUseMelhorPostStatus(input: UseMelhorPostStatusInput): UseMelhorPostStatus {
  const { config } = input;
  if (!config.enabled) return { level: "off", lines: [config.reason ?? USE_MELHOR_DISABLED_LABEL] };
  const head = `4º post (USE MELHOR) às ${config.time} BRT`;
  if (!input.state) {
    return {
      level: "warn",
      lines: [`⚠️ ${head}: _internal/use-melhor-post.json ausente — o Stage 2 não selecionou o item; 4º post será pulado.`],
    };
  }
  if (!input.state.item) {
    return { level: "warn", lines: [`⚠️ ${head} PULADO: ${input.state.reason ?? "sem item USE MELHOR elegível"}.`] };
  }
  const item = input.state.item;
  const lines: string[] = [`${head}: "${item.title}" (score ${item.score})`, `   ${item.url}`];
  let level: "ok" | "warn" = "ok";

  // Re-seleção contra a edição FINAL — o editor pode ter mexido no USE MELHOR no gate.
  if (input.reviewedMd !== null && input.approved !== null) {
    const final = selectUseMelhorItem(
      useMelhorCandidatesFromApproved(input.approved),
      renderedUseMelhorUrls(input.reviewedMd),
    );
    if (!final.item) {
      level = "warn";
      lines.push(`   ⚠️ na edição final: ${final.reason} — 4º post será pulado.`);
    } else if (normalizeUseMelhorUrl(final.item.url) !== normalizeUseMelhorUrl(item.url)) {
      level = "warn";
      lines.push(
        `   ⚠️ o item de maior score na edição FINAL agora é "${final.item.title}" (score ${final.item.score}) — ` +
          `o texto de '## ${USE_MELHOR_POST_ID}' foi escrito pro item antigo. Re-rodar a seleção ` +
          `(select-use-melhor-post.ts --reviewed) + social-writer/social-curto só pro '## ${USE_MELHOR_POST_ID}'.`,
      );
    }
  }
  if (!input.hasSocialSection) {
    level = "warn";
    lines.push(`   ⚠️ '## ${USE_MELHOR_POST_ID}' ausente em '# Social' — LinkedIn/Facebook/Instagram pulam o 4º post.`);
  }
  if (!input.hasCurtoSection) {
    level = "warn";
    lines.push(`   ⚠️ '## ${USE_MELHOR_POST_ID}' ausente em '# Curto' — X/Threads pulam o 4º post.`);
  }
  if (input.carouselSlots === null) {
    level = "warn";
    lines.push(`   ⚠️ carrossel tipográfico não gerado (Stage 3) — Instagram cai pra imagem única/pula.`);
  } else {
    lines.push(`   carrossel: ${input.carouselSlots.length} slides (${input.carouselSlots.join(" → ")})`);
  }
  if (!USE_MELHOR_STAGE5_DISPATCH_IMPLEMENTED) {
    lines.push(`   ℹ️ dispatch do 4º post no Stage 5 ainda não implementado (#9568) — nada é publicado/agendado por enquanto.`);
  }
  return { level, lines };
}

/** Pure: adiciona `utm_content=usemelhor` à URL (substitui um `utm_content` existente). */
export function withUseMelhorUtm(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_content", USE_MELHOR_UTM_CONTENT);
    return u.toString();
  } catch {
    return url;
  }
}
