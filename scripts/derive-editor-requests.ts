#!/usr/bin/env tsx
/**
 * derive-editor-requests.ts (#5731)
 *
 * Deriva pedidos editoriais de forma determinística a partir do diff entre
 * snapshots pós-geração (Stage 2/4) e o estado atual no gate (Stage 4/6).
 *
 * O problema original (#5731): a captura via `log-editor-request.ts` manual
 * quase não roda — depende do orchestrator LEMBRAR de chamar o script no meio
 * da conversa. A solução é derivar os pedidos do diff, não da memória do agente.
 *
 * Dois pontos de snapshot:
 * 1. Pós-Stage 2 (após gate unificado) — snapshot de 02-reviewed.md, 03-social.md,
 *    _internal/01-approved.json
 * 2. Pós-Stage 4 pre-render — snapshot de _internal/newsletter-final.html,
 *    _internal/social-preview.html
 *
 * Três pontos de diff:
 * - Stage 1 gate (#7964): diff de `01-categorized.json` (pré-gate, já é o
 *   baseline imutável — nenhum snapshot dedicado necessário) ×
 *   `01-approved.json` pós-gate. Só roda quando `.step-1-gate.json` marca
 *   `auto_approved: false` (gate humano real aconteceu) — ver `deriveStage1`.
 * - Stage 4 gate: diff dos snapshots Stage 2 vs estado atual (02-reviewed.md,
 *   03-social.md) + diff dos snapshots Stage 4 pre-render vs estado atual
 * - Stage 6 gate: diff adicional se houver mudanças pós-Stage 4
 *
 * Classificação usando a taxonomia existente de log-editor-request.ts.
 * Escrita no mesmo editor-requests.jsonl com source: "derived".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { appendEditorRequest, type EditorRequestEntry, type RequestType, type RequestTarget, type Resolution, type RequestSource } from "./log-editor-request.ts";
import {
  destaqueUrlMapFromApproved,
  isDestaqueSection,
  matchSections,
  parseSocialSections,
  type SectionPair,
} from "./lib/social-rewrite-diff.ts";
import { canonicalizeUrl } from "./apply-gate-edits.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  SNAPSHOT_DIR,
  STAGE2_BASELINE_LABEL,
  STAGE2_SNAPSHOT_FILES,
  STAGE4_BACKFILL_MARKER,
  STAGE4_POST_GATE_LABEL,
  assessStage2BaselineOnDisk,
  captureStage2Baseline,
  createSnapshots,
  hasSnapshot,
  readSnapshots,
} from "./lib/editor-request-snapshots.ts";
import {
  applyAutofixReplacements,
  normalizeNewsletterForComparison,
  reconstructStage2Newsletter,
  type AutofixReplacement,
  type TitlePick,
} from "./lib/manual-edit-diff.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Arquivos para snapshots pós-Stage 2: `STAGE2_SNAPSHOT_FILES` em `lib/editor-request-snapshots.ts` (#9356). */

/** Arquivos para snapshots pós-Stage 4 pre-render */
const STAGE4_SNAPSHOT_FILES = [
  "_internal/newsletter-final.html",
  "_internal/social-preview.html",
] as const;

/** Tipos de request mapeados por arquivo e padrão de mudança */
interface DiffClassifier {
  file: string;
  classify: (oldContent: string, newContent: string) => Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }>;
}

/**
 * Normaliza um cabeçalho de seção pra uma chave estável: remove acentos,
 * emoji e pontuação, espaços viram hífen. Extraída como função nomeada
 * (#7974) porque o bug original ("eia-choice" nunca disparava) era
 * exatamente comparar o resultado desta normalização contra uma string
 * escrita à mão em outro lugar do arquivo ("eia") que nunca bateu com o
 * valor real produzido ("é-ia?" sem stripping de acento/pontuação, na
 * versão anterior). Compilar a chave de comparação com a MESMA função
 * elimina a classe de bug — não só o caso "É IA?".
 */
const SECTION_EMOJI_RE = /[🚀💼🎓🔬📹🎁🙋]/g;
const COMBINING_DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");
function normalizeSectionKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS_RE, "") // remove diacríticos (ex: É → E) antes do resto
    .toLowerCase()
    .replace(SECTION_EMOJI_RE, "")
    .replace(/[^a-z0-9\s-]/g, "") // remove pontuação (?, |, etc.), preserva espaço/hífen
    .replace(/\s+/g, "-")
    .trim();
}
/** Chave normalizada de "É IA?" — computada, nunca hardcoded separadamente (#7974). */
const EIA_SECTION_KEY = normalizeSectionKey("É IA?");

/**
 * #8694: decide se duas linhas de URL do markdown do destaque apontam para
 * ARTIGOS diferentes (troca de destaque) ou pro mesmo artigo com URL
 * levemente diferente (tracking param trocado, redirect, protocolo — mero
 * `link-swap`). Compara host + pathname canonicalizados (via
 * `canonicalizeUrl`, que já normaliza tracking/whitespace) — query string e
 * hash NUNCA entram na comparação, de propósito: são exatamente o tipo de
 * diferença que não muda de QUAL artigo se trata. Extrai a 1ª URL de cada
 * linha (a linha pode ter markdown ao redor); se qualquer lado não parsear
 * como URL válida, assume "mesmo artigo" (fail-safe pro comportamento
 * anterior — `link-swap`, nunca `destaque-swap` por engano de parsing).
 */
function isDifferentArticleUrl(oldLine: string, newLine: string): boolean {
  const extractUrl = (line: string): string | null => {
    const match = line.match(/https?:\/\/\S+/);
    return match ? match[0].replace(/[)\].,;]+$/, "") : null;
  };
  const oldUrl = extractUrl(oldLine);
  const newUrl = extractUrl(newLine);
  if (!oldUrl || !newUrl) return false;
  try {
    const oldParsed = new URL(canonicalizeUrl(oldUrl));
    const newParsed = new URL(canonicalizeUrl(newUrl));
    const oldKey = `${oldParsed.hostname.replace(/^www\./, "")}${oldParsed.pathname.replace(/\/+$/, "")}`;
    const newKey = `${newParsed.hostname.replace(/^www\./, "")}${newParsed.pathname.replace(/\/+$/, "")}`;
    return oldKey !== newKey;
  } catch {
    return false;
  }
}

/**
 * #9936: as duas linhas de URL apontam pra MESMA história via `story`
 * (alias de troca de fonte vindo do `01-approved.json`)? Sem URL parseável → false.
 */
function isSameStoryUrl(oldLine: string, newLine: string, story: (key: string) => string): boolean {
  const extract = (line: string) => line.match(/https?:\/\/\S+/)?.[0].replace(/[)\].,;]+$/, "") ?? null;
  const o = extract(oldLine);
  const n = extract(newLine);
  return !!o && !!n && story(articleUrlKey(n)) === story(articleUrlKey(o));
}

/**
 * Chave de identidade do artigo: host (sem www) + path (sem barra final),
 * via `canonicalizeUrl` — query/hash/protocolo não entram, como em
 * `isDifferentArticleUrl`. URL que não parseia vira a própria string crua.
 */
