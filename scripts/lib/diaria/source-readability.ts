/**
 * source-readability.ts (#12258)
 *
 * O pipeline lê da fonte só o que o Stage 1 guardou em `summary` (og:description,
 * trecho do RSS, frase da newsletter que citou o link). Quando a página devolve
 * 403/anti-bot, é vídeo sem transcrição, ou o resumo é uma frase só, ninguém leu
 * o texto: nem o pipeline, nem o fact-check (que só cobre destaques). Caso real
 * da edição 261105: item do RADAR com score 65 e resumo "Rogue AI models are an
 * emerging security threat." (48 caracteres); o editor só descobriu o 403 ao
 * tentar promovê-lo.
 *
 * Este módulo é a regra única, pura, que decide "a fonte foi lida?":
 *   - `merge-scored-chunks.ts` aplica o desconto de score (antes do corte de
 *     finalistas, mesmo ponto dos bônus de cobertura/newsletter);
 *   - `finalize-stage1.ts` grava `source_readable: false` + o motivo em
 *     `01-approved.json`;
 *   - o invariante `source-not-read` do Stage 4 lista no gate os itens da
 *     edição cuja fonte não foi lida;
 *   - `swap-destaque.ts`/`promote-to-destaque.ts` avisam ao promover um deles.
 *
 * Limiar de resumo medido nas 20 edições anteriores a 261105 (1.861 itens
 * aprovados): <60 caracteres pega 131 itens (7%), somados aos vereditos de
 * acesso abaixo dá ~12,6% do aprovado e 10 de 60 destaques.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "../invariant-checks/types.ts";
import { readPoolDescriptionsApplied, readPoolSourcesManifest } from "./pool-sources.ts";

/**
 * Vereditos de `verify-accessibility.ts` em que o texto da página não chegou
 * ao pipeline: 403/429 (`anti_bot`, `uncertain`), paywall, bloqueio, erro e
 * re-verificação pendente. `accessible` e `aggregator` não entram (agregador
 * já é barrado por outra regra).
 *
 * `video` também não entra (#12320): `verify-accessibility.ts` dá esse
 * veredito a TODA URL de vídeo (YouTube etc.) e o conta como OK, então tê-lo
 * aqui descontava 10 pontos e acusava no gate todo item da seção VÍDEOS, mesmo
 * com descrição longa. Vídeo cai na regra do resumo abaixo, que pega o vídeo
 * sem texto (o caso do g1 do #12258: página de título + uma linha).
 */
export const UNREAD_VERIFY_VERDICTS: ReadonlySet<string> = new Set([
  "paywall",
  "anti_bot",
  "blocked",
  "uncertain",
  "error",
  "needs_reverify",
]);

/** Resumo com menos caracteres que isto conta como fonte não lida. */
export const SOURCE_SUMMARY_MIN_CHARS = 60;

/** Desconto de score para item com fonte não lida (aplicado no merge dos chunks). */
export const SOURCE_UNREADABLE_PENALTY = 10;

/** Entrada que o desconto grava em `bonuses_applied`. */
export const SOURCE_UNREADABLE_BONUS_ENTRY = `source-unread:-${SOURCE_UNREADABLE_PENALTY}`;

export interface SourceReadability {
  readable: boolean;
  /** Motivo legível quando `readable === false` (ex.: `verify anti_bot (GET 403)`). */
  reason?: string;
}

/**
 * A fonte do artigo foi lida? Olha `verify_verdict` e o tamanho de `summary`.
 * Aceita o artigo cru ou o item de highlight (`{ article: {...} }`). @pure
 */
