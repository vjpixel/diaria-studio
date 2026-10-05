/**
 * use-melhor-post.ts (#9568)
 *
 * 4º post social diário: o item de MAIOR `score` da seção USE MELHOR vira um
 * post próprio (além de D1/D2/D3) em LinkedIn página, Facebook, Instagram
 * (carrossel tipográfico de N slides), Threads e X — num slot único, igual nas
 * 5 redes. Decisões do editor (04/10/2026) no corpo da #9568.
 *
 * ── Ligada/desligada pelo slot `use_melhor_time` ──────────────────────────
 * O horário (`publishing.social.use_melhor_time`) foi fixado em 08:00 BRT
 * pelo editor em 04/10/2026 (comentário `decisao-editor` na #9568). Se a
 * chave voltar a ficar ausente/`null` em
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
 * ── A escolha gravada vale enquanto o item estiver na edição (#9592) ──────
 * O maior score só decide a 1ª escolha. Depois de gravada em
 * `_internal/use-melhor-post.json` — e o `## um` escrito pra ela —, os
 * Stages 4/5 só exigem que o item ESCOLHIDO continue renderizado no USE
 * MELHOR final. Edição 261005: o editor trocou o item à mão (preferiu um
 * passo a passo de score 60 a um de 62) e os 5 canais pularam o 4º post
 * porque a re-seleção por score apontava o outro. Item de score maior na
 * edição final vira só nota informativa no gate; pular continua reservado ao
 * caso em que o item escolhido saiu da edição (o texto falaria de um link que
 * o leitor não vê).
 *
 * ── Tutorial de recurso em descontinuação (#9599) ─────────────────────────
 * A seleção do Stage 2 aceita um filtro de exclusão (`selectUseMelhorItem`
 * `opts.exclude`); o CLI passa o casamento contra notícias de descontinuação
 * das últimas edições (`use-melhor-discontinued.ts`). Item excluído nunca vira
 * o 4º post, mas continua no USE MELHOR (quem tira da edição é o editor).
 *
 * ── Fail-soft ──────────────────────────────────────────────────────────────
 * Sem item elegível → `item: null` + `reason`, o 4º post é pulado com aviso
 * no gate. Nada aqui lança por falta de item: a edição nunca bloqueia por
 * causa do 4º post.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSections } from "./newsletter-parse.ts";

/** Id da seção do 4º post em `03-social.md` (`## um`) — definido no módulo folha. */
export { USE_MELHOR_POST_ID } from "./use-melhor-slide-files.ts";
import { USE_MELHOR_POST_ID } from "./use-melhor-slide-files.ts";

/** `utm_content` próprio do 4º post — mede separado dos destaques. */
export const USE_MELHOR_UTM_CONTENT = "usemelhor";

/**
 * Os publicadores do Stage 5 (LinkedIn página/Facebook/Instagram/Threads/X)
 * despacham o `## um` desde o PR de Stage 5 da #9568 — ver
 * `scripts/lib/use-melhor-dispatch.ts`. O LinkedIn PESSOAL (vjpixel) segue
 * manual (lembrete no gate do Stage 6): o Worker `linkedin-cron` recusa
 * `webhook_target=pixel` + `action=post` e a API direta só tem 1 autor
 * (`LINKEDIN_AUTHOR_URN`, a página).
 */
export const USE_MELHOR_STAGE5_DISPATCH_IMPLEMENTED = true;

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
  /**
   * Título da capa do carrossel (#9600), opcional — o editor pode gravar à mão
   * em `_internal/use-melhor-post.json`. Ver `resolveUseMelhorCoverTitle`.
   */
  cover_title?: string;
  /** #9585: passos do tutorial extraídos da fonte, na ordem. Ausente = fonte sem passos (formato atual). */
  steps?: string[];
  /** #9585: trecho do corpo da fonte (contexto pro writer; nunca fonte de fatos além dos passos). */
  body?: string;
}

const STEP_LINE = /^(?:(?:passo|etapa|step)\s*(\d{1,2})\b\s*[:.)\-–—]?\s*|(\d{1,2})\s*[.)]\s+)(.{3,})$/i;

/**
 * Pure (#9585): extrai os passos numerados do texto da fonte, na ordem.
 * Aceita "Passo 1: ...", "Etapa 2 ...", "Step 3 ..." e "1. ..."/"1) ...".
 * Só devolve uma sequência que comece em 1 e seja consecutiva (>=2 passos) —
 * numeração solta (ano, ranking) não vira passo. Sem passos → `[]`.
 */