function articleUrlKey(url: string): string {
  try {
    const u = new URL(canonicalizeUrl(url));
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

/** Chave host+path (sem www/query/tracking, como `isDifferentArticleUrl`) do link do título `**[t](url)**`; `null` sem link. */
function titleLineUrlKey(line: string): string | null {
  const m = line.match(/\]\((https?:[^)\s]+)\)/);
  if (!m) return null;
  try {
    const u = new URL(canonicalizeUrl(m[1]));
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Seções de pool (chave de `normalizeSectionKey`): um título por item, sem 3 opções. */
const POOL_SECTION_KEYS: ReadonlySet<string> = new Set(["use-melhor", "lancamentos", "lancamento", "radar", "videos"]);

/**
 * #9879/#9880: compara o CONJUNTO de itens (chave host+path do link do título)
 * de uma seção de pool antes/depois. `null` quando o conjunto é igual — aí a
 * classificação por texto (ex: `length-cut` de descrição encurtada) segue
 * valendo. Antes, item cortado encolhia a seção >30% e virava `length-cut`
 * apontando pro `writer-destaque.md`, que nem escreve o pool.
 *
 * #9943 — `elsewhere` (opcional): chaves dos itens que estão em OUTRAS seções
 * (pool ou destaque) antes (`before`) e depois (`after`). Item que saiu desta
 * seção mas segue em outra (`movedOut`) ou entrou vindo de outra (`movedIn`)
 * só mudou de seção — não conta em `removed`/`added`. Quando só houve
 * movimentação, devolve `bucket-move`/`itens-movidos` com `removed = added = 0`.
 */
export function classifyPoolItemSetChange(
  oldText: string,
  newText: string,
  elsewhere?: { before: ReadonlySet<string>; after: ReadonlySet<string> },
): { type: RequestType; kind: string; removed: number; added: number; movedIn: string[]; movedOut: string[] } | null {
  const before = new Set(sectionItemKeys(oldText));
  const after = new Set(sectionItemKeys(newText));
  const removedAll = [...before].filter((k) => !after.has(k));
  const addedAll = [...after].filter((k) => !before.has(k));
  const movedOut = removedAll.filter((k) => elsewhere?.after.has(k) ?? false);
  const movedIn = addedAll.filter((k) => elsewhere?.before.has(k) ?? false);
  const removed = removedAll.length - movedOut.length;
  const added = addedAll.length - movedIn.length;
  const moved = { movedIn, movedOut };
  if (removed === 0 && added === 0) {
    return movedIn.length === 0 && movedOut.length === 0 ? null : { type: "bucket-move", kind: "itens-movidos", removed, added, ...moved };
  }
  if (added === 0) return { type: "pool-cut", kind: "itens-cortados", removed, added, ...moved };
  if (removed === 0) return { type: "pool-add", kind: "itens-adicionados", removed, added, ...moved };
  return { type: "link-swap", kind: "itens-trocados", removed, added, ...moved };
}

/** Chaves host+path (`titleLineUrlKey`) das linhas de título `**[t](url)**` de uma seção, na ordem. */
function sectionItemKeys(text: string): string[] {
  return text.split("\n").filter((l) => l.trim().startsWith("**[")).map(titleLineUrlKey).filter((k): k is string => !!k);
}

/** Seção de pool da newsletter → `target` da taxonomia (mesmo vocabulário de `POOL_BUCKET_TARGETS`). */
const POOL_SECTION_TARGETS: Readonly<Record<string, RequestTarget>> = {
  "use-melhor": "use-melhor",
  lancamentos: "lancamentos",
  lancamento: "lancamentos",
  radar: "radar",
  videos: "video",
};

/**
 * #9936: o destaque novo é a MESMA história do que saiu, só com outra URL
 * (tipicamente o editor troca a cobertura de imprensa pelo post oficial)?
 *
 * Sinal: o editor edita a URL no lugar, e o item novo HERDA a pontuação do
 * antigo — `score` igual E um sinal de identidade (critério atual no
 * parágrafo #9942 abaixo). Dado real (261006 d1, 261007 d2, 261008 d1): os
 * três herdam score, score_base e bonuses; 261007 também ganha
 * `source: "official: OpenAI"`. Item que entrou de fora dos finalistas não
 * herda nada (261008 Nano Banana 2.1: `score: null`) — esse continua sendo
 * `destaque-swap`. `score` igual sozinho não basta (scores colidem à toa).
 *
 * #9942: sem bônus, `score === score_base` e a comparação de base/bônus não
 * acrescentava nada ao `score` igual — 75/75 × 75/75 de histórias distintas
 * virava `link-swap`. O mesmo valia pro ramo `source: "official: ..."`, que
 * sozinho aceitava qualquer score igual (radar 78 de 261007). Hoje, além do
 * `score` igual, exige UM sinal de identidade da história:
 * - `score_base` igual E `bonuses_applied` NÃO VAZIO e igual (os três casos
 *   reais têm bônus); ou
 * - título igual (o editor trocou só a URL, o título ficou); ou
 * - a URL nova está nas `cluster_sources` do item antigo (ou vice-versa) —
 *   esse dispensa o score.
 * `official:` deixou de ser sinal suficiente; só muda a descrição.
 */
function inheritsScoring(outH: any, innH: any): boolean {
  const a = outH?.article ?? outH ?? {};
  const b = innH?.article ?? innH ?? {};
  if (clusterLinked(a, outH, b, innH)) return true;
  const score = (h: any, x: any) => (typeof x?.score === "number" ? x.score : typeof h?.score === "number" ? h.score : null);
  const sa = score(outH, a);
  const sb = score(innH, b);
  if (sa === null || sb === null || sa !== sb) return false;
  const bonusesA = Array.isArray(a.bonuses_applied) ? a.bonuses_applied : [];
  const sameBase = typeof a.score_base === "number" && a.score_base === b.score_base &&
    bonusesA.length > 0 && JSON.stringify(bonusesA) === JSON.stringify(b.bonuses_applied ?? null);
  const titleOf = (x: any, h: any) => String(x?.title ?? h?.title ?? "").trim().toLowerCase();
  const ta = titleOf(a, outH);
  const sameTitle = ta !== "" && ta === titleOf(b, innH);
  return sameBase || sameTitle;
}

/** #9942: a URL de um lado aparece nas `cluster_sources` do outro (mesma história, outra fonte). */
function clusterLinked(a: any, outH: any, b: any, innH: any): boolean {
  const urlOf = (x: any, h: any) => {
    const u = x?.url ?? h?.url;
    return typeof u === "string" && u !== "" ? articleUrlKey(u) : null;
  };
  const clusterKeys = (x: any, h: any) =>
    new Set(
      [...(x?.cluster_sources ?? []), ...(h?.cluster_sources ?? [])]
        .map((cs: any) => (typeof cs?.url === "string" && cs.url !== "" ? articleUrlKey(cs.url) : null))
        .filter((k): k is string => k !== null),
    );
  const ua = urlOf(a, outH);
  const ub = urlOf(b, innH);
  if (!ua || !ub) return false;
  return clusterKeys(a, outH).has(ub) || clusterKeys(b, innH).has(ua);
}

/**
 * #9936: pares (saiu → entrou) do `01-approved.json` que são troca de fonte da
 * MESMA história (`inheritsScoring`). Casamento guloso, na ordem: cada item que
 * entrou fica com o 1º item que saiu e cuja pontuação ele herda.
 */
function matchSourceUpgrades<T extends { h: any }>(left: T[], entered: T[]): Array<{ out: T; inn: T }> {
  const used = new Set<T>();
  const pairs: Array<{ out: T; inn: T }> = [];
  for (const inn of entered) {
    const out = left.find((o) => !used.has(o) && inheritsScoring(o.h, inn.h));
    if (out) {
      used.add(out);
      pairs.push({ out, inn });
    }
  }
  return pairs;
}

/**
 * #9936: mapa `chave do link novo → chave do link antigo` (host+path, como
 * `articleUrlKey`) das trocas de fonte da mesma história entre dois estados do
 * `01-approved.json`. Consumido por `classifyNewsletterDiff`, que só vê
 * markdown e não tem score: com o mapa, a URL oficial nova conta como o mesmo
 * item que a de imprensa antiga (reordenação continua `section-order`, troca
 * no mesmo slot vira `link-swap`, nunca `destaque-swap`). JSON inválido/ausente
 * → mapa vazio (comportamento anterior).
 */
export function sourceUpgradeAliases(oldContent: string | undefined, newContent: string | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!oldContent || !newContent) return aliases;
  try {
    const oldH: any[] = JSON.parse(oldContent)?.highlights ?? [];
    const newH: any[] = JSON.parse(newContent)?.highlights ?? [];
    const keyOf = (h: any): string | null => {
      const url = h?.article?.url ?? h?.url;
      return typeof url === "string" && url !== "" ? articleUrlKey(url) : null;
    };
    const oldKeys = oldH.map(keyOf);
    const newKeys = newH.map(keyOf);
    const left = oldH.map((h, i) => ({ h, key: oldKeys[i] })).filter((x) => x.key !== null && !newKeys.includes(x.key));
    const entered = newH.map((h, i) => ({ h, key: newKeys[i] })).filter((x) => x.key !== null && !oldKeys.includes(x.key));
    for (const { out, inn } of matchSourceUpgrades(left, entered)) aliases.set(inn.key!, out.key!);
  } catch {
    // JSON inválido — sem aliases.
  }
  return aliases;
}

/**
 * Classifica diferenças no 02-reviewed.md (newsletter)
 *
 * `sameStory` (#9936, opcional): `sourceUpgradeAliases` do `01-approved.json`
 * — chave do link novo → chave do link antigo quando é a MESMA história com
 * outra URL. Sem ele, troca de fonte vira `destaque-swap` (comportamento
 * anterior).
 */
export function classifyNewsletterDiff(
  oldContent: string,
  newContent: string,
  sameStory?: ReadonlyMap<string, string>,
): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  // Helper para extrair seções do markdown
  const extractSections = (content: string): Map<string, string> => {
    const sections = new Map<string, string>();
    const lines = content.split("\n");
    let currentSection = "intro";
    let currentContent: string[] = [];

    for (const line of lines) {
      // Match headers like **DESTAQUE 1 | 🚀 LANÇAMENTO** or **É IA?** etc.
      // #9356: o cabeçalho REAL das seções leva emoji na frente
      // (`**📡 RADAR**`, `**🛠️ USE MELHOR**`, `**🚀 LANÇAMENTO**` no singular)
      // — sem aceitar esse prefixo, nenhuma seção depois do DESTAQUE 3 era
      // reconhecida e todo corte/movimentação no RADAR/USE MELHOR caía como
      // "lead-rewrite" do d3. ERRO INTENCIONAL ganha seção própria pelo
      // mesmo motivo (senão o preenchimento do erro virava link-swap no RADAR).
      const headerMatch = line.match(/^\*\*(?:[^\p{L}\p{N}*]+)?((DESTAQUE \d+)(?:\s*\|\s*[^*]*)?|É IA\?|USE MELHOR|LANÇAMENTOS?|RADAR|VÍDEOS|SORTEIO|PARA ENCERRAR|ERRO INTENCIONAL)\*\*$/u);
      if (headerMatch) {
        if (currentContent.length > 0) {
          sections.set(currentSection, currentContent.join("\n"));
        }
        // Normalize section name: "DESTAQUE 1 | 🚀 LANÇAMENTO" -> "destaque-1"
        const rawSection = headerMatch[1];
        if (rawSection.startsWith("DESTAQUE ")) {
          const numMatch = rawSection.match(/DESTAQUE (\d+)/);
          currentSection = numMatch ? `destaque-${numMatch[1]}` : rawSection.toLowerCase().replace(/\s+/g, "-");
        } else {
          currentSection = normalizeSectionKey(rawSection);
        }
        currentContent = [line];
      } else {
        currentContent.push(line);
      }
    }
    if (currentContent.length > 0) {
      sections.set(currentSection, currentContent.join("\n"));
    }
    return sections;
  };

  // #9753: CRLF→LF antes de tudo — com `\r` no fim da linha o regex de
  // cabeçalho (`\*\*$`) não casa nenhuma seção e o arquivo inteiro vira um
  // único `other` em `intro` (dado real: 260903/02-reviewed.md, 165 linhas CRLF).
  const oldSections = extractSections(oldContent.replace(/\r\n?/g, "\n"));
  const newSections = extractSections(newContent.replace(/\r\n?/g, "\n"));
  /** #9936: chave de HISTÓRIA — a URL nova de uma troca de fonte resolve pra antiga. */
  const story = (key: string): string => sameStory?.get(key) ?? key;

  // #9943: em que seção (pool ou destaque) cada item está, antes e depois —
  // item que só mudou de seção não é corte nem adição no pool.
  const locateItems = (sections: Map<string, string>): Map<string, string> => {
    const where = new Map<string, string>();
    for (const [sec, text] of sections) {
      if (!POOL_SECTION_KEYS.has(sec) && !sec.startsWith("destaque-")) continue;
      for (const k of sectionItemKeys(text)) if (!where.has(k)) where.set(k, sec);
    }
    return where;
  };
  const oldWhere = locateItems(oldSections);
  const newWhere = locateItems(newSections);
  const keysOutside = (where: Map<string, string>, section: string) =>
    new Set([...where].filter(([, sec]) => sec !== section).map(([k]) => k));
  const newItemUrls = new Map<string, string>();
  for (const [, text] of newSections) {
    for (const line of text.split("\n")) {
      const k = line.trim().startsWith("**[") ? titleLineUrlKey(line) : null;
      const url = k ? line.match(/\]\((https?:[^)\s]+)\)/)?.[1] : undefined;
      if (k && url && !newItemUrls.has(k)) newItemUrls.set(k, url);
    }
  }

  // Detectar mudanças por seção
  for (const [section, newText] of newSections) {
    const oldText = oldSections.get(section) ?? "";
    if (oldText === newText) continue;

    // Determinar target baseado na seção
    let target: RequestTarget = "newsletter";
    let requestType: RequestType = "other";

    if (section.startsWith("destaque-")) {
      const numMatch = section.match(/destaque-(\d+)/);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        target = `d${num}` as RequestTarget;
      }
      requestType = "lead-rewrite"; // default para mudanças em destaque
    } else if (section === EIA_SECTION_KEY) {
      target = "eia";
      requestType = "eia-choice";
    } else if (section === "use-melhor") {
      target = "use-melhor";
      requestType = "destaque-promote";
    } else if (section === "lancamentos" || section === "lancamento") {
      target = "lancamentos";
      requestType = "link-swap";
    } else if (section === "radar") {
      target = "radar";
      requestType = "link-swap";
    } else if (section === "videos" || section === "vídeos") {
      target = "newsletter";
      requestType = "link-swap";
    } else if (section === "para-encerrar") {
      target = "newsletter";
      requestType = "section-order";
    }

    // Tentar classificar melhor o tipo de mudança
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Verificar se título mudou (linha do título do destaque - primeira linha após header que começa com ** e tem link)
    const oldTitleLine = oldLines.find(l => l.trim().startsWith("**[") && l.includes("]("));
    const newTitleLine = newLines.find(l => l.trim().startsWith("**[") && l.includes("]("));
    const titleChanged = !!(oldTitleLine && newTitleLine && oldTitleLine !== newTitleLine);
    // #9879: "title-choice" só existe em destaque (3 opções de título → 1).
    // Seção de pool tem um título por item; a 1ª linha `**[` mudar ali é item
    // cortado/trocado, não escolha de título (dado real: radar de 261001 e
    // 261008, use-melhor de 261005, lancamentos de 261002).
    if (titleChanged && section.startsWith("destaque-")) {
      requestType = "title-choice";
    }

    // #9717: casar por URL, nunca por posição. Comparar `destaque-N` com
    // `destaque-N` rotulava troca de item e reordenação como "title-choice"
    // (medição #9693: 15/18 eram item trocado, 2/18 reordenação, 1/18 título).
    // `urlClass` vence as checagens posteriores desta seção (como `destaque-swap`).
    let urlClass: { type: RequestType; kind: string } | null = null;
    if (section.startsWith("destaque-") && titleChanged) {
      const oldKey = titleLineUrlKey(oldTitleLine!);
      const newKey = titleLineUrlKey(newTitleLine!);
      if (oldKey && newKey) {
        if (oldKey === newKey) {
          // Mesma página: só é título reescrito se o TEXTO do link mudou (query/tracking é link-swap).
          const text = (l: string) => l.match(/^\*\*\[(.+)\]\(/)?.[1]?.trim();
          // #9753: sem este `else`, URL trocada da mesma página ficava `title-choice`.
          if (text(oldTitleLine!) !== text(newTitleLine!)) urlClass = { type: "title-choice", kind: "titulo-reescrito" };
          else urlClass = { type: "link-swap", kind: "link-trocado" };
        } else if (story(newKey) === story(oldKey)) {
          // #9936: mesma história, outra URL (ex.: imprensa → post oficial). Troca de link, não de destaque.
          urlClass = { type: "link-swap", kind: "fonte-trocada" };
        } else {
          const keyOf = (t: string) => {
            const k = titleLineUrlKey(t.split("\n").find(l => l.trim().startsWith("**[") && l.includes("](")) ?? "");
            return k === null ? null : story(k);
          };
          const destaqueKeys = (m: Map<string, string>, skip?: string) =>
            [...m].filter(([k]) => k.startsWith("destaque-") && k !== skip).map(([, t]) => keyOf(t));
          // Reordenação só se o item novo já existia em outro slot ANTES e o item
          // antigo deste slot ainda existe DEPOIS; senão houve troca (mesmo com movimentação junto).
          // #9936: chaves passam por `story` — a URL oficial nova conta como o item de imprensa antigo.
          const elsewhere =
            destaqueKeys(oldSections, section).includes(story(newKey)) && destaqueKeys(newSections, section).includes(story(oldKey));
          urlClass = elsewhere
            ? { type: "section-order", kind: "reordenado" }
            : { type: "destaque-swap", kind: "item-trocado" };
        }
      }
    } else if (
      section.startsWith("destaque-") &&
      !titleChanged &&
      oldLines[0] !== newLines[0] &&
      oldLines.slice(1).join("\n") === newLines.slice(1).join("\n")
    ) {
      urlClass = { type: "bucket-move", kind: "categoria-trocada" };
    }

    // Verificar se "Por que isso importa" mudou
    const oldWhyIdx = oldLines.findIndex(l => l.includes("Por que isso importa"));
    const newWhyIdx = newLines.findIndex(l => l.includes("Por que isso importa"));
    if (oldWhyIdx >= 0 && newWhyIdx >= 0 && oldLines[oldWhyIdx] !== newLines[newWhyIdx]) {
      requestType = "lead-rewrite";
    }

    // Verificar se URL mudou
    const oldUrlLine = oldLines.find(l => l.trim().startsWith("http"));
    const newUrlLine = newLines.find(l => l.trim().startsWith("http"));
    const urlChanged = !!(oldUrlLine && newUrlLine && oldUrlLine !== newUrlLine);
    if (urlChanged) {
      requestType = "link-swap";
    }

    // Verificar tamanho (corte/alongamento)
    const oldLen = oldText.length;
    const newLen = newText.length;
    if (newLen < oldLen * 0.7) {
      requestType = "length-cut";
    } else if (newLen > oldLen * 1.3) {
      requestType = "lead-rewrite";
    }

    // #8694: distinguir "editor reescreveu o lead/1º parágrafo de um destaque
    // MANTIDO" de "editor trocou o destaque inteiro por outro artigo" —
    // o classificador anterior colapsava as duas em "lead-rewrite" sempre
    // que a seção `destaque-N` mudava (`requestType = "lead-rewrite"` era o
    // default na linha ~165), contaminando a contagem de recorrência que
    // motivou esta issue (3 dos 4 episódios relatados eram na verdade troca
    // de artigo no gate, não reescrita de texto do mesmo artigo — ver
    // investigação nos comentários da #8694). Sinal: URL muda para um
    // artigo DIFERENTE (host ou path diferentes, ignorando query/tracking
    // via `canonicalizeUrl`) — troca de tracking param/URL espelho do MESMO
    // artigo não conta como swap, só como `link-swap` (comportamento já
    // existente acima). `destaque-swap` vence qualquer classificação
    // anterior desta seção: uma vez confirmado que é outro artigo, "lead
    // reescrito"/"título trocado" deixam de fazer sentido como rótulo.
    if (urlChanged && isDifferentArticleUrl(oldUrlLine!, newUrlLine!) && !isSameStoryUrl(oldUrlLine!, newUrlLine!, story)) {
      requestType = "destaque-swap";
    }

    // item-trocado/reordenado/fonte-trocada vencem tudo; titulo-reescrito/categoria-trocada só
    // valem se nenhum sinal posterior (lead-rewrite, length-cut, link-swap) agiu.
    if (urlClass) {
      const strong = urlClass.kind === "item-trocado" || urlClass.kind === "reordenado" || urlClass.kind === "fonte-trocada";
      if (strong || requestType === "title-choice" || (urlClass.kind === "categoria-trocada" && requestType !== "length-cut" && requestType !== "link-swap")) requestType = urlClass.type;
    }

    // #9879/#9880: numa seção de pool, mudança no CONJUNTO de itens (por URL)
    // é corte/adição/troca de item e vence o "length-cut" por tamanho da seção.
    // Medição 260930..261008: 31 itens cortados, 0 descrições encurtadas.
    // #9943: itens que só mudaram de seção saem da conta. Entrada vinda de
    // outra seção de POOL vira `bucket-move` (1 por item, como o
    // `classifyPoolDiff`, e deduplicada contra ele em `dedupeDestaqueSwaps`);
    // ida/volta de destaque não gera nada aqui (destaque-* já reporta).
    // Seção cuja única mudança no conjunto foi movimentação não gera entrada
    // própria — o encolhimento do texto não é corte.
    const poolClass = POOL_SECTION_KEYS.has(section)
      ? classifyPoolItemSetChange(oldText, newText, { before: keysOutside(oldWhere, section), after: keysOutside(newWhere, section) })
      : null;
    if (poolClass) {
      for (const k of poolClass.movedIn) {
        const from = oldWhere.get(k);
        if (!from || !POOL_SECTION_KEYS.has(from)) continue;
        results.push({
          request_type: "bucket-move",
          target: POOL_SECTION_TARGETS[section] ?? target,
          description: `Item movido de ${from} → ${section} no 02-reviewed.md: ${newItemUrls.get(k) ?? k}`,
          resolution: "accepted",
          context: { section, from_section: from, url: newItemUrls.get(k) ?? k, change_kind: "item-movido" },
        });
      }
      if (poolClass.removed === 0 && poolClass.added === 0) continue;
    }
    if (poolClass) requestType = poolClass.type;

    // Verificar se destaque foi removido (swap/cut)
    if (!newSections.has(section) && oldSections.has(section)) {
      requestType = "destaque-cut";
      target = "radar"; // movido para radar
    }

    // #7981 follow-up (achado ao vivo: distill-prompt-corrections.ts nunca
    // conseguia medir "≥2 histórias distintas" porque context.url nunca
    // era populado aqui) — a URL do artigo já é extraída acima (linhas
    // 199-200) pra detectar link-swap; reusada aqui pra TODO tipo de
    // pedido desta seção, não só link-swap. `null` (nunca string vazia)
    // quando nenhuma URL foi encontrada em nenhum dos dois lados — o
    // consumidor (distill-prompt-corrections.ts) já trata `context.url`
    // ausente/`null` como "não contável" pra diversidade de histórias,
    // nunca como uma história fabricada.
    const articleUrl = (newUrlLine ?? oldUrlLine)?.trim() ?? null;

    results.push({
      request_type: requestType,
      target,
      description: `Mudança detectada em ${section}: ${oldText.slice(0, 100)}... → ${newText.slice(0, 100)}...`,
      resolution: "accepted",
      context: {
        section,
        old_length: oldLen,
        new_length: newLen,
        url: articleUrl,
        ...(urlClass ? { change_kind: urlClass.kind } : {}),
        ...(poolClass ? { change_kind: poolClass.kind, items_removed: poolClass.removed, items_added: poolClass.added } : {}),
      },
    });
  }

  // Detectar seções novas (promoção)
  for (const [section] of newSections) {
    if (!oldSections.has(section) && section.startsWith("destaque-")) {
      results.push({
        request_type: "destaque-promote",
        target: "radar",
        description: `Novo destaque promovido: ${section}`,
        resolution: "accepted",
        context: { section },
      });
    }
  }

  return results;
}