export function assessSourceReadability(item: unknown): SourceReadability {
  if (!item || typeof item !== "object") return { readable: true };
  const wrapped = (item as { article?: unknown }).article;
  const a = (wrapped && typeof wrapped === "object" ? wrapped : item) as {
    verify_verdict?: unknown;
    verify_note?: unknown;
    summary?: unknown;
  };
  const verdict = typeof a.verify_verdict === "string" ? a.verify_verdict : null;
  if (verdict && UNREAD_VERIFY_VERDICTS.has(verdict)) {
    const note = typeof a.verify_note === "string" && a.verify_note.trim() ? ` (${a.verify_note.trim()})` : "";
    return { readable: false, reason: `verify ${verdict}${note}` };
  }
  // Sem veredito de acesso E sem campo `summary`, o item não passou pelo verify
  // nem pela extração (fixture, item injetado à mão): não há o que julgar. Em
  // produção todo item tem `verify_verdict` (9 de 1.861 sem ele nas 20 edições
  // medidas), então isto não abre brecha para o item sem resumo que foi
  // verificado — esse cai na regra do resumo abaixo.
  if (verdict === null && a.summary === undefined) return { readable: true };
  const summary = typeof a.summary === "string" ? a.summary.trim() : "";
  if (summary.length < SOURCE_SUMMARY_MIN_CHARS) {
    return {
      readable: false,
      reason: summary.length === 0
        ? "sem resumo da fonte"
        : `resumo de ${summary.length} caracteres (mínimo ${SOURCE_SUMMARY_MIN_CHARS})`,
    };
  }
  return { readable: true };
}

/**
 * Desconto de score do merge: `SOURCE_UNREADABLE_PENALTY` para fonte não lida,
 * 0 para o resto. Item enviado pelo editor (`editor_submitted: true`) não leva
 * desconto: foi escolha dele, e o aviso do gate continua valendo. @pure
 */
export function sourceUnreadablePenalty(item: unknown): number {
  if (!item || typeof item !== "object") return 0;
  if ((item as { editor_submitted?: unknown }).editor_submitted === true) return 0;
  return assessSourceReadability(item).readable ? 0 : SOURCE_UNREADABLE_PENALTY;
}

/**
 * Lê o veredito gravado em `01-approved.json` (`source_readable`) e cai na
 * regra quando o campo não existe (edição anterior ao #12258). @pure
 */
export function readSourceReadability(item: unknown): SourceReadability {
  if (!item || typeof item !== "object") return { readable: true };
  const wrapped = (item as { article?: unknown }).article;
  const a = (wrapped && typeof wrapped === "object" ? wrapped : item) as {
    source_readable?: unknown;
    source_unreadable_reason?: unknown;
  };
  if (a.source_readable === true) return { readable: true };
  if (a.source_readable === false) {
    return {
      readable: false,
      reason: typeof a.source_unreadable_reason === "string" ? a.source_unreadable_reason : "marcado no Stage 1",
    };
  }
  return assessSourceReadability(item);
}

export interface UnreadItemInEdition {
  url: string;
  title: string;
  reason: string;
  /** Item é D1/D2/D3 em `01-approved.json`. */
  highlight: boolean;
}

const APPROVED_BUCKETS = ["highlights", "lancamento", "radar", "use_melhor", "video"] as const;

/**
 * (#13884) Resultado do download da página por URL, lido dos manifests de
 * `_internal/pool-sources/` (itens de pool) e `_internal/fact-check-sources/`
 * (destaques). `ok: true` = alguém do pipeline LEU o texto da página (o
 * fact-checker, nos destaques, #13907; o `writer-pool`, nos itens de pool cuja
 * descrição reescreveu, #13884); `ok: false` = o download falhou
 * (403, erro), trouxe só a prévia do paywall ou uma página quase vazia, com o
 * motivo. URL sem entrada segue a regra do resumo (`readSourceReadability`).
 */
export type SourceDownloads = ReadonlyMap<string, { ok: boolean; reason?: string }>;