export function extractUseMelhorSteps(text: string): string[] {
  // Várias listas numeradas (sumário, requisitos, passos): coleta cada run 1..N
  // consecutivo e fica com a mais longa (empate → a última). Linha não-passo
  // entre dois passos não quebra o run (passos têm parágrafos de explicação).
  const runs: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(STEP_LINE);
    if (!m) continue;
    const n = Number(m[1] ?? m[2]);
    if (n === 1) {
      if (cur.length) runs.push(cur);
      cur = [m[3].trim()];
    } else if (cur.length && n === cur.length + 1) {
      cur.push(m[3].trim());
    }
  }
  if (cur.length) runs.push(cur);
  let best: string[] = [];
  for (const r of runs) if (r.length >= best.length) best = r;
  return best.length >= 2 ? best : [];
}

export const USE_MELHOR_BODY_MAX_CHARS = 6000;

/** Pure (#9585): anexa `steps` (só se houver) e `body` ao item. */
export function enrichUseMelhorItem(item: UseMelhorCandidate, text: string): UseMelhorCandidate {
  const steps = extractUseMelhorSteps(text);
  const out: UseMelhorCandidate = { ...item, body: text.slice(0, USE_MELHOR_BODY_MAX_CHARS) };
  if (steps.length) out.steps = steps;
  return out;
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
  /** Candidatos que o filtro `opts.exclude` tirou da disputa (#9599). */
  excluded?: Array<{ url: string; title: string; reason: string }>;
}

export interface UseMelhorSelectOptions {
  /**
   * Devolve um motivo (string) pra tirar o candidato da disputa do 4º post, ou
   * `null` pra mantê-lo. Usado pelo filtro de recurso em descontinuação (#9599).
   */
  exclude?: (c: UseMelhorCandidate) => string | null;
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
  opts: UseMelhorSelectOptions = {},
): UseMelhorSelection {
  const selected_from = renderedUrls === null ? "approved" : "reviewed";
  const excluded: NonNullable<UseMelhorSelection["excluded"]> = [];
  if (opts.exclude) {
    candidates = candidates.filter((c) => {
      const why = opts.exclude!(c);
      if (why === null) return true;
      excluded.push({ url: c.url, title: c.title, reason: why });
      return false;
    });
  }
  const withExcluded = (sel: UseMelhorSelection): UseMelhorSelection =>
    excluded.length > 0 ? { ...sel, excluded } : sel;
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
      return withExcluded({
        item: null,
        reason:
          excluded.length > 0
            ? "nenhum item USE MELHOR renderizado elegível (os com score foram excluídos: " +
              excluded.map((e) => `"${e.title}" — ${e.reason}`).join("; ") +
              ")"
            : "nenhum item USE MELHOR renderizado tem score no JSON aprovado (itens colados à mão não são elegíveis)",
        selected_from,
      });
    }
  }
  if (pool.length === 0) {
    return withExcluded({
      item: null,
      reason:
        excluded.length > 0
          ? "todos os itens USE MELHOR com score foram excluídos (" +
            excluded.map((e) => `"${e.title}" — ${e.reason}`).join("; ") +
            ")"
          : "edição sem item USE MELHOR com score",
      selected_from,
    });
  }
  let best = pool[0];
  for (const c of pool.slice(1)) if (c.score > best.score) best = c;
  return withExcluded({ item: best, selected_from });
}

export type UseMelhorFinalCheck =
  | { ok: true; rendered_urls: string[] }
  | { ok: false; reason: string };

/**
 * Pure (#9592): o item ESCOLHIDO (gravado no Stage 2, ou trocado à mão pelo
 * editor) ainda está renderizado no USE MELHOR do `02-reviewed.md` final?
 * É essa a condição pra o 4º post sair — não "ser o de maior score".
 */
export function checkUseMelhorItemInFinal(item: UseMelhorCandidate, reviewedMd: string): UseMelhorFinalCheck {
  const rendered = renderedUseMelhorUrls(reviewedMd);
  if (rendered.length === 0) return { ok: false, reason: "edição sem seção USE MELHOR renderizada" };
  const target = normalizeUseMelhorUrl(item.url);
  if (!rendered.some((u) => normalizeUseMelhorUrl(u) === target)) {
    return {
      ok: false,
      reason:
        `o item para o qual '## ${USE_MELHOR_POST_ID}' foi escrito ("${item.title}") não está mais no USE MELHOR ` +
        `da edição final — re-rodar a seleção (select-use-melhor-post.ts --reviewed) + social-writer/social-curto ` +
        `só pro '## ${USE_MELHOR_POST_ID}'`,
    };
  }
  return { ok: true, rendered_urls: rendered };
}

/**
 * Pure (#9592): quando o item escolhido segue na edição mas NÃO é o de maior
 * score entre os renderizados (escolha do editor, ou item novo colado no
 * gate), devolve o de maior score pra uma nota informativa. `null` caso
 * contrário.
 */
export function higherScoredRenderedItem(
  item: UseMelhorCandidate,
  approved: unknown,
  reviewedMd: string,
): UseMelhorCandidate | null {
  const top = selectUseMelhorItem(useMelhorCandidatesFromApproved(approved), renderedUseMelhorUrls(reviewedMd)).item;
  if (!top || normalizeUseMelhorUrl(top.url) === normalizeUseMelhorUrl(item.url)) return null;
  return top;
}