/**
 * Classifica diferenças no 03-social.md (social)
 *
 * #9718: parsing, normalização e casamento vêm de `lib/social-rewrite-diff.ts`
 * (a medição da #9692) — este classificador não tem mais lógica própria de
 * seção. Três defeitos corrigidos em relação ao `Map` por nome de seção:
 *
 * 1. **Chave = bloco + seção.** `# Social ## d1` e `# Curto ## d1` são
 *    seções distintas; antes o Curto sobrescrevia o texto longo e o diff do
 *    social comparava só o Curto (a correção factual do d2 de 261005 no texto
 *    longo não entrava na contagem).
 * 2. **Casamento de destaque por URL**, com o `01-approved.json` de CADA lado
 *    (`baselineDestaqueUrls` = o do snapshot; `destaqueUrls` = o atual) —
 *    nunca por posição. Reordenar sem editar não gera nada; destaque trocado
 *    (sem par) também não, porque a troca já é registrada como
 *    `destaque-swap` pelo diff do `02-reviewed.md`/`01-approved.json`
 *    (uma vez só, `dedupeDestaqueSwaps`, #9753). `context.url` é a URL
 *    do destaque no lado aprovado, da MESMA história que foi comparada.
 * 3. **Normalização** (`normalizeSocialMd`): CRLF→LF, espaço no fim da linha
 *    e URL própria do site → `{edition_url}` (#7974 Fix 2: o Stage 5 resolve
 *    o placeholder depois do snapshot).
 *
 * Item trocado fora dos destaques (`um`, `post_pixel` com texto sem
 * semelhança) também não vira `social-rewrite`: é texto novo, não reescrita
 * (mesmo critério de `isRealRewrite` na medição).
 *
 * Fallback sem URL (snapshot ou `01-approved.json` ausente de um dos lados):
 * o casamento cai pra similaridade; um destaque que não casou por
 * similaridade mas tem a seção de MESMO NOME sem par do outro lado é
 * comparado por nome (comportamento anterior) — sem URL não há como afirmar
 * que foi troca, e perder uma reescrita real é pior que registrar uma troca.
 */