/**
 * (#13907) Texto baixado com menos palavras que isto não conta como página
 * lida: `fetchSourceText` devolve `ok` para qualquer texto não vazio, e a
 * casca de uma página montada por JS chega como poucas dezenas de palavras.
 * Premissa sem medição (nenhuma edição tinha `words` no manifest do pool
 * antes do #13884): 100 palavras ficam abaixo de qualquer notícia curta real
 * e acima da casca típica. Entrada sem `words` (manifest anterior ao #12537)
 * não passa pelo piso.
 */
export const SOURCE_TEXT_MIN_WORDS = 100;

/**
 * (#13884, decisão do editor de 25/11/2026) O texto baixado de um item de pool
 * só conta como LIDO quando a descrição do item foi reescrita a partir dele
 * pelo `writer-pool` (Stage 2, `scripts/pool-descriptions.ts --apply`), que
 * grava a URL em `_internal/pool-sources/descriptions-applied.json`. Download
 * `ok` sem esse registro não limpa a regra do resumo curto (#13907): baixar a
 * página não é ler, a descrição continuaria saindo só do `summary`.
 */
/** (#13907) Motivo para download `ok` abaixo de `SOURCE_TEXT_MIN_WORDS`. */
function thinPageReason(words: number): string {
  return `página baixada com ${words} palavras (mínimo ${SOURCE_TEXT_MIN_WORDS})`;
}

/** (#13907) Download `ok` com `words` abaixo do piso (casca de JS). @pure */
function isThinText(words: unknown): words is number {
  return typeof words === "number" && words < SOURCE_TEXT_MIN_WORDS;
}

/**
 * (#13884) Motivo de "fonte não lida" para download `ok` com `completeness:
 * "preview"` (#12537): o texto em disco é só a prévia que o paywall serve, não
 * o artigo.
 */
const PAYWALL_PREVIEW_REASON = "só a prévia do paywall foi baixada";

/**
 * (#13884) Monta `SourceDownloads` a partir dos manifests da edição. Entrada
 * `skipped` (vídeo do YouTube) não entra: segue julgada pela regra do resumo.
 * Manifest ausente ou ilegível = sem entradas (edição anterior ao #13884).
 *
 * (#13907/#13884) Entrada `ok` do pool só vira `ok: true` quando o
 * `writer-pool` reescreveu a descrição a partir do texto
 * (`readPoolDescriptionsApplied`); sem isso fica sem entrada e o item segue na
 * regra do resumo. Prévia de paywall e falha de download seguem acrescentando
 * o motivo. `ok` abaixo de `SOURCE_TEXT_MIN_WORDS` conta como não lida (no
 * pool e no manifest do fact-check).
 */
export function readSourceDownloads(internalDir: string): Map<string, { ok: boolean; reason?: string }> {
  const out = new Map<string, { ok: boolean; reason?: string }>();
  const consumed = readPoolDescriptionsApplied(internalDir);
  for (const e of readPoolSourcesManifest(internalDir)) {
    if (e.status === "ok" && e.completeness === "preview") out.set(e.url, { ok: false, reason: PAYWALL_PREVIEW_REASON });
    else if (e.status === "ok") {
      if (!consumed.has(e.url)) continue;
      out.set(e.url, isThinText(e.words) ? { ok: false, reason: thinPageReason(e.words) } : { ok: true });
    } else if (e.status === "blocked" || e.status === "error") {
      out.set(e.url, { ok: false, reason: `download da página falhou: ${e.erro ?? e.status}` });
    }
  }
  const fc = resolve(internalDir, "fact-check-sources", "manifest.json");
  if (existsSync(fc)) {
    try {
      const raw = JSON.parse(readFileSync(fc, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const e of raw as Array<{ url?: unknown; status?: unknown; erro?: unknown; completeness?: unknown; words?: unknown }>) {
          if (!e || typeof e.url !== "string") continue;
          if (e.status === "ok" && e.completeness === "preview") {
            if (!out.get(e.url)?.ok) out.set(e.url, { ok: false, reason: PAYWALL_PREVIEW_REASON });
          } else if (e.status === "ok" && isThinText(e.words)) {
            if (!out.get(e.url)?.ok) out.set(e.url, { ok: false, reason: thinPageReason(e.words) });
          } else if (e.status === "ok") out.set(e.url, { ok: true });
          else if (!out.get(e.url)?.ok) {
            out.set(e.url, { ok: false, reason: `download da página falhou: ${typeof e.erro === "string" ? e.erro : String(e.status)}` });
          }
        }
      }
    } catch {
      // manifest ilegível: sem informação de download
    }
  }
  return out;
}

