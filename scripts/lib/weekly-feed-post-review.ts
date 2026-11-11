/**
 * scripts/lib/weekly-feed-post-review.ts (#12794)
 *
 * Guard mecânico do post de feed do `/diaria-linkedin-semanal` (Passo 8d).
 * O texto é redação nova a cada ciclo e precisa passar por Humanizador +
 * Clarice antes de ir pro editor no Passo 9 (#10384). A regra existia só em
 * prosa no SKILL.md e falhou duas vezes (`26w42`, origem da #10384, e `26w45`,
 * achado da #12787): versões do post saíram sem as duas passadas e o editor
 * teve de perguntar.
 *
 * Mesmo desenho do marcador da cédula da votação de tema
 * (`scripts/lib/voto-tema-revisao.ts`, #11199, cuja validação de forma é
 * reusada aqui): o texto final mora num arquivo,
 * `data/weekly/{cycle}/_internal/ln-feed-post.txt`, e o marcador
 * `_internal/ln-feed-post-review.json` guarda o sha256 desse texto no momento
 * em que as passadas foram atestadas. Qualquer edição posterior (inclusive uma
 * nova versão pedida pelo editor) muda o hash e invalida o marcador, então o
 * check do Passo 9 recusa até as duas passadas rodarem de novo. "Depois da
 * última edição" é medido por conteúdo, não por relógio: o OneDrive reescreve
 * mtime ao sincronizar.
 *
 * A Clarice deixa evidência no disco: o `{S}-filtrado.json` que o Passo 5 já
 * manda gravar com `clarice-filter.ts`. O marcador exige esse arquivo e
 * confere que cada sugestão mantida foi de fato aplicada no texto (o `from`
 * não sobra sem o `to`). O filtrado fica amarrado ao texto enviado à Clarice
 * (`_internal/ln-feed-post-clarice-input.txt`): `clarice-filter.ts
 * --source-text` grava o sha256 desse texto num sidecar, e o texto final tem
 * de ser esse texto com as sugestões aplicadas, então um `[]` velho ou o
 * filtrado de uma versão anterior não passa para a versão nova (finding do
 * self-review da PR #12823). Sugestão recusada de propósito (marca, identificador
 * técnico) passa só com motivo declarado, gravado no marcador. O humanizador
 * não deixa arquivo; a flag `--humanizador` é atestado explícito, como no
 * #11199.
 *
 * Também confere o terceiro item da prosa do Passo 8d: zero travessões
 * (nem `—` nem `–`) no texto final.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ClariceSuggestion } from "./schemas/clarice-suggestions.ts";
import { clariceSourceHash, isClariceSourceSidecar, rawSha256 } from "./clarice-source-binding.ts";
import { isRevisaoMarker, type RevisaoMarker } from "./voto-tema-revisao.ts";

/** Arquivo com o texto final do post de feed, relativo a `data/weekly/{cycle}/`. */
export const FEED_POST_REL = "_internal/ln-feed-post.txt";
/** Marcador da revisão, relativo a `data/weekly/{cycle}/`. */
export const FEED_POST_REVIEW_REL = "_internal/ln-feed-post-review.json";
/** Texto exato enviado à Clarice (pós-humanizador, sem travessão), relativo a `data/weekly/{cycle}/`. */
export const FEED_POST_CLARICE_INPUT_REL = "_internal/ln-feed-post-clarice-input.txt";

/** Comando que grava o marcador, citado nas mensagens de recusa. */
export const MARK_COMMAND =
  "npx tsx scripts/weekly-feed-post-review.ts --cycle {cycle} --mark --humanizador --clarice-filtered {S}-filtrado.json";

export function feedPostPath(cycleDir: string): string {
  return join(cycleDir, FEED_POST_REL);
}

export function feedPostReviewPath(cycleDir: string): string {
  return join(cycleDir, FEED_POST_REVIEW_REL);
}

export function feedPostClariceInputPath(cycleDir: string): string {
  return join(cycleDir, FEED_POST_CLARICE_INPUT_REL);
}

export interface FeedPostReviewMarker extends RevisaoMarker {
  /** Sugestões mantidas pelo `clarice-filter.ts` nesta passada. */
  clarice_sugestoes: number;
  /** Sugestões não aplicadas de propósito (marca, identificador técnico). */
  clarice_nao_aplicadas?: Array<{ from: string; to: string }>;
  /** Motivo declarado para as não aplicadas. */
  clarice_motivo?: string;
  /** sha256 do texto enviado à Clarice, conferido contra o sidecar do filtrado. */
  clarice_input_hash?: string;
}

export type FeedPostReviewCheck =
  | { ok: true; marker: FeedPostReviewMarker }
  | { ok: false; reason: string };