export function classifySocialDiff(
  oldContentRaw: string,
  newContentRaw: string,
  destaqueUrls?: ReadonlyMap<string, string>,
  baselineDestaqueUrls?: ReadonlyMap<string, string>,
): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const haveUrls = (destaqueUrls?.size ?? 0) > 0 && (baselineDestaqueUrls?.size ?? 0) > 0;
  const pairs = matchSections(
    parseSocialSections(oldContentRaw),
    parseSocialSections(newContentRaw),
    baselineDestaqueUrls,
    destaqueUrls,
  );

  // Fallback por nome (ver docstring) — só sem URL dos dois lados.
  const removed = pairs.filter((p) => p.kind === "historia-removida");
  const byName = (p: SectionPair) =>
    !haveUrls && p.kind === "historia-trocada" && isDestaqueSection(p.section)
      ? removed.find((r) => r.block === p.block && r.section === p.section)
      : undefined;

  const results: ReturnType<typeof classifySocialDiff> = [];
  for (const p of pairs) {
    let before: string;
    let matchedBy: string | undefined = p.matchedBy;
    if (p.kind === "mesma-historia") before = p.before ?? "";
    else {
      const r = byName(p);
      if (!r) continue; // troca/remoção: não é reescrita (#9718)
      before = r.before ?? "";
      matchedBy = "nome";
    }
    const after = p.after ?? "";
    if (before === after) continue; // idêntico (inclusive só reordenado)

    const target: RequestTarget = isDestaqueSection(p.section) ? (p.section as RequestTarget) : "social";
    results.push({
      request_type: "social-rewrite",
      target,
      description: `Mudança em social ${p.block}/${p.baselineSection ? `${p.baselineSection}→` : ""}${p.section}: reescrita/ajuste de texto`,
      resolution: "accepted",
      context: {
        section: p.section,
        block: p.block,
        old_length: before.length,
        new_length: after.length,
        url: isDestaqueSection(p.section) ? (destaqueUrls?.get(p.section) ?? null) : null,
        ...(matchedBy ? { matched_by: matchedBy } : {}),
        ...(p.baselineSection ? { baseline_section: p.baselineSection } : {}),
        ...(p.sourceChanged ? { source_changed: true } : {}),
      },
    });
  }
  return results;
}

/** Buckets do pool no `01-approved.json` → `target` da taxonomia de pedidos. */
const POOL_BUCKET_TARGETS: ReadonlyArray<readonly [string, RequestTarget]> = [
  ["lancamento", "lancamentos"],
  ["radar", "radar"],
  ["use_melhor", "use-melhor"],
  ["video", "video"],
];

interface PoolItem {
  url: string;
  bucket: string;
  target: RequestTarget;
  title: string;
  /**
   * URLs alternativas da MESMA história (canônica + `cluster_sources[]`,
   * `scripts/lib/cluster-sources.ts` #3920) — usado só pra detectar
   * `link-swap` (#7974 Fix 3), nunca pra decidir bucket/target/title.
   */
  clusterUrls: Set<string>;
}

/** URLs da mesma história (canônica + `cluster_sources[].url`), normalizadas via Set (sem duplicar a própria URL). */
function clusterUrlsOf(url: string, item: any): Set<string> {
  const urls = new Set<string>([url]);
  for (const cs of item?.cluster_sources ?? []) {
    if (typeof cs?.url === "string" && cs.url !== "") urls.add(cs.url);
  }
  return urls;
}

/** Indexa os itens do pool por URL. Item duplicado entre buckets: 1º bucket vence. */
function indexPool(json: any): Map<string, PoolItem> {
  const byUrl = new Map<string, PoolItem>();
  for (const [key, target] of POOL_BUCKET_TARGETS) {
    for (const item of json?.[key] ?? []) {
      const url = item?.url;
      if (typeof url !== "string" || url === "" || byUrl.has(url)) continue;
      byUrl.set(url, { url, bucket: key, target, title: item?.title ?? url, clusterUrls: clusterUrlsOf(url, item) });
    }
  }
  return byUrl;
}

/**
 * Índice auxiliar: toda URL de cluster (canônica + `cluster_sources`) aponta
 * pro `PoolItem` dono — permite achar o item novo que corresponde a um item
 * antigo mesmo quando a URL EXATA mudou (troca de fonte primária/idioma da
 * mesma história), sem depender de um "cluster_id" que não existe no schema
 * (#7974 Fix 3).
 */
function indexPoolByClusterUrl(pool: Map<string, PoolItem>): Map<string, PoolItem> {
  const byClusterUrl = new Map<string, PoolItem>();
  for (const item of pool.values()) {
    for (const u of item.clusterUrls) {
      if (!byClusterUrl.has(u)) byClusterUrl.set(u, item);
    }
  }
  return byClusterUrl;
}

/** URLs que estão em `highlights` — pertencem ao caminho destaque-*, não ao pool. */
function highlightUrls(json: any): Set<string> {
  const urls = new Set<string>();
  for (const h of json?.highlights ?? []) {
    const url = h?.url ?? h?.article?.url;
    if (typeof url === "string" && url !== "") urls.add(url);
  }
  return urls;
}

/** Rótulo legível do bucket, pra descrição da entrada. */
const BUCKET_LABELS: Record<string, string> = {
  lancamento: "LANÇAMENTOS",
  radar: "RADAR",
  use_melhor: "USE MELHOR",
  video: "VÍDEOS",
};

function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket.toUpperCase();
}

/**
 * Diffa os buckets do pool entre dois estados do `01-approved.json`.
 *
 * Quatro casos, todos derivados de uma passada só sobre o índice URL→bucket:
 * - **`bucket-move`** — URL presente nos dois lados, em buckets diferentes.
 *   É o pedido que o editor identificou como o mais comum ("mover conteúdo
 *   entre Use Melhor, Lançamentos e Radar"). `target` = bucket de DESTINO.
 * - **`link-swap`** (#7974 Fix 3) — a URL exata sumiu, mas o item novo que
 *   entrou compartilha `cluster_sources` com ele (mesma história, fonte/
 *   idioma diferente — ex: editor troca a versão em inglês pela cobertura
 *   em PT da mesma notícia). Sem isso, virava `pool-cut`+`pool-add`
 *   desconexos: 2 eventos que não contam como "trocar link" nenhuma vez na
 *   detecção de recorrência (cada um precisa de 3 ocorrências do MESMO
 *   tipo, e cut≠add). `target` = bucket de destino do item novo.
 * - **`pool-cut`** — URL sai do pool sem virar destaque nem ser swap de
 *   cluster (item cortado de verdade).
 * - **`pool-add`** — URL entra no pool sem ter estado nele antes (tipicamente
 *   promovido de `runners_up`) e sem ser o destino de um swap já contado.
 *
 * URLs que cruzam a fronteira pool↔destaques são ignoradas aqui de propósito:
 * promoção/demoção de destaque já é reportada por `destaque-swap`/
 * `destaque-cut`/`destaque-promote` acima, e contá-las de novo como
 * `pool-cut`/`pool-add` inflaria a recorrência com o mesmo evento duas vezes.
 */
export function classifyPoolDiff(oldJson: any, newJson: any): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  const oldPool = indexPool(oldJson);
  const newPool = indexPool(newJson);
  const oldHighlights = highlightUrls(oldJson);
  const newHighlights = highlightUrls(newJson);
  const newByClusterUrl = indexPoolByClusterUrl(newPool);
  /** URLs do pool NOVO já explicadas por um link-swap — não podem também virar pool-add. */
  const swapConsumedNewUrls = new Set<string>();

  for (const [url, oldItem] of oldPool) {
    const newItem = newPool.get(url);

    if (newItem) {
      if (newItem.bucket === oldItem.bucket) continue;
      results.push({
        request_type: "bucket-move",
        target: newItem.target,
        description:
          `Item movido de ${bucketLabel(oldItem.bucket)} → ${bucketLabel(newItem.bucket)}: ${newItem.title}`,
        resolution: "accepted",
        context: { url, from_bucket: oldItem.bucket, to_bucket: newItem.bucket },
      });
      continue;
    }

    // Saiu do pool. Se virou destaque, quem reporta é o caminho destaque-*.
    if (newHighlights.has(url)) continue;

    // Link-swap (#7974 Fix 3): alguma URL alternativa do MESMO cluster
    // (a própria antiga, ou uma das listadas em cluster_sources) resolve
    // pra um item que é GENUINAMENTE novo no pool (não existia por URL
    // exata antes) — troca de fonte da mesma história, não corte.
    let swapTarget: PoolItem | undefined;
    for (const clusterUrl of oldItem.clusterUrls) {
      const candidate = newByClusterUrl.get(clusterUrl);
      if (candidate && !oldPool.has(candidate.url)) {
        swapTarget = candidate;
        break;
      }
    }
    if (swapTarget) {
      swapConsumedNewUrls.add(swapTarget.url);
      results.push({
        request_type: "link-swap",
        target: swapTarget.target,
        description: `Link trocado dentro da mesma história (${bucketLabel(oldItem.bucket)} → ${bucketLabel(swapTarget.bucket)}): ${oldItem.title} → ${swapTarget.title}`,
        resolution: "accepted",
        context: {
          old_url: url,
          new_url: swapTarget.url,
          from_bucket: oldItem.bucket,
          to_bucket: swapTarget.bucket,
        },
      });
      continue;
    }

    results.push({
      request_type: "pool-cut",
      target: oldItem.target,
      description: `Item removido de ${bucketLabel(oldItem.bucket)}: ${oldItem.title}`,
      resolution: "accepted",
      context: { url, from_bucket: oldItem.bucket },
    });
  }

  for (const [url, newItem] of newPool) {
    if (oldPool.has(url)) continue;
    // Entrou no pool vindo dos destaques: é demoção, reportada por destaque-cut.
    if (oldHighlights.has(url)) continue;
    // Já reportado como o lado "novo" de um link-swap acima.
    if (swapConsumedNewUrls.has(url)) continue;
    results.push({
      request_type: "pool-add",
      target: newItem.target,
      description: `Item adicionado a ${bucketLabel(newItem.bucket)}: ${newItem.title}`,
      resolution: "accepted",
      context: { url, to_bucket: newItem.bucket },
    });
  }

  return results;
}

/**
 * Classifica diferenças no 01-approved.json (seleção de destaques)
 */