/**
 * Itens de `01-approved.json` com fonte não lida que estão no texto final
 * (`02-reviewed.md`, por URL). Item cortado da edição não entra.
 *
 * (#13884) Com `downloads`, a entrada da URL decide antes do resumo: `ok` =
 * fonte lida (mesmo com resumo curto ou veredito de acesso ruim no Stage 1);
 * falha = fonte não lida, com o motivo do download. URL sem entrada cai na
 * regra de sempre. Download `ok` do pool só gera entrada quando o
 * `writer-pool` reescreveu a descrição a partir dele (#13907/#13884, ver
 * `readSourceDownloads`). @pure
 */
export function findUnreadItemsInEdition(
  approved: unknown,
  reviewedMd: string,
  downloads?: SourceDownloads,
): UnreadItemInEdition[] {
  if (!approved || typeof approved !== "object") return [];
  const out: UnreadItemInEdition[] = [];
  const seen = new Set<string>();
  for (const bucket of APPROVED_BUCKETS) {
    const list = (approved as Record<string, unknown>)[bucket];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const wrapped = (item as { article?: unknown }).article;
      const a = (wrapped && typeof wrapped === "object" ? wrapped : item) as { url?: unknown; title?: unknown };
      const url = typeof a.url === "string" ? a.url : typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url : null;
      if (!url || seen.has(url) || !reviewedMd.includes(url)) continue;
      const d = downloads?.get(url);
      const r: SourceReadability = d ? (d.ok ? { readable: true } : { readable: false, reason: d.reason }) : readSourceReadability(item);
      if (r.readable) continue;
      seen.add(url);
      out.push({
        url,
        title: typeof a.title === "string" && a.title.trim() ? a.title.trim() : url,
        reason: r.reason ?? "fonte não lida",
        highlight: bucket === "highlights",
      });
    }
  }
  return out;
}

/** (#13884) Arquivo do aceite do editor para item de pool com fonte não lida. */
export const SOURCE_NOT_READ_ACK_FILE = "source-not-read-ack.json";

export interface SourceNotReadAck {
  url: string;
  reason: string;
  acked_at: string;
}

/**
 * (#13884) Aceites registrados pelo editor (`scripts/ack-source-not-read.ts`)
 * em `_internal/source-not-read-ack.json`. Ausente ou ilegível = nenhum
 * (fail-closed: sem aceite legível o item segue bloqueando o gate).
 */
export function readSourceNotReadAcks(internalDir: string): Map<string, SourceNotReadAck> {
  const out = new Map<string, SourceNotReadAck>();
  const p = resolve(internalDir, SOURCE_NOT_READ_ACK_FILE);
  if (!existsSync(p)) return out;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { acks?: unknown };
    if (!Array.isArray(raw?.acks)) return out;
    for (const a of raw.acks as Array<Partial<SourceNotReadAck>>) {
      if (a && typeof a.url === "string" && typeof a.reason === "string" && a.reason.trim()) {
        out.set(a.url, { url: a.url, reason: a.reason.trim(), acked_at: typeof a.acked_at === "string" ? a.acked_at : "" });
      }
    }
  } catch {
    // ilegível: nenhum aceite
  }
  return out;
}