/** Normaliza fim de linha e bordas: Write/colagem não devem mudar o hash. @pure */
export function normalizeFeedPost(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** sha256 hex do texto normalizado. @pure */
export function feedPostHash(text: string): string {
  return createHash("sha256").update(normalizeFeedPost(text), "utf8").digest("hex");
}

/** Linhas (1-based) com travessão (`—`) ou meia-risca (`–`). @pure */
export function findDashLines(text: string): number[] {
  return normalizeFeedPost(text)
    .split("\n")
    .flatMap((line, i) => (/[—–]/.test(line) ? [i + 1] : []));
}

/**
 * Sugestões mantidas que não aparecem aplicadas no texto: o `from` ainda está
 * lá e o `to` não. Sugestão de remoção (`to` vazio) ou sem mudança fica de
 * fora, porque o texto sozinho não distingue "aplicada" de "o trecho ocorre
 * em outro ponto". @pure
 */
export function findUnappliedSuggestions(text: string, suggestions: ClariceSuggestion[]): ClariceSuggestion[] {
  const t = normalizeFeedPost(text);
  return suggestions.filter((s) => {
    const from = s.from.trim();
    const to = s.to.trim();
    if (!from || !to || from === to) return false;
    return t.includes(from) && !t.includes(to);
  });
}

/**
 * Prova de que o filtrado veio do texto enviado à Clarice (#12794): o texto de
 * entrada, o conteúdo bruto do `{S}-filtrado.json` e o sidecar
 * `{S}-filtrado.json.source.json` gravado por `clarice-filter.ts --source-text`.
 */
export interface ClariceBinding {
  /** Conteúdo de `_internal/ln-feed-post-clarice-input.txt`; `null` = ausente. */
  inputText: string | null;
  /** Conteúdo bruto do filtrado, como está no disco. */
  filteredRaw: string;
  /** JSON do sidecar; `null` = ausente. */
  sidecar: unknown;
}

/**
 * Aplica as sugestões ao texto de entrada, uma a uma, na 1ª ocorrência
 * (`all=false`) ou em todas (`all=true`). @pure
 */
export function applyClariceSuggestions(text: string, suggestions: ClariceSuggestion[], all: boolean): string {
  let t = normalizeFeedPost(text);
  for (const s of suggestions) {
    if (!s.from || s.from === s.to) continue;
    t = all ? t.split(s.from).join(s.to) : t.replace(s.from, () => s.to);
  }
  return normalizeFeedPost(t);
}

export interface BuildMarkerInput {
  text: string;
  humanizador: boolean;
  /** Sugestões já filtradas por `clarice-filter.ts`; `null` = arquivo não informado. */
  clariceFiltered: ClariceSuggestion[] | null;
  /** Amarração do filtrado ao texto enviado à Clarice; ausente = recusa. */
  clariceBinding?: ClariceBinding;
  /** Motivo para aceitar sugestões não aplicadas de propósito. */
  allowUnapplied?: string;
  now: Date;
}

export type BuildMarkerResult = { ok: true; marker: FeedPostReviewMarker } | { ok: false; reason: string };

/** Monta o marcador para o texto atual, recusando o que a prosa proíbe. @pure */
export function buildFeedPostReviewMarker(input: BuildMarkerInput): BuildMarkerResult {
  const { text, humanizador, clariceFiltered, now } = input;
  const motivo = input.allowUnapplied?.trim() || undefined;
  if (!normalizeFeedPost(text)) {
    return { ok: false, reason: "texto do post de feed vazio." };
  }
  if (!humanizador) {
    return {
      ok: false,
      reason: "passe --humanizador: a flag atesta que o humanizador (9 passos) rodou sobre este texto.",
    };
  }
  if (!clariceFiltered) {
    return {
      ok: false,
      reason:
        "passe --clarice-filtered com o {S}-filtrado.json gravado por clarice-filter.ts a partir das sugestões " +
        "de mcp__clarice__correct_text sobre este texto (sem sugestões, o arquivo é []).",
    };
  }
  const dashes = findDashLines(text);
  if (dashes.length > 0) {
    return { ok: false, reason: `travessão no texto do post (linha ${dashes.join(", ")}) — tire antes de marcar.` };
  }
  const unapplied = findUnappliedSuggestions(text, clariceFiltered);
  if (unapplied.length > 0 && !motivo) {
    const list = unapplied.map((s) => `"${s.from}" -> "${s.to}"`).join("; ");
    return {
      ok: false,
      reason:
        `${unapplied.length} sugestão(ões) da Clarice não aplicada(s) no texto: ${list}. Aplique, ou declare a ` +
        `exceção (marca, identificador técnico) com --allow-unapplied "<motivo>" e avise o editor.`,
    };
  }
  const binding = checkClariceBinding(text, clariceFiltered, unapplied, input.clariceBinding);
  if (!binding.ok) return binding;
  const marker: FeedPostReviewMarker = {
    humanizador: true,
    clarice: true,
    em: now.toISOString(),
    hash: feedPostHash(text),
    clarice_sugestoes: clariceFiltered.length,
    clarice_input_hash: binding.inputHash,
  };
  if (unapplied.length > 0) {
    marker.clarice_nao_aplicadas = unapplied.map((s) => ({ from: s.from, to: s.to }));
    marker.clarice_motivo = motivo;
  }
  return { ok: true, marker };
}

/**
 * Confere que o filtrado é do texto enviado à Clarice e que o texto final é
 * esse texto com as sugestões aplicadas (menos as não aplicadas de propósito).
 * Um `[]` velho, ou o filtrado de outra versão, não passa: o sidecar guarda o
 * hash do texto de entrada, e o texto final tem de sair dele. @pure
 */
export function checkClariceBinding(
  text: string,
  filtered: ClariceSuggestion[],
  unapplied: ClariceSuggestion[],
  binding: ClariceBinding | undefined,
): { ok: true; inputHash: string } | { ok: false; reason: string } {
  const rerun =
    `grave o texto enviado à Clarice em ${FEED_POST_CLARICE_INPUT_REL} e rode ` +
    `'npx tsx scripts/clarice-filter.ts --suggestions {S}.json --out {S}-filtrado.json --source-text ${FEED_POST_CLARICE_INPUT_REL}'`;
  if (!binding || binding.inputText === null || !normalizeFeedPost(binding.inputText)) {
    return { ok: false, reason: `texto enviado à Clarice ausente (${FEED_POST_CLARICE_INPUT_REL}) — ${rerun}.` };
  }
  if (!isClariceSourceSidecar(binding.sidecar)) {
    return {
      ok: false,
      reason: `filtrado sem sidecar .source.json válido: não dá para saber de que texto ele veio — ${rerun}.`,
    };
  }
  if (binding.sidecar.filtered_sha256 !== rawSha256(binding.filteredRaw)) {
    return { ok: false, reason: `o filtrado foi trocado ou editado depois do clarice-filter.ts — ${rerun}.` };
  }
  const inputHash = clariceSourceHash(binding.inputText);
  if (binding.sidecar.source_sha256 !== inputHash) {
    return {
      ok: false,
      reason: `o filtrado é de outro texto, não de ${FEED_POST_CLARICE_INPUT_REL} (versão anterior?) — passe a Clarice de novo: ${rerun}.`,
    };
  }
  const toApply = filtered.filter((s) => !unapplied.includes(s));
  const final = normalizeFeedPost(text);
  if (
    final !== applyClariceSuggestions(binding.inputText, toApply, false) &&
    final !== applyClariceSuggestions(binding.inputText, toApply, true)
  ) {
    return {
      ok: false,
      reason:
        `o texto final não é o texto enviado à Clarice com as sugestões aplicadas: houve edição depois da ` +
        `Clarice (ou o texto enviado é de outra versão). Passe a Clarice na versão atual — ${rerun}.`,
    };
  }
  return { ok: true, inputHash };
}

function isFeedPostMarker(v: unknown): v is FeedPostReviewMarker {
  return isRevisaoMarker(v) && typeof (v as unknown as Record<string, unknown>).clarice_sugestoes === "number";
}

/**
 * Confere o texto que vai pro Passo 9 contra o marcador. `marker` é o JSON
 * lido do disco (`null` = arquivo ausente). @pure
 */
export function checkFeedPostReview(text: string | null, marker: unknown): FeedPostReviewCheck {
  if (text === null) {
    return {
      ok: false,
      reason: `${FEED_POST_REL} ausente — grave o texto final do post de feed nesse arquivo (Passo 8d).`,
    };
  }
  if (!normalizeFeedPost(text)) {
    return { ok: false, reason: `${FEED_POST_REL} vazio.` };
  }
  const dashes = findDashLines(text);
  if (dashes.length > 0) {
    return { ok: false, reason: `travessão no texto do post (linha ${dashes.join(", ")}).` };
  }
  if (marker === null || marker === undefined) {
    return {
      ok: false,
      reason: `sem marcador de revisão (${FEED_POST_REVIEW_REL}) — passe Humanizador e Clarice no texto e rode '${MARK_COMMAND}'.`,
    };
  }
  if (!isFeedPostMarker(marker)) {
    return {
      ok: false,
      reason: `marcador de revisão inválido (${JSON.stringify(marker)}) — regrave com '${MARK_COMMAND}'.`,
    };
  }
  if (marker.hash !== feedPostHash(text)) {
    return {
      ok: false,
      reason:
        `o texto do post mudou depois da revisão de ${marker.em} — passe Humanizador e Clarice de novo na versão ` +
        `nova e regrave o marcador ('${MARK_COMMAND}').`,
    };
  }
  return { ok: true, marker };
}