export function classifyApprovedDiff(oldContent: string, newContent: string): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  try {
    const oldJson = JSON.parse(oldContent);
    const newJson = JSON.parse(newContent);

    const oldHighlights = oldJson.highlights ?? [];
    const newHighlights = newJson.highlights ?? [];

    // #9753: casar destaques POR URL canônica, nunca por posição. Comparar
    // `highlights[i]` com `highlights[i]` transformava reordenação pura (D1↔D3)
    // em 2× `destaque-swap`. Agora: URL que saiu × URL que entrou, pareadas na
    // ordem → `destaque-swap` (target = posição do item novo); saiu sem par →
    // `destaque-cut`; entrou sem par → `destaque-promote`. Permutação pura não
    // gera nada aqui (a reordenação sai como `section-order` abaixo).
    const keyOf = (h: any): string | null => {
      const url = h?.article?.url ?? h?.url;
      return typeof url === "string" && url !== "" ? articleUrlKey(url) : null;
    };
    const oldKeys = oldHighlights.map(keyOf);
    const newKeys = newHighlights.map(keyOf);
    const titleOf = (h: any) => h?.article?.title ?? h?.title;
    const urlOf = (h: any) => h?.article?.url ?? h?.url;
    type Slot = { h: any; position: number; key: string };
    const leftAll: Slot[] = oldHighlights
      .map((h: any, i: number) => ({ h, position: i + 1, key: oldKeys[i] }))
      .filter((x: { key: string | null }) => x.key !== null && !newKeys.includes(x.key));
    const enteredAll: Slot[] = newHighlights
      .map((h: any, i: number) => ({ h, position: i + 1, key: newKeys[i] }))
      .filter((x: { key: string | null }) => x.key !== null && !oldKeys.includes(x.key));

    // #9936: troca de URL pra fonte (oficial) da MESMA história — o item novo
    // herda a pontuação do que saiu (`inheritsScoring`). É problema de link,
    // não de seleção/ordem: `link-swap` no slot do item novo, fora da contagem
    // de `destaque-swap`. Os demais seguem o pareamento na ordem abaixo.
    const upgrades = matchSourceUpgrades(leftAll, enteredAll);
    for (const { out, inn } of upgrades) {
      const official = /^official:/i.test(String(inn.h?.article?.source ?? inn.h?.source ?? "").trim());
      results.push({
        request_type: "link-swap",
        target: `d${inn.position}` as RequestTarget,
        description: `Destaque D${inn.position}: link trocado dentro da mesma história${official ? " (fonte oficial)" : ""}: ${urlOf(out.h)} → ${urlOf(inn.h)}`,
        resolution: "accepted",
        context: {
          old_url: urlOf(out.h),
          new_url: urlOf(inn.h),
          position: inn.position,
          old_position: out.position,
          change_kind: "fonte-trocada",
        },
      });
    }
    const upgradedOut = new Set(upgrades.map((p) => p.out));
    const upgradedIn = new Set(upgrades.map((p) => p.inn));
    const left = leftAll.filter((x) => !upgradedOut.has(x));
    const entered = enteredAll.filter((x) => !upgradedIn.has(x));
    /** Chave de história: URL nova de troca de fonte → chave da antiga. */
    const storyKeys = new Map<string, string>(upgrades.map((p) => [p.inn.key, p.out.key]));
    const story = (k: string | null) => (k === null ? null : storyKeys.get(k) ?? k);

    const pairs = Math.min(left.length, entered.length);
    for (let i = 0; i < pairs; i++) {
      const out = left[i];
      const inn = entered[i];
      results.push({
        request_type: "destaque-swap",
        target: `d${inn.position}` as RequestTarget,
        description: `Destaque D${inn.position} trocado: ${titleOf(out.h)} → ${titleOf(inn.h)}`,
        resolution: "accepted",
        context: { old_url: urlOf(out.h), new_url: urlOf(inn.h), position: inn.position, old_position: out.position },
      });
    }

    // Destaque que saiu sem item novo no lugar
    for (const out of left.slice(pairs)) {
      results.push({
        request_type: "destaque-cut",
        target: `d${out.position}` as RequestTarget,
        description: `Destaque D${out.position} removido: ${titleOf(out.h)}`,
        resolution: "accepted",
        context: { old_url: urlOf(out.h), position: out.position },
      });
    }

    // Item novo sem destaque que tenha saído (aumento de destaques)
    for (const inn of entered.slice(pairs)) {
      results.push({
        request_type: "destaque-promote",
        target: "radar",
        description: `Item promovido a destaque D${inn.position}: ${titleOf(inn.h)}`,
        resolution: "accepted",
        context: { new_url: urlOf(inn.h), position: inn.position },
      });
    }

    // Detectar mudança de ordem
    if (oldHighlights.length === newHighlights.length && oldHighlights.length > 1) {
      const oldUrls = oldHighlights.map((h: any) => h?.article?.url);
      const newUrls = newHighlights.map((h: any) => h?.article?.url);
      // Por chave canônica (#9753), coerente com o casamento de swap acima.
      // #9936: troca de fonte da mesma história não desfaz a reordenação.
      const newStoryKeys = newKeys.map(story);
      const sameSet = oldKeys.every((k: string | null) => k !== null && newStoryKeys.includes(k));
      if (sameSet && JSON.stringify(oldKeys) !== JSON.stringify(newStoryKeys)) {
        results.push({
          request_type: "section-order",
          target: "newsletter",
          description: `Reordenação de destaques: ${oldUrls.map((u: string, i: number) => `D${i+1}=${u}`).join(" → ")} → ${newUrls.map((u: string, i: number) => `D${i+1}=${u}`).join(" → ")}`,
          resolution: "accepted",
          context: { old_order: oldUrls, new_order: newUrls },
        });
      }
    }

    // #5731 follow-up: movimentação de itens entre os buckets do pool
    // (Lançamentos / Radar / Use Melhor / Vídeo). Pedido mais frequente do
    // editor segundo ele mesmo, e até aqui invisível pro loop de aprendizado:
    // `classifyApprovedDiff` só olhava `highlights`, então mover um item de
    // LANÇAMENTOS→RADAR não derivava nada e, quando logado à mão, virava
    // `other` — que por design NUNCA conta na detecção de recorrência.
    results.push(...classifyPoolDiff(oldJson, newJson));
  } catch {
    // JSON inválido - ignorar
  }

  return results;
}

/**
 * Classifica diferenças nos HTMLs finais do Stage 4 pre-render
 * (`_internal/newsletter-final.html`, `_internal/social-preview.html`).
 *
 * Diferente de `classifyNewsletterDiff`/`classifySocialDiff` (que operam
 * sobre o markdown-fonte estruturado, com seções endereçáveis por destaque),
 * HTML final renderizado não tem uma taxonomia granular óbvia a replicar —
 * é o output de `render-newsletter-html.ts`/`substitute-image-urls.ts`, não
 * algo o editor edita diretamente. Classificação genérica (#5782): só
 * confirma QUE o HTML mudou entre o snapshot pré-gate e o estado no
 * momento da aprovação (evidência de que o loop "ajustar" de §4d.1 re-
 * renderizou o HTML), sem tentar decompor O QUE mudou dentro dele — isso já
 * é coberto com granularidade pelo diff do markdown-fonte em
 * `classifyNewsletterDiff`/`classifySocialDiff` no mesmo gate.
 *
 * `request_type: "process"` (#7964), não `"other"` — é reconhecidamente
 * ruído de processo (re-render mecânico), não um pedido de conteúdo
 * ambíguo. `"other"` ficava poluído por essas entradas mesmo já excluído
 * da detecção de recorrência (#4966): quem lia `editor-requests.jsonl` à
 * mão (§6c) via um `other` sem nenhuma pista de que era só "HTML mudou",
 * indistinguível de um pedido real não-classificado. `process` também
 * nunca conta na recorrência (mesma exclusão de `other`).
 */
function classifyHtmlDiff(target: RequestTarget): (oldContent: string, newContent: string) => Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  return (oldContent: string, newContent: string) => {
    if (oldContent === newContent) return [];
    return [
      {
        request_type: "process" as RequestType,
        target,
        description: `HTML final do Stage 4 pre-render mudou entre o snapshot pré-gate e a aprovação (re-render disparado por "ajustar" em §4d.1 ou correção automática).`,
        resolution: "accepted" as Resolution,
        context: { subtype: "html-final-changed", old_length: oldContent.length, new_length: newContent.length },
      },
    ];
  };
}

/**
 * Executa diff e classifica mudanças
 */
function diffAndClassify(
  editionDir: string,
  snapshotLabel: string,
  currentFiles: readonly string[],
  classifierMap: Map<string, (oldC: string, newC: string) => any[]>,
  stage: number
): Array<Omit<EditorRequestEntry, "timestamp" | "edition">> {
  const snapshots = readSnapshots(editionDir, snapshotLabel, currentFiles);
  const results: Array<Omit<EditorRequestEntry, "timestamp" | "edition">> = [];

  for (const file of currentFiles) {
    const currentPath = resolve(editionDir, file);
    if (!existsSync(currentPath)) continue;

    const currentContent = readFileSync(currentPath, "utf8");
    const snapshotContent = snapshots.get(file);

    if (!snapshotContent) {
      // Sem snapshot - primeira vez, não podemos derivar
      continue;
    }

    if (snapshotContent === currentContent) continue; // sem mudança

    const classifier = classifierMap.get(file);
    if (classifier) {
      const classified = classifier(snapshotContent, currentContent);
      for (const c of classified) {
        results.push({ ...c, stage });
      }
    }
  }

  return dedupeDestaqueSwaps(results);
}

/**
 * #9753: a MESMA troca de destaque é vista por dois diffs na mesma passada —
 * `02-reviewed.md` (`classifyNewsletterDiff`, `context.section`) e
 * `_internal/01-approved.json` (`classifyApprovedDiff`, `context.new_url`).
 * Sem dedupe, cada troca real contava 2x em `recurring_editor_request`.
 * Mantém a entrada da newsletter (traz `context.url`/`change_kind`) e descarta
 * a do approved com o mesmo `target`; a do approved só fica quando a
 * newsletter não registrou a troca daquele slot (ex.: markdown sem a linha de
 * título com link). Pura.
 *
 * #9936: vale igual pro `link-swap` de troca de fonte num slot de destaque
 * (`d1`..`dN`) — os dois diffs o veem quando o item não muda de posição. O
 * `link-swap` de pool (target `radar`/`lancamentos`/...) fica fora do dedupe.
 *
 * #9943: `bucket-move` de item do pool também — o approved (`classifyPoolDiff`)
 * e a newsletter (`classifyNewsletterDiff`, item que mudou de seção) emitem um
 * por item; casados por `target` + URL do item.
 */
export function dedupeDestaqueSwaps<T extends { request_type: RequestType; target: RequestTarget; context?: Record<string, unknown> }>(
  entries: T[],
): T[] {
  const isFromApproved = (e: T) =>
    e.context !== undefined && ("new_url" in e.context || "to_bucket" in e.context) && !("section" in e.context);
  const slotKey = (e: T): string | null => {
    if (e.request_type === "destaque-swap" || (e.request_type === "link-swap" && /^d\d+$/.test(e.target))) {
      return `${e.request_type}:${e.target}`;
    }
    // #9943: a mesma mudança de seção de item do pool, vista pelo approved (`to_bucket`) e pela newsletter (`from_section`).
    const url = e.context?.url;
    if (e.request_type === "bucket-move" && !/^d\d+$/.test(e.target) && typeof url === "string" && url !== "") {
      return `bucket-move:${e.target}:${articleUrlKey(url)}`;
    }
    return null;
  };
  const newsletterKeys = new Set(entries.filter((e) => !isFromApproved(e)).map(slotKey).filter((k) => k !== null));
  return entries.filter((e) => {
    const k = slotKey(e);
    return !(k !== null && isFromApproved(e) && newsletterKeys.has(k));
  });
}