/**
 * Pure (#9600): título da capa do carrossel do 4º post. Ordem:
 *   1. `item.cover_title` — gravado à mão em `use-melhor-post.json`;
 *   2. `item.title`, quando o editor o editou (difere do título do mesmo link
 *      no JSON aprovado) — o contorno usado na 261005 continua valendo;
 *   3. o título do item no USE MELHOR do `02-reviewed.md` — é o texto que o
 *      leitor vê na edição (revisado/traduzido no gate), não o da fonte;
 *   4. `item.title` (título da fonte).
 * Mesma função pra quem GERA (Stage 3) e pra quem confere o carimbo
 * (Stages 4/5) — divergir aqui marcaria toda arte como defasada. Desde o
 * #9630 o Stage 3 grava o título resolvido no carimbo (`cover_title`) e a
 * conferência usa o gravado; o resolvido aqui só vale pra carimbo antigo.
 */
export function resolveUseMelhorCoverTitle(
  item: UseMelhorCandidate,
  ctx: { reviewedMd: string | null; approved: unknown | null },
): string {
  const manual = typeof item.cover_title === "string" ? item.cover_title.trim() : "";
  if (manual) return manual;
  const key = normalizeUseMelhorUrl(item.url);
  if (ctx.approved !== null) {
    const source = useMelhorCandidatesFromApproved(ctx.approved).find((c) => normalizeUseMelhorUrl(c.url) === key);
    if (source && source.title.trim() && source.title.trim() !== item.title.trim()) return item.title;
  }
  if (ctx.reviewedMd !== null) {
    const section = parseSections(ctx.reviewedMd).find((s) => s.name === "USE MELHOR");
    const rendered = section?.items.find((i) => normalizeUseMelhorUrl(i.url) === key);
    const t = rendered?.title.replace(/\*\*/g, "").trim();
    if (t) return t;
  }
  return item.title;
}

export interface UseMelhorPostState {
  enabled: boolean;
  time: string | null;
  item: UseMelhorCandidate | null;
  reason?: string;
  /**
   * `approved`/`reviewed` quando gravado pelo seletor. Outros valores (ex.:
   * `editor-override-*`) marcam troca manual do editor — vale igual (#9592).
   */
  selected_from?: string;
  excluded?: UseMelhorSelection["excluded"];
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
  selectOpts: UseMelhorSelectOptions = {},
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
  const sel = selectUseMelhorItem(useMelhorCandidatesFromApproved(approved), null, selectOpts);
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
  /**
   * `true` quando o `## um` mudou depois do Stage 3 (hash do texto atual ≠
   * carimbo) — a arte gerada tem o texto antigo. Self-review #9572, finding 1.
   */
  carouselStale?: boolean;
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

  // Conferência contra a edição FINAL (#9592): o item ESCOLHIDO precisa seguir
  // renderizado no USE MELHOR. Ser o de maior score não é exigido — a escolha
  // do editor vale; score maior vira só nota.
  if (input.reviewedMd !== null) {
    const final = checkUseMelhorItemInFinal(item, input.reviewedMd);
    if (!final.ok) {
      level = "warn";
      lines.push(`   ⚠️ na edição final: ${final.reason} — 4º post será pulado.`);
    } else if (input.approved !== null) {
      const top = higherScoredRenderedItem(item, input.approved, input.reviewedMd);
      if (top) {
        lines.push(
          `   ℹ️ "${top.title}" (score ${top.score}) tem score maior na edição final — o 4º post segue com o ` +
            `item escolhido, pro qual '## ${USE_MELHOR_POST_ID}' foi escrito.`,
        );
      }
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
  } else if (input.carouselStale) {
    level = "warn";
    lines.push(
      `   ⚠️ carrossel (${input.carouselSlots.length} slides) DEFASADO: '## ${USE_MELHOR_POST_ID}' mudou depois do Stage 3 — ` +
        `a arte tem o texto antigo. Re-rodar "npx tsx scripts/gen-carousel-cards.ts --edition-dir {edição}".`,
    );
  } else {
    lines.push(`   carrossel: ${input.carouselSlots.length} slides (${input.carouselSlots.join(" → ")})`);
  }
  if (!USE_MELHOR_STAGE5_DISPATCH_IMPLEMENTED) {
    lines.push(`   ℹ️ dispatch do 4º post no Stage 5 ainda não implementado (#9568) — nada é publicado/agendado por enquanto.`);
  } else {
    lines.push(
      `   ℹ️ Stage 5 agenda às ${config.time} BRT em LinkedIn página/Facebook/Instagram/Threads/X; ` +
        `LinkedIn pessoal (vjpixel) é manual, mesmo texto — lembrete no gate do Stage 6.`,
    );
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