/**
 * Invariante Stage 4 `source-not-read` (#12258; severidade dividida no #13884).
 *
 * Decisão do editor de 25/11/2026: item de POOL (LANÇAMENTOS, RADAR, USE
 * MELHOR, VÍDEOS) com fonte não lida é **error** — bloqueia o gate e, com
 * `--no-gates`, para a edição em halt banner (`orchestrator-stage-4.md` §5).
 * Só entra com decisão explícita do editor: tirar/trocar o item, ou registrar
 * o aceite (`scripts/ack-source-not-read.ts`), que o rebaixa a warning.
 * Destaque com fonte não lida segue **warning**: o fact-check do destaque já
 * expõe o problema (NOT_FOUND_IN_SOURCE) e trocar um destaque é decisão maior.
 */
export function checkSourceNotRead(editionDir: string): InvariantViolation[] {
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(approvedPath) || !existsSync(mdPath)) return [];
  let approved: unknown;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8"));
  } catch {
    return []; // JSON ilegível já é acusado por outras regras do Stage 4
  }
  const internalDir = resolve(editionDir, "_internal");
  const items = findUnreadItemsInEdition(approved, readFileSync(mdPath, "utf8"), readSourceDownloads(internalDir));
  if (items.length === 0) return [];
  const acks = readSourceNotReadAcks(internalDir);
  const fmt = (i: UnreadItemInEdition) => `${i.highlight ? "[DESTAQUE] " : ""}"${i.title}" (${i.reason}) ${i.url}`;
  const blocking = items.filter((i) => !i.highlight && !acks.has(i.url));
  const highlights = items.filter((i) => i.highlight);
  const acked = items.filter((i) => !i.highlight && acks.has(i.url));
  const out: InvariantViolation[] = [];
  if (blocking.length > 0) {
    out.push({
      rule: "source-not-read",
      message:
        `fonte não lida: ${blocking.length} item(ns) de pool chegaram ao texto só com título e resumo, sem ninguém ler a página ` +
        `(403, vídeo sem texto ou resumo curto): ${blocking.map(fmt).join("; ")}. ` +
        `Item de pool sem texto lido não entra sem decisão do editor (#13884): tirar ou trocar o item, ou registrar o aceite com ` +
        `\`npx tsx scripts/ack-source-not-read.ts --edition-dir ${editionDir} --url {URL} --reason "{motivo}"\`. ` +
        `Com --no-gates, halt banner (sem editor para decidir).`,
      source_issue: "#13884",
      severity: "error",
      file: mdPath,
    });
  }
  const soft = [...highlights, ...acked];
  if (soft.length > 0) {
    const fmtSoft = (i: UnreadItemInEdition) => (acks.has(i.url) && !i.highlight ? `${fmt(i)} [aceito pelo editor: ${acks.get(i.url)!.reason}]` : fmt(i));
    out.push({
      rule: "source-not-read",
      message:
        `fonte não lida: ${soft.length} item(ns) da edição chegaram ao texto só com título e resumo, sem ninguém ler a página ` +
        `(403, vídeo sem texto ou resumo curto): ${soft.map(fmtSoft).join("; ")}.` +
        (highlights.length > 0 ? ` ${highlights.length} é(são) destaque: o fact-check desses tende a sair NOT_FOUND_IN_SOURCE.` : "") +
        ` Abrir a fonte antes de aprovar ou trocar o item (#12258).`,
      source_issue: "#12258",
      severity: "warning",
      file: mdPath,
    });
  }
  return out;
}

/** Aviso padrão ao promover a destaque um item com fonte não lida. @pure */
export function promotedSourceUnreadWarning(item: unknown, title: string): string | null {
  const r = readSourceReadability(item);
  if (r.readable) return null;
  return (
    `fonte do item promovido "${title}" não foi lida (${r.reason}, #12258): o writer-destaque e o fact-check ` +
    `só terão o título e o resumo — abrir a página e conferir antes de escrever o destaque.`
  );
}