/**
 * Função principal - cria snapshots pós-Stage 2
 *
 * IMUTÁVEL por edição desde o #7964: se o snapshot `stage2-post-gate` já
 * foi capturado (ver `hasSnapshot`), este comando é um NO-OP — nunca
 * sobrescreve. Causa raiz do #7964: o playbook chama `snapshot-stage2` uma
 * única vez, logo após o gate unificado do Stage 2
 * (`orchestrator-stage-2.md` §2d) — esse é o baseline correto contra o
 * qual `deriveStage4`/`deriveStage6` diffam pra capturar TUDO que o editor
 * pedir depois (bucket-move, destaque-swap/cut, reescrita de título/lead —
 * inclusive durante o Stage 4, via "ajustar" ou painel do Studio). Uma 2ª
 * invocação de `snapshot-stage2` para a MESMA edição — seja por retomada
 * de sessão, seja por um agente re-executando o checklist de §2d fora de
 * ordem — re-basearia esse snapshot para DEPOIS das mudanças que o editor
 * já fez, apagando a evidência que `deriveStage4` deveria capturar (o
 * próprio bug relatado: pedidos feitos no gate do Stage 4 nunca apareciam
 * em `editor-requests.jsonl`).
 *
 * **#9356:** a imutabilidade acima não bastava — o passo em prosa que
 * chamava este comando era pulado (15 de 21 edições), e o `deriveStage4`
 * REGRAVAVA o `stage2-post-gate` no fim, com o estado final. Hoje a captura
 * principal é mecânica (`pipeline-sentinel.ts write --step 2` chama
 * `captureStage2Baseline`); este comando segue existindo como chamada
 * explícita idempotente, e o `deriveStage4` grava o checkpoint dele num
 * label separado (`stage4-post-gate`), nunca mais aqui.
 */
function snapshotStage2(editionDir: string): void {
  const outcome = captureStage2Baseline(editionDir, "snapshot-stage2");
  if (outcome === "exists") {
    console.log(
      `[derive-editor-requests] Snapshot stage2-post-gate já existe — ignorando (imutável por edição, #7964).`,
    );
    return;
  }
  const snapshotDir = resolve(editionDir, SNAPSHOT_DIR, STAGE2_BASELINE_LABEL);
  console.log(
    outcome === "created"
      ? `[derive-editor-requests] Snapshots stage2-post-gate criados em ${snapshotDir}`
      : `[derive-editor-requests] Nenhum arquivo do Stage 2 existe ainda — snapshot stage2-post-gate não gravado.`,
  );
}

/**
 * Função principal - cria snapshots pós-Stage 4 pre-render
 *
 * Mesma imutabilidade do `snapshotStage2` acima e pelo mesmo motivo
 * (#7964) — o playbook chama `snapshot-stage4` uma única vez, dentro de
 * §4b, ANTES do loop "ajustar" existir (`orchestrator-stage-4.md` §4b vs.
 * §4d.1): uma 2ª chamada re-basearia o checkpoint que `classifyHtmlDiff`
 * usa pra detectar re-render disparado por "ajustar" (#5782), com o mesmo
 * efeito de apagar evidência que motivou o fix acima.
 */
function snapshotStage4(editionDir: string): void {
  if (hasSnapshot(editionDir, "stage4-pre-render", STAGE4_SNAPSHOT_FILES)) {
    console.log(
      `[derive-editor-requests] Snapshot stage4-pre-render já existe — ignorando (imutável por edição, #7964).`,
    );
    return;
  }
  createSnapshots(editionDir, STAGE4_SNAPSHOT_FILES, "stage4-pre-render");
  console.log(`[derive-editor-requests] Snapshots stage4-pre-render criados.`);
}

/**
 * `"d1"/"d2"/"d3"` → URL do artigo daquele destaque, lido do
 * `_internal/01-approved.json` ATUAL da edição (#7981 follow-up) — usado
 * só pra popular `context.url` das entradas de `classifySocialDiff`
 * (`03-social.md` não embute URL no texto). Fail-soft: JSON ausente/
 * malformado/sem `highlights` devolve mapa vazio, nunca lança — o pior
 * caso é `context.url: null` nas entradas de social, igual ao
 * comportamento de antes deste fix.
 */
export function buildDestaqueUrlMap(editionDir: string): Map<string, string> {
  try {
    const approvedPath = join(editionDir, "_internal", "01-approved.json");
    if (!existsSync(approvedPath)) return new Map();
    return destaqueUrlMapFromApproved(readFileSync(approvedPath, "utf8"));
  } catch {
    return new Map(); // fail-soft — ver docstring
  }
}

/**
 * Classificadores compartilhados por deriveStage4/deriveStage6 (mesmos arquivos-fonte).
 *
 * `baselineLabel` (#9718): o snapshot contra o qual o diff roda — o
 * `01-approved.json` DELE dá as URLs dos destaques do lado antigo, pra o
 * social casar destaque por URL dos dois lados (nunca por posição).
 */
function buildStage2FilesClassifierMap(
  editionDir: string,
  baselineLabel: string,
): Map<string, (oldC: string, newC: string) => any[]> {
  const destaqueUrls = buildDestaqueUrlMap(editionDir);
  const baselineApproved = readSnapshots(editionDir, baselineLabel, ["_internal/01-approved.json"]).get("_internal/01-approved.json");
  const baselineDestaqueUrls = destaqueUrlMapFromApproved(baselineApproved);
  // #9936: troca de fonte da mesma história (só o approved tem score pra decidir).
  const currentApprovedPath = join(editionDir, "_internal", "01-approved.json");
  let currentApproved: string | undefined;
  try {
    currentApproved = existsSync(currentApprovedPath) ? readFileSync(currentApprovedPath, "utf8") : undefined;
  } catch {
    currentApproved = undefined; // fail-soft, como buildDestaqueUrlMap: sem aliases
  }
  const sameStory = sourceUpgradeAliases(baselineApproved, currentApproved);
  return new Map<string, (oldC: string, newC: string) => any[]>([
    ["02-reviewed.md", (oldC, newC) => classifyNewsletterDiff(oldC, newC, sameStory)],
    ["03-social.md", (oldC, newC) => classifySocialDiff(oldC, newC, destaqueUrls, baselineDestaqueUrls)],
    ["_internal/01-approved.json", classifyApprovedDiff],
  ]);
}

/** Classificador do snapshot "stage4-pre-render" (#5782) — ver classifyHtmlDiff. */
function buildStage4FilesClassifierMap(): Map<string, (oldC: string, newC: string) => any[]> {
  return new Map<string, (oldC: string, newC: string) => any[]>([
    ["_internal/newsletter-final.html", classifyHtmlDiff("newsletter")],
    ["_internal/social-preview.html", classifyHtmlDiff("social")],
  ]);
}

/**
 * Função principal - deriva requests no gate do Stage 4
 *
 * Compara o checkpoint "stage2-post-gate" (criado por snapshotStage2, logo
 * após o gate unificado do Stage 2) contra o estado atual dos arquivos —
 * captura qualquer edição feita pelo editor (Studio ou manual) entre o fim
 * do Stage 2 e a aprovação do gate do Stage 4.
 *
 * Ao final, grava o checkpoint `stage4-post-gate` com o estado atual: o
 * `deriveStage6` (e uma 2ª chamada deste comando, na retomada) diffa contra
 * ele, então só vê o que mudou DEPOIS desta chamada. Até o #9356 esse
 * refresh sobrescrevia o próprio `stage2-post-gate` — o baseline virava o
 * estado final e o bug ficava invisível em qualquer auditoria posterior.
 *
 * Baseline ausente/tardio/sem carimbo é reportado (`reportBaselineHealth`)
 * — nunca mais "0 pedidos" em silêncio (#9356).
 *
 * Diffa também o checkpoint "stage4-pre-render" (criado por `snapshotStage4`
 * logo após o pre-render técnico, ainda dentro do Stage 4) contra o estado
 * atual dos HTMLs finais — captura re-renders disparados pelo loop
 * "ajustar" de §4d.1 (#5782). Classificação genérica via `classifyHtmlDiff`
 * (ver docstring). O checkpoint também é refrescado ao final, mesmo padrão
 * do "stage2-post-gate" acima.
 */
function deriveStage4(editionDir: string, edition: string, runLogRoot: string = ROOT): number {
  // Reexecução (retomada do Stage 4): o checkpoint `stage4-post-gate` já
  // existe — diffar contra ele evita duplicar o que a 1ª passada já logou
  // (era o papel do antigo refresh do `stage2-post-gate`, #9356).
  const resumed = hasSnapshot(editionDir, STAGE4_POST_GATE_LABEL, STAGE2_SNAPSHOT_FILES);
  const baselineLabel = resumed ? STAGE4_POST_GATE_LABEL : STAGE2_BASELINE_LABEL;
  if (!resumed) reportBaselineHealth(editionDir, edition, runLogRoot);

  const stage2ClassifierMap = buildStage2FilesClassifierMap(editionDir, baselineLabel);
  const derived = diffAndClassify(editionDir, baselineLabel, STAGE2_SNAPSHOT_FILES, stage2ClassifierMap, 4);

  const stage4ClassifierMap = buildStage4FilesClassifierMap();
  const derivedHtml = diffAndClassify(editionDir, "stage4-pre-render", STAGE4_SNAPSHOT_FILES, stage4ClassifierMap, 4);

  let count = 0;
  for (const entry of [...derived, ...derivedHtml]) {
    appendEditorRequest(editionDir, { ...entry, edition, source: "derived" });
    count++;
  }

  // Checkpoint pro derive-stage6 — label SEPARADO; o `stage2-post-gate`
  // nunca é regravado (#9356).
  createSnapshots(editionDir, STAGE2_SNAPSHOT_FILES, STAGE4_POST_GATE_LABEL);
  createSnapshots(editionDir, STAGE4_SNAPSHOT_FILES, "stage4-pre-render");

  console.log(`[derive-editor-requests] Stage 4 gate: ${count} pedidos derivados`);
  return count;
}

/**
 * Função principal - deriva requests no gate do Stage 6
 *
 * Diffa contra o checkpoint `stage4-post-gate` (gravado pelo
 * `deriveStage4` depois de derivar) — então só vê o que mudou DEPOIS da
 * aprovação do Stage 4 (ex: edição via Studio durante o Stage 5). Se a
 * edição pulou o gate do Stage 4 (interrupção), o checkpoint não existe e o
 * diff é contra o baseline original `stage2-post-gate`, cobrindo o
 * intervalo Stage 2 → Stage 6 numa passada só.
 */
function deriveStage6(editionDir: string, edition: string): number {
  const baselineLabel = hasSnapshot(editionDir, STAGE4_POST_GATE_LABEL, STAGE2_SNAPSHOT_FILES)
    ? STAGE4_POST_GATE_LABEL
    : STAGE2_BASELINE_LABEL;
  const classifierMap = buildStage2FilesClassifierMap(editionDir, baselineLabel);
  const derived = diffAndClassify(editionDir, baselineLabel, STAGE2_SNAPSHOT_FILES, classifierMap, 6);

  let count = 0;
  for (const entry of derived) {
    appendEditorRequest(editionDir, { ...entry, edition, source: "derived" });
    count++;
  }

  console.log(`[derive-editor-requests] Stage 6 gate: ${count} pedidos derivados`);
  return count;
}

/**
 * Guard do #9356: baseline ausente ou gravado tarde não pode virar "0
 * pedidos" em silêncio — foi exatamente assim que 15 de 21 edições
 * perderam todas as correções do Stage 4 sem ninguém notar. Loga `error`
 * no run-log + stderr. Snapshot legado (sem carimbo — edição em curso no
 * deploy deste fix) só vira `warn`: não dá pra julgar.
 */
function reportBaselineHealth(editionDir: string, edition: string, runLogRoot: string): void {
  const health = assessStage2BaselineOnDisk(editionDir);
  if (health.status === "ok") return;
  const level = health.status === "legacy" ? "warn" : "error";
  const message = `editor_request_baseline_${health.status}`;
  const detail =
    health.status === "missing"
      ? `snapshot stage2-post-gate ausente — as edições do editor no Stage 4 NÃO serão derivadas. Rode \`derive-editor-requests.ts backfill-stage4 --edition ${edition}\` pra reconstruir.`
      : health.status === "late"
        ? health.reason
        : "snapshot stage2-post-gate sem carimbo .capture.json (anterior ao #9356) — não dá pra confirmar que é a saída da pipeline.";
  console.error(`[derive-editor-requests] [${level}] ${message}: ${detail}`);
  logEvent(
    { edition, stage: 4, agent: "derive-editor-requests", level, message, details: { status: health.status, detail } },
    runLogRoot,
  );
}

/** Lê `_internal/02-title-picks.json` → picks do title-picker (vazio se ausente/malformado). */
export function readTitlePicks(editionDir: string): TitlePick[] {
  const p = join(editionDir, "_internal", "02-title-picks.json");
  if (!existsSync(p)) return [];
  try {
    const json = JSON.parse(readFileSync(p, "utf8"));
    const picks = Array.isArray(json?.picks) ? json.picks : [];
    return picks
      .filter((x: any) => typeof x?.destaque === "number" && typeof x?.chosen === "string")
      .map((x: any) => ({ destaque: x.destaque, chosen: x.chosen }));
  } catch {
    return [];
  }
}

/** Correções do fact-check efetivamente aplicadas (`status: "applied"`). */
export function readAppliedAutofixes(editionDir: string): AutofixReplacement[] {
  const p = join(editionDir, "_internal", "fact-check-autofix.json");
  if (!existsSync(p)) return [];
  try {
    const json = JSON.parse(readFileSync(p, "utf8"));
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    return entries
      .filter((e: any) => e?.status === "applied" && typeof e?.text === "string" && typeof e?.suggested_fix === "string")
      .map((e: any) => ({ text: e.text, suggested_fix: e.suggested_fix, sources: Array.isArray(e.sources) ? e.sources : [] }));
  } catch {
    return [];
  }
}

/** `_internal/intentional-error.json` (ou `null`). */
export function readIntentionalError(editionDir: string): { correct_value?: string; wrong_value?: string } | null {
  const p = join(editionDir, "_internal", "intentional-error.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Último arquivo da newsletter escrito pela pipeline antes do `02-reviewed.md`
 * (o de maior mtime entre `02-humanized.md` e `02-clarice-corrected.md`,
 * critério do #9356). `null` se nenhum existe.
 */
export function findPipelineNewsletterOutput(editionDir: string): string | null {
  const candidates = ["02-humanized.md", "02-clarice-corrected.md"]
    .map((f) => join(editionDir, "_internal", f))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}

/**
 * Baseline reconstruído do `02-reviewed.md` do fim do Stage 2 (#9356
 * backfill), com as mutações conhecidas da pipeline descontadas e já
 * normalizado (`normalizeNewsletterForComparison`). `null` sem arquivo da
 * pipeline.
 */
export function buildReconstructedNewsletterBaseline(editionDir: string, finalMd: string): string | null {
  const pipelinePath = findPipelineNewsletterOutput(editionDir);
  if (!pipelinePath) return null;
  const reconstructed = reconstructStage2Newsletter({
    pipelineOutput: readFileSync(pipelinePath, "utf8"),
    final: finalMd,
    titlePicks: readTitlePicks(editionDir),
    intentionalError: readIntentionalError(editionDir),
  });
  return normalizeNewsletterForComparison(
    applyAutofixReplacements(reconstructed, readAppliedAutofixes(editionDir), "newsletter"),
  );
}

/**
 * Backfill do #9356: deriva os pedidos do Stage 4 das edições cujo baseline
 * `stage2-post-gate` foi gravado tarde (ou nunca), usando o baseline
 * RECONSTRUÍDO a partir do último arquivo da pipeline. Só newsletter — a
 * saída da pipeline pro social não é preservada em arquivo nenhum (o
 * humanizador reescreve `03-social.md` in-place), então o social dessas
 * edições é irrecuperável e fica de fora, declarado no stdout.
 *
 * Dry-run por padrão (imprime as entradas como JSON); `--write` acrescenta
 * em `editor-requests.jsonl` com `context.baseline: "reconstructed"` e grava
 * um marcador — uma 2ª chamada com `--write` é no-op. Recusa edição com
 * baseline `ok` (não há o que reconstruir).
 */
function backfillStage4(editionDir: string, edition: string, write: boolean): number {
  const health = assessStage2BaselineOnDisk(editionDir);
  if (health.status === "ok") {
    console.log(`[derive-editor-requests] backfill-stage4 ${edition}: baseline ok — nada a reconstruir.`);
    return 0;
  }
  const markerPath = join(editionDir, STAGE4_BACKFILL_MARKER);
  if (write && existsSync(markerPath)) {
    console.log(`[derive-editor-requests] backfill-stage4 ${edition}: já aplicado (marcador presente) — no-op.`);
    return 0;
  }
  const finalPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(finalPath)) {
    console.log(`[derive-editor-requests] backfill-stage4 ${edition}: 02-reviewed.md ausente — pulando.`);
    return 0;
  }
  const finalMd = readFileSync(finalPath, "utf8");
  const baseline = buildReconstructedNewsletterBaseline(editionDir, finalMd);
  if (baseline === null) {
    console.log(`[derive-editor-requests] backfill-stage4 ${edition}: nenhum arquivo da pipeline (02-humanized/02-clarice-corrected) — pulando.`);
    return 0;
  }
  const entries = classifyNewsletterDiff(baseline, normalizeNewsletterForComparison(finalMd)).map((e) => ({
    ...e,
    stage: 4,
    edition,
    source: "derived" as const,
    context: { ...(e.context ?? {}), baseline: "reconstructed", backfill: "#9356", baseline_status: health.status },
  }));
  if (!write) {
    console.log(JSON.stringify({ edition, baseline_status: health.status, social: "irrecuperável", entries }, null, 2));
    return entries.length;
  }
  for (const entry of entries) appendEditorRequest(editionDir, entry);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({ backfilled_at: new Date().toISOString(), entries: entries.length, baseline_status: health.status }, null, 2),
    "utf8",
  );
  console.log(`[derive-editor-requests] backfill-stage4 ${edition}: ${entries.length} pedidos derivados (baseline reconstruído).`);
  return entries.length;
}

/**
 * Diffa a seleção de destaques entre `01-categorized.json` (proposta do
 * `scorer-select`, sempre 6 candidatos, ANTES de qualquer gate) e
 * `01-approved.json` (2-3 finais, pós-gate do Stage 1) — #7964.
 *
 * Não reusa `classifyApprovedDiff` (que compara dois `01-approved.json` em
 * pontos distintos do tempo, por URL desde o #9753): os arrays aqui têm
 * tamanhos estruturalmente diferentes (6 vs 2-3)
 * por DESIGN, mesmo sem nenhuma ação do editor — `apply-gate-edits.ts`
 * sempre corta os 6 candidatos do scorer para os top-3 por rank quando a
 * seção Destaques do MD não foi tocada (`resolveDestaques`, `--auto` ou
 * aprovação sem edição). Um diff ingênuo de tamanho ou posição classificaria
 * esse corte mecânico como 3-4 `destaque-cut` em TODA edição, inclusive nas
 * auto-aprovadas — exatamente o ruído que motivou esta função a não reusar
 * `classifyApprovedDiff` aqui.
 *
 * Em vez disso, replica o mesmo cálculo que `computeGateProvenance`
 * (`apply-gate-edits.ts`, #4842) já usa pra decidir `itens_movidos`: só um
 * item aprovado que NÃO está no top-3 "natural" (top 3 do `highlights[]`
 * original, por rank) conta como pedido do editor. Itens do top-3 natural
 * que não sobrevivem ao aprovado, pareados 1-a-1 com itens promovidos de
 * fora do top-3, viram `destaque-swap`; sobra de um lado sem par vira
 * `destaque-cut` (menos destaques no final — caso de 2 destaques, #3369) ou
 * `destaque-promote` (mais um item promovido do que caiu do top-3 — não
 * deveria estourar o teto de 3, mas o pareamento não assume isso).
 */
export function classifyStage1DestaqueDiff(categorizedJson: any, approvedJson: any): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  type RawHighlight = { rank?: number; url?: string; title?: string; article?: { url?: string; title?: string } | null };
  const originalHighlights: RawHighlight[] = Array.isArray(categorizedJson?.highlights) ? categorizedJson.highlights : [];
  const approvedHighlights: RawHighlight[] = Array.isArray(approvedJson?.highlights) ? approvedJson.highlights : [];

  const urlOf = (h: RawHighlight): string | null => {
    const url = h?.url ?? h?.article?.url;
    return typeof url === "string" && url !== "" ? url : null;
  };
  const titleOf = (h: RawHighlight): string => h?.article?.title ?? h?.title ?? "";

  const top3 = [...originalHighlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 3);
  const canonTop3 = new Map<string, { url: string; title: string; rank: number }>();
  top3.forEach((h, i) => {
    const url = urlOf(h);
    if (url) canonTop3.set(canonicalizeUrl(url), { url, title: titleOf(h), rank: i + 1 });
  });

  const approvedEntries = approvedHighlights
    .map((h, i) => ({ url: urlOf(h), title: titleOf(h), position: i + 1 }))
    .filter((e): e is { url: string; title: string; position: number } => e.url !== null);
  const canonApprovedSet = new Set(approvedEntries.map((e) => canonicalizeUrl(e.url)));

  const droppedFromTop3: Array<{ url: string; title: string; rank: number }> = [];
  for (const entry of canonTop3.values()) {
    if (!canonApprovedSet.has(canonicalizeUrl(entry.url))) droppedFromTop3.push(entry);
  }

  const promoted = approvedEntries.filter((e) => !canonTop3.has(canonicalizeUrl(e.url)));

  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  const pairCount = Math.min(droppedFromTop3.length, promoted.length);
  for (let i = 0; i < pairCount; i++) {
    const dropped = droppedFromTop3[i];
    const added = promoted[i];
    // `target` usa o rank ORIGINAL do item removido (dropped.rank), não a
    // posição onde o item promovido acabou pousando em `01-approved.json`
    // (added.position) — achado de review (#7964): se o gate reordenar os
    // destaques sobreviventes (ex: dropar D1 e os demais "subirem" uma
    // posição), `added.position` podia divergir do "D{N}" citado na própria
    // `description`, produzindo uma entrada que se contradiz (target d3 com
    // texto "Destaque D1 trocado..."). `dropped.rank` é sempre o slot que a
    // troca de fato afeta, então target e description ficam consistentes
    // por construção — `added.position` continua registrado em `context`
    // pra quem precisar da posição real no aprovado.
    results.push({
      request_type: "destaque-swap",
      target: `d${dropped.rank}` as RequestTarget,
      description: `Destaque D${dropped.rank} trocado no gate do Stage 1: ${dropped.title} → ${added.title}`,
      resolution: "accepted",
      context: { old_url: dropped.url, new_url: added.url, position: added.position },
    });
  }
  for (let i = pairCount; i < droppedFromTop3.length; i++) {
    const dropped = droppedFromTop3[i];
    results.push({
      request_type: "destaque-cut",
      target: `d${dropped.rank}` as RequestTarget,
      description: `Destaque D${dropped.rank} removido no gate do Stage 1: ${dropped.title}`,
      resolution: "accepted",
      context: { old_url: dropped.url, position: dropped.rank },
    });
  }
  for (let i = pairCount; i < promoted.length; i++) {
    const added = promoted[i];
    results.push({
      request_type: "destaque-promote",
      target: `d${added.position}` as RequestTarget,
      description: `Item promovido a destaque D${added.position} no gate do Stage 1: ${added.title}`,
      resolution: "accepted",
      context: { new_url: added.url, position: added.position },
    });
  }

  return results;
}

/**
 * Função principal - deriva requests no fechamento do gate do Stage 1 (#7964)
 *
 * Diferente de `deriveStage4`/`deriveStage6`, não precisa de nenhum snapshot
 * dedicado: `_internal/01-categorized.json` já É o baseline pré-gate
 * imutável — `apply-gate-edits.ts` grava só `_internal/01-approved.json`
 * como saída, nunca reescreve `01-categorized.json` — e os dois arquivos
 * coexistem pra sempre a partir do fim do Stage 1.
 *
 * **Gate no `auto_approved` de `_internal/.step-1-gate.json` (#4842),
 * não em "o conteúdo mudou"**: sob `--no-gates`/auto-aprovação (17 das
 * últimas 20 edições medidas na correção de premissa do #7964 — comentário
 * do editor de 10/09/2026), a seção Destaques do MD simulado é sempre
 * vazia e `resolveDestaques` PREENCHE por rank do scorer — nenhum editor
 * decidiu nada. Pior: o próprio preenchimento pode pular um rank do top-3
 * por dedup-intra-edition remover a cópia antes do gate (#4943), produzindo
 * uma "troca" mecânica que pareceria `destaque-swap` se este código rodasse
 * também sob `auto_approved: true`. Arquivo de proveniência ausente ou
 * malformado (edição anterior ao #4842, ou erro de leitura) também pula —
 * fail-soft, nunca deriva às cegas sem o sinal determinístico.
 *
 * **Limitação aceita (achado de review #7964):** `auto_approved: false`
 * garante que houve um gate humano, mas não garante que TODA mudança
 * observada foi uma decisão consciente do editor — o mesmo fill-loop de
 * `resolveDestaques`/#4943 que produz `itens_movidos` "por acidente" sob
 * `--auto` também roda no caminho interativo quando a seção Destaques do MD
 * revisado tem menos de 2 URLs (editor não tocou nela, ou apagou tudo sem
 * querer): o preenchimento por rank do scorer é indistinguível de escolha
 * editorial pra este código, do mesmo jeito que já é indistinguível pra
 * `computeGateProvenance`. Não há sinal determinístico adicional pra
 * separar os dois casos sem mudar o schema de `.step-1-gate.json` — aceito
 * como o mesmo risco residual que #4943 já documenta pro `itens_movidos`,
 * não uma regressão nova introduzida aqui.
 *
 * **Idempotência (achado de fleet review #8081):** diferente de
 * `deriveStage4`/`deriveStage6` — que diffam contra um snapshot e por isso
 * uma 2ª chamada naturalmente vê "sem mudança" (o snapshot já reflete o
 * estado anterior) —, este comando não usa snapshot: diffa direto
 * `01-categorized.json` × `01-approved.json`, dois arquivos que continuam
 * IDÊNTICOS numa 2ª chamada. Sem um marcador de "já derivado", cada
 * reexecução (ex: `/diaria-1-pesquisa {mesmo AAMMDD}` retomando um Stage 1
 * interrompido DEPOIS deste passo já ter rodado uma vez) duplicaria as
 * mesmas entradas em `editor-requests.jsonl` via `appendEditorRequest`
 * (`log-editor-request.ts`, append-only, sem chave de dedup). Guard via
 * marcador `_internal/.step-1-editor-requests-derived.json` — mesmo
 * padrão de imutabilidade de `hasSnapshot`/`snapshotStage2`/`snapshotStage4`
 * acima, só que sem diretório de snapshot (não há conteúdo pra preservar,
 * só o FATO de já ter derivado).
 *
 * **Marcador guarda um `content_hash`, não só o fato de "já derivado" (#8106).**
 * O gate do Stage 1 tem a opção "rejeitar e re-rodar" (`.claude/agents/orchestrator-stage-1-research.md`
 * §1x item 2): `01-categorized.json`/`01-approved.json` são regenerados e o
 * editor passa por um 2º gate. Um marcador que só registra "já rodou uma vez"
 * (sem checar SE o conteúdo mudou) faz esta função virar no-op silencioso no
 * 2º gate — exatamente as edições que valem (a 2ª passada) nunca são
 * derivadas, e só as descartadas (a 1ª) ficam em `editor-requests.jsonl`.
 * `computeStage1ContentHash` faz sha256 do conteúdo bruto de
 * `01-categorized.json` + `01-approved.json` concatenado; o marcador só é
 * tratado como "já derivado pra este conteúdo" quando o hash gravado bate
 * com o hash atual dos dois arquivos — conteúdo diferente (novo gate) sempre
 * deriva de novo, e reexecução genuína com os mesmos arquivos (retomada de
 * Stage 1 interrompido) continua idempotente.
 */
const STAGE1_DERIVED_MARKER = "_internal/.step-1-editor-requests-derived.json";

interface Stage1DerivedMarker {
  derived_at: string;
  entries_derived: number;
  /** sha256 de `01-categorized.json` + `01-approved.json` no momento da derivação (#8106). */
  content_hash?: string;
}

function readStage1DerivedMarker(editionDir: string): Stage1DerivedMarker | null {
  const markerPath = resolve(editionDir, STAGE1_DERIVED_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8")) as Stage1DerivedMarker;
  } catch {
    return null;
  }
}

function computeStage1ContentHash(catPath: string, apprPath: string): string {
  const catRaw = readFileSync(catPath, "utf8");
  const apprRaw = readFileSync(apprPath, "utf8");
  return createHash("sha256").update(catRaw).update("\0").update(apprRaw).digest("hex");
}

function writeStage1DerivedMarker(editionDir: string, count: number, contentHash: string): void {
  const markerPath = resolve(editionDir, STAGE1_DERIVED_MARKER);
  mkdirSync(dirname(markerPath), { recursive: true });
  const marker: Stage1DerivedMarker = { derived_at: new Date().toISOString(), entries_derived: count, content_hash: contentHash };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
}

function deriveStage1(editionDir: string, edition: string): number {
  const gatePath = join(editionDir, "_internal", ".step-1-gate.json");
  if (!existsSync(gatePath)) {
    console.log(`[derive-editor-requests] Stage 1 gate: .step-1-gate.json ausente — pulando (edição anterior ao #4842, ou apply-gate-edits.ts não rodou).`);
    return 0;
  }

  let gate: { auto_approved?: boolean };
  try {
    gate = JSON.parse(readFileSync(gatePath, "utf8"));
  } catch (err) {
    console.log(`[derive-editor-requests] Stage 1 gate: .step-1-gate.json malformado — pulando (${err instanceof Error ? err.message : String(err)}).`);
    return 0;
  }

  if (gate.auto_approved !== false) {
    console.log(`[derive-editor-requests] Stage 1 gate: auto_approved=${gate.auto_approved ?? "ausente"} — sem gate humano real, nada a derivar (#4842/#4943).`);
    return 0;
  }

  const catPath = join(editionDir, "_internal", "01-categorized.json");
  const apprPath = join(editionDir, "_internal", "01-approved.json");
  if (!existsSync(catPath) || !existsSync(apprPath)) {
    console.log(`[derive-editor-requests] Stage 1 gate: 01-categorized.json ou 01-approved.json ausente — pulando.`);
    return 0;
  }

  // Idempotência por CONTEÚDO, não só pela existência do marcador (#8106):
  // "rejeitar e re-rodar" regenera 01-categorized.json/01-approved.json e o
  // editor passa por um 2º gate — um marcador que só registrasse "já rodou"
  // faria essa 2ª passada (a que vale) virar no-op silencioso.
  const contentHash = computeStage1ContentHash(catPath, apprPath);
  const existingMarker = readStage1DerivedMarker(editionDir);
  if (existingMarker && existingMarker.content_hash === contentHash) {
    console.log(`[derive-editor-requests] Stage 1 gate: já derivado anteriormente pra este conteúdo (hash bate) — no-op, idempotente (#8081/#8106).`);
    return 0;
  }

  let categorizedJson: any;
  let approvedJson: any;
  try {
    categorizedJson = JSON.parse(readFileSync(catPath, "utf8"));
    approvedJson = JSON.parse(readFileSync(apprPath, "utf8"));
  } catch (err) {
    console.log(`[derive-editor-requests] Stage 1 gate: JSON malformado — pulando (${err instanceof Error ? err.message : String(err)}).`);
    return 0;
  }

  const poolEntries = classifyPoolDiff(categorizedJson, approvedJson);
  const destaqueEntries = classifyStage1DestaqueDiff(categorizedJson, approvedJson);

  let count = 0;
  for (const entry of [...poolEntries, ...destaqueEntries]) {
    appendEditorRequest(editionDir, { ...entry, stage: 1, edition, source: "derived" });
    count++;
  }

  writeStage1DerivedMarker(editionDir, count, contentHash);
  console.log(`[derive-editor-requests] Stage 1 gate: ${count} pedidos derivados`);
  return count;
}

/**
 * CLI
 */
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const args = parsed.values;
  const command = parsed.positional[0];

  if (!command) {
    console.error("Uso: derive-editor-requests.ts <derive-stage1|snapshot-stage2|snapshot-stage4|derive-stage4|derive-stage6|backfill-stage4> --edition AAMMDD [--write]");
    process.exit(2);
  }

  const edition = args.edition;
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("Edition AAMMDD obrigatório");
    process.exit(2);
  }

  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir = resolveEditionDir(editionsRootDir, edition);
  // Run-log: com `--editions-dir` custom (testes/isolamento), loga DENTRO
  // desse diretório — nunca no `data/run-log.jsonl` real (#9356).
  const runLogRoot = args["editions-dir"] ? editionsRootDir : ROOT;

  if (!existsSync(editionDir)) {
    console.error(`Edition dir não existe: ${editionDir}`);
    process.exit(2);
  }

  switch (command) {
    case "derive-stage1":
      deriveStage1(editionDir, edition);
      break;
    case "snapshot-stage2":
      snapshotStage2(editionDir);
      break;
    case "snapshot-stage4":
      snapshotStage4(editionDir);
      break;
    case "derive-stage4":
      deriveStage4(editionDir, edition, runLogRoot);
      break;
    case "backfill-stage4":
      backfillStage4(editionDir, edition, parsed.flags.has("write"));
      break;
    case "derive-stage6":
      deriveStage6(editionDir, edition);
      break;
    default:
      console.error(`Comando desconhecido: ${command}`);
      process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}