/**
 * run-fact-checker.ts (#2455)
 *
 * Script de orquestração do fact-checker no Stage 4.
 * Lê `_internal/01-approved.json`, `02-reviewed.md` e `03-social.md`,
 * invoca o subagente `fact-checker`, e grava `_internal/fact-check.json`.
 *
 * Também expõe helpers puros (parseClaimsFromText, formatGateSummary) que
 * são testáveis unitariamente sem dependências externas.
 *
 * Uso:
 *   npx tsx scripts/run-fact-checker.ts --edition-dir data/editions/AAMMDD/
 *
 * Output: data/editions/AAMMDD/_internal/fact-check.json
 *   + stdout: seção formatada para o gate do Stage 4
 *
 * Exit codes:
 *   0 — sucesso (mesmo com attention_items > 0 — fact-check não bloqueia; a
 *       presença de claims é comunicada via stdout + fact-check.json)
 *   1 — erro de args ou arquivo não encontrado
 *
 * (#4361) Modo `--check-blocking` (opt-in, só combinado com `--input-json`):
 * gate-blocking estreito para claims `NOT_FOUND_IN_SOURCE` não-superlativas
 * (ver `getBlockingClaims`) — exit 2 quando presentes. Sem o flag, o
 * comportamento é idêntico ao de antes do #4361 (sempre exit 0 neste modo).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { sectionHeaderRegex, ALL_SECTION_NAMES_PATTERN } from "./lib/section-naming.ts";
import { runCli } from "./lib/cli-exit.ts";
import { fetchSourceText } from "./fetch-source-text.ts";

// ---------------------------------------------------------------------------
// Types — exportados para teste
// ---------------------------------------------------------------------------

// "headline" (#9383): o título escolhido do destaque como claim (sujeito +
// verbo + tempo verbal) conferido contra o corpo e a fonte. WARN-ONLY: nunca
// bloqueia (getBlockingClaims) nem recebe autofix (suggested_fix descartado em
// normalizeFactCheckResult) — reescrever título é decisão do editor.
export type ClaimType = "price" | "date" | "duration" | "number" | "superlative" | "headline";
export type Verdict =
  | "SUSTAINED"
  | "DIVERGENT"
  | "NOT_FOUND_IN_SOURCE"
  | "SOURCE_UNREACHABLE"
  | "INFERRED";

/**
 * (#8992) Slot do destaque a que o claim pertence — 1|2|3 (D1/D2/D3), ou
 * `"secondary"` para um claim extraído de um item FORA de D1-D3 (RADAR/USE
 * MELHOR/LANÇAMENTOS/etc). O prompt do fact-checker foca só em D1-D3, mas na
 * prática o agente às vezes verifica claims de itens secundários também —
 * antes disso caía num `destaque: 4` fabricado (rótulo "D4" bogus, edição
 * nunca tem 4º destaque, #3369). `"secondary"` é o rótulo honesto pro caso
 * real, em vez de inventar um destaque inexistente.
 */
export type ClaimDestaque = number | "secondary";

/** Rótulo de exibição pro gate — "D{n}" pros 3 destaques, "SEC" pra secondary (#8992). */
export function destaqueLabel(destaque: ClaimDestaque): string {
  return destaque === "secondary" ? "SEC" : `D${destaque}`;
}

export interface FactClaim {
  destaque: ClaimDestaque;
  claim_type: ClaimType;
  text: string;
  context: string;
  sources: Array<"newsletter" | "social">;
  verdict: Verdict;
  source_url?: string;
  source_text?: string;
  note?: string;
  /**
   * (#2598) Para claims DIVERGENT com correção determinística clara (nome/versão
   * de modelo, número, data): valor correto a substituir em `text`.
   * Só emitido pelo fact-checker quando há certeza do valor correto (extraído
   * verbatim da fonte). Ausente = sem correção automática disponível.
   * Ex: se text="GPT-4o" e fonte diz "GPT-5.4", suggested_fix="GPT-5.4".
   * NOT_FOUND_IN_SOURCE e superlativos NUNCA recebem suggested_fix.
   */
  suggested_fix?: string;
}

export interface FactCheckSummary {
  total: number;
  sustained: number;
  divergent: number;
  not_found_in_source: number;
  source_unreachable: number;
  inferred: number;
  /**
   * Itens que merecem atenção do editor:
   *   - DIVERGENT (qualquer tipo)
   *   - NOT_FOUND_IN_SOURCE (exceto superlativos, que entram na categoria abaixo)
   *   - superlatives que NÃO são SUSTAINED
   * Nota: NOT_FOUND_IN_SOURCE + superlative é contado UMA vez (na categoria de superlativo).
   */
  attention_items: number;
}

export interface FactCheckResult {
  edition: string;
  checked_at: string;
  claims: FactClaim[];
  summary: FactCheckSummary;
}

// ---------------------------------------------------------------------------
// Pure helpers — exportados para teste
// ---------------------------------------------------------------------------

/**
 * Extrai claims factuais verificáveis de um texto.
 * Estratégia heurística leve (complementa o LLM fact-checker):
 *  - Detecta padrões de preço/cifra (R$, US$, €, $) com valor
 *  - Detecta padrões de ineditismo ("primeira vez", "inédito", "pioneiro",
 *    "primeiro [a/do/no]")
 *  - Retorna array de { text, claim_type, context }
 *
 * Esta extração é conservadora: melhor falso-negativo (não extrair um claim
 * real) do que falso-positivo (extrair spam). O LLM no subagente faz a
 * varredura semântica completa; esta função serve para testes unitários e
 * como pré-filtro.
 */
export interface ExtractedClaim {
  text: string;
  claim_type: ClaimType;
  /** Linha ou frase onde o claim aparece */
  context: string;
}

/**
 * Schema do output do modo --dry-run.
 * Alinhado com FactCheckResult: usa os mesmos tipos de claim (ExtractedClaim),
 * mas omite veredictos — não há subagente no dry-run. (#2468 finding 1)
 */
export interface DryRunOutput {
  mode: "dry-run";
  edition: string;
  claims_heuristic: ExtractedClaim[];
  note: string;
}

// Regex para preços com valor numérico.
// R$, US$, $ e € são símbolos que não ocorrem mid-word — não precisam de \b.
// USD, BRL e EUR são siglas alfabéticas que podem ocorrer como substring
// (ex: "ESTUDANTE", "EMBRO") → âncora \b obrigatória para evitar FP.
const PRICE_RE = /(?:R\$|US\$|\$|€|\bUSD|\bBRL|\bEUR)\s*\d[\d.,]*/g;

// Regex para ineditismo/superlativos.
// Estratégia: capturar a palavra-âncora mais uma janela de contexto à frente
// (até 4 palavras) para cobrir variações como "primeira a lançar",
// "primeiro do Brasil", "inédito no mercado", etc.
// Alternativas ordenadas da mais específica para a mais geral.
const SUPERLATIVE_RE =
  /\b(?:primeira\s+vez|inédito[as]?|pionei(?:ro|ra)s?|(?:primeira|primeiro)\s+(?:a\s+\w+|do\s+\w+|no\s+\w+|na\s+\w+|de\s+\w+|entre\s+\w+)|primeira|primeiro)\b/gi;

/**
 * Extrai padrões de preço de um texto.
 * Retorna cada match com contexto (frase/linha em torno do match).
 */
export function extractPriceClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[0].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    // Contexto: substring de ±80 chars ao redor do match
    const start = Math.max(0, m.index! - 80);
    const end = Math.min(text.length, m.index! + raw.length + 80);
    const context = text.slice(start, end).replace(/\n+/g, " ").trim();
    claims.push({ text: raw, claim_type: "price", context });
  }
  return claims;
}

/**
 * Extrai padrões de ineditismo/superlativo de um texto.
 */
export function extractSuperlativeClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SUPERLATIVE_RE)) {
    const raw = m[0].trim().toLowerCase();
    if (seen.has(raw)) continue;
    seen.add(raw);
    const start = Math.max(0, m.index! - 80);
    const end = Math.min(text.length, m.index! + m[0].length + 80);
    const context = text.slice(start, end).replace(/\n+/g, " ").trim();
    claims.push({ text: m[0].trim(), claim_type: "superlative", context });
  }
  return claims;
}

/**
 * Extrai todos os claims detectáveis heuristicamente de um texto.
 * Combina preços + superlativos.
 */
export function parseClaimsFromText(text: string): ExtractedClaim[] {
  return [...extractPriceClaims(text), ...extractSuperlativeClaims(text)];
}

/**
 * (#8996) Formata a mensagem do gate quando o fact-check NÃO produziu
 * `fact-check.json` — dois motivos com peso editorial bem diferente, que a
 * mensagem genérica anterior ("⚠️ Fact-check indisponível: {motivo}") não
 * distinguia:
 *
 * - `networkError: true` — o dispatch do subagente `fact-checker` falhou por
 *   erro transitório de API/rede (ex: `API Error: Can't reach the API server
 *   (ENOTFOUND)`, achado ao vivo edição 260929) DEPOIS do orchestrator já ter
 *   tentado 1 retry automático (§4c.6 do playbook) — o fact-check
 *   simplesmente NUNCA RODOU. Mensagem mais forte, explícita sobre a causa,
 *   pra não ser confundida com "rodou e não achou nada preocupante".
 * - `networkError: false` (default) — pré-condição não satisfeita (arquivo
 *   ausente, Stage 2 incompleto) ou qualquer outro motivo não-rede: mantém o
 *   texto genérico de sempre (comportamento pré-#8996 preservado).
 *
 * Em ambos os casos o fact-check continua sendo SÓ INFORMATIVO — nunca
 * bloqueia o gate (decisão final é sempre do editor, mesmo padrão de
 * `{fact_check_block}` no restante do playbook).
 */
export function formatFactCheckUnavailableMessage(
  reason: string,
  opts: { networkError?: boolean } = {},
): string {
  if (opts.networkError) {
    return (
      `❌ Fact-check NÃO RODOU (erro de rede/API, #8996): ${reason} — nenhuma verificação de ` +
      `claims foi feita nesta edição, mesmo após retry automático. Verificar claims manualmente ` +
      `antes de aprovar o gate, ou re-rodar o fact-checker quando a rede estabilizar.`
    );
  }
  return `⚠️ Fact-check indisponível: ${reason}`;
}

/**
 * Formata a seção de fact-check para o gate do Stage 4.
 * Retorna string multi-linha para exibição no terminal.
 *
 * - Se não há claims de atenção: mostra resumo positivo
 * - Se há DIVERGENT: mostra em destaque com ❌
 * - Se há superlatives não-SUSTAINED: mostra com ⚠️
 * - Se há NOT_FOUND_IN_SOURCE: mostra com ⚠️
 */
export function formatGateSummary(result: FactCheckResult): string {
  const { claims, summary } = result;
  const lines: string[] = [];

  lines.push("━━━ FACT-CHECK (#2455) ━━━━━━━━━━━━━━━━━━");

  if (summary.total === 0) {
    lines.push("  ℹ️  Nenhum claim verificável extraído (newsletter + social).");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push(
    `  Total: ${summary.total} claims | ✅ ${summary.sustained} sustentados | ` +
      `${summary.divergent > 0 ? `❌ ${summary.divergent} divergentes` : `✅ 0 divergentes`} | ` +
      `${summary.not_found_in_source > 0 ? `⚠️  ${summary.not_found_in_source} não encontrados na fonte` : `✅ 0 não encontrados`}`,
  );

  if (summary.attention_items === 0) {
    lines.push("  ✅ Todos os claims verificados sem divergências.");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push("");

  // Divergentes primeiro (mais graves)
  const divergent = claims.filter((c) => c.verdict === "DIVERGENT");
  if (divergent.length > 0) {
    lines.push("  ❌ DIVERGÊNCIAS (verificar antes de publicar):");
    for (const c of divergent) {
      lines.push(`    ${destaqueLabel(c.destaque)} [${c.claim_type}] "${c.text}"`);
      if (c.note) lines.push(`       → ${c.note}`);
      if (c.source_text) lines.push(`       Fonte: "${c.source_text}"`);
    }
    lines.push("");
  }

  // Superlativos sem suporte
  const unsupportedSuperlatives = claims.filter(
    (c) => c.claim_type === "superlative" && c.verdict !== "SUSTAINED",
  );
  if (unsupportedSuperlatives.length > 0) {
    lines.push("  ⚠️  INEDITISMO/SUPERLATIVOS sem confirmação na fonte:");
    for (const c of unsupportedSuperlatives) {
      lines.push(`    ${destaqueLabel(c.destaque)} "${c.text}" [${c.verdict}]`);
      if (c.note) lines.push(`       → ${c.note}`);
    }
    lines.push("");
  }

  // Título × corpo/fonte (#9383) — DIVERGENT já listado acima.
  const headlineIssues = claims.filter(
    (c) => c.claim_type === "headline" && c.verdict !== "SUSTAINED" && c.verdict !== "DIVERGENT",
  );
  if (headlineIssues.length > 0) {
    lines.push("  ⚠️  TÍTULO não sustentado pelo corpo/fonte (sujeito, verbo ou tempo verbal):");
    for (const c of headlineIssues) {
      lines.push(`    ${destaqueLabel(c.destaque)} "${c.text}" [${c.verdict}]`);
      if (c.note) lines.push(`       → ${c.note}`);
    }
    lines.push("");
  }

  // Not found (excluindo superlativos e títulos já listados)
  const notFound = claims.filter(
    (c) =>
      c.verdict === "NOT_FOUND_IN_SOURCE" &&
      c.claim_type !== "superlative" &&
      c.claim_type !== "headline",
  );
  if (notFound.length > 0) {
    lines.push("  ⚠️  Claims não encontrados na fonte primária:");
    for (const c of notFound) {
      lines.push(`    ${destaqueLabel(c.destaque)} [${c.claim_type}] "${c.text}"`);
      if (c.note) lines.push(`       → ${c.note}`);
    }
    lines.push("");
  }

  // Guard contra ghost-header (#2468 finding 5):
  // Se attention_items > 0 mas nenhuma seção renderizou (inconsistência interna),
  // emitir um aviso genérico em vez de deixar o header "vazio".
  const sectionsRendered =
    divergent.length > 0 ||
    unsupportedSuperlatives.length > 0 ||
    headlineIssues.length > 0 ||
    notFound.length > 0;
  if (!sectionsRendered) {
    lines.push(`  ⚠️  ${summary.attention_items} item(ns) de atenção (ver claims completos em fact-check.json).`);
    lines.push("");
  }

  lines.push(
    "  Decisão final é do editor. Aprovação no gate confirma revisão dos itens acima.",
  );
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

/**
 * Computa o summary.attention_items a partir de uma lista de claims.
 * Exportado para uso em testes e no script de output.
 */
export function computeAttentionItems(claims: FactClaim[]): number {
  return claims.filter(
    (c) =>
      c.verdict === "DIVERGENT" ||
      (c.claim_type === "superlative" && c.verdict !== "SUSTAINED") ||
      // #9383: título não sustentado (INFERRED incluso — título "inferido"
      // é exatamente o caso de tempo verbal/sujeito trocado).
      (c.claim_type === "headline" && c.verdict !== "SUSTAINED") ||
      (c.verdict === "NOT_FOUND_IN_SOURCE" && c.claim_type !== "superlative"),
  ).length;
}

/**
 * (#4361) Claims que devem BLOQUEAR o gate do Stage 4 — não apenas informar.
 *
 * Escopo deliberadamente estreito (evitar over-broadening, #4361 briefing):
 *   - Apenas `verdict === "NOT_FOUND_IN_SOURCE"` — a fonte primária foi
 *     verificada (fetch teve sucesso) e o claim simplesmente não está lá.
 *   - Exclui `claim_type === "superlative"` — ineditismo/pioneirismo é mais
 *     subjetivo (mesmo racional que já separa isso em `computeAttentionItems`)
 *     e já tem sua própria seção informativa no gate; manter warn-only evita
 *     travar edições legítimas por causa de uma alegação de tom.
 *   - Exclui `DIVERGENT`, `SUSTAINED`, `INFERRED`, `SOURCE_UNREACHABLE` — o
 *     autofix (#2598/§4c.6b) já corrige DIVERGENT com `suggested_fix`
 *     determinístico antes do gate; `SOURCE_UNREACHABLE` é falha de rede, não
 *     confirmação de ausência.
 *
 * Caso real (#4361, edição 260731): "é a segunda vez que a xAI recorre à
 * Justiça..." — claim não-superlativo marcado NOT_FOUND_IN_SOURCE sobreviveu
 * ao Stage 4 porque o fact-check era só informativo ali.
 */
export function getBlockingClaims(
  claims: FactClaim[],
  opts: { newsletterMd?: string | null } = {},
): FactClaim[] {
  // #9383: `headline` também fica de fora — título é warn-only (presente
  // histórico em manchete é convenção legítima; o editor decide no gate).
  // #9868: estimativa de tempo de leitura também fica de fora (ver
  // `isReadingTimeEstimate`). #9985: `newsletterMd` (o `02-reviewed.md` real)
  // deixa a isenção conferir o marcador no MD em vez de depender só do
  // `context` que o agente escreveu.
  const useMelhorItems = opts.newsletterMd ? parseUseMelhorReadingTimeItems(opts.newsletterMd) : undefined;
  return claims.filter(
    (c) =>
      c.verdict === "NOT_FOUND_IN_SOURCE" &&
      c.claim_type !== "superlative" &&
      c.claim_type !== "headline" &&
      !isReadingTimeEstimate(c, useMelhorItems),
  );
}

/**
 * (#9868) Texto que é só um tempo de leitura — "(12 min)", "12 min",
 * "— 15 min", "(~12 min)", "12 minutos de leitura". Ancorado nas duas pontas.
 *
 * (#9914) Atenção: isso SOZINHO não distingue tempo de leitura de duração
 * factual — o contrato do fact-checker põe em `text` o trecho MÍNIMO
 * ("12 minutos") e a frase em `context`, então "o modelo gera o vídeo em 12
 * minutos" chega como `text: "12 minutos"` e casa aqui. Por isso
 * `isReadingTimeEstimate` também exige o marcador no `context`.
 */
const READING_TIME_TEXT_RE =
  /^[\s(—–~-]*\d{1,3}\s*(?:min(?:utos?)?\.?)(?:\s+de\s+leitura)?[\s)]*$/i;

/**
 * (#9914) Marcador de tempo de leitura no FIM do `context` — a forma que o
 * pipeline emite no USE MELHOR (`renderUseMelhorSection` appenda a estimativa
 * ao fim da descrição; formatos aceitos espelham `USE_MELHOR_TEMPO_RE`, #2447):
 * "(12 min)", "(~12 min)", "— 12 min", "~12 min", com "de leitura" opcional.
 * Ancorado no fim (tolera pontuação/markdown residual): "(12 min)" no meio de
 * uma frase, ou "em 12 minutos" sem parênteses/travessão/til, não casa.
 * Grupo 1 = o número de minutos, comparado com o do `text`.
 */
const READING_TIME_CONTEXT_TAIL_RE =
  /(?:\(\s*~?\s*(\d{1,3})\s*min(?:utos?)?\.?(?:\s+de\s+leitura)?\s*\)|[–—]\s*~?\s*(\d{1,3})\s*min(?:utos?)?\.?(?:\s+de\s+leitura)?|~\s*(\d{1,3})\s*min(?:utos?)?\.?(?:\s+de\s+leitura)?)[\s.*_)]*$/i;

/**
 * (#9868) Claim `duration` que é a estimativa de tempo de leitura do pipeline
 * (o "(X min)" exigido pelo invariante `use-melhor-tempo`, #2447) e não uma
 * afirmação da fonte. Página sem tempo de leitura (caso MachineLearningMastery,
 * edição 261008) fazia o fact-checker marcar o "(12 min)" como
 * NOT_FOUND_IN_SOURCE — e `--check-blocking` saía com exit 2: remover o tempo
 * reprova o invariante, mantê-lo reprova o gate. Nunca bloqueia; continua
 * aparecendo em `attention_items`/no resumo do gate (warn-only).
 *
 * (#9914) Exige as TRÊS condições — qualquer uma ausente, a regra normal vale
 * (fail-closed: na dúvida, bloqueia):
 *   1. `text` é só um tempo em minutos (`READING_TIME_TEXT_RE`);
 *   2. item `secondary` — o tempo de leitura só existe no USE MELHOR; um
 *      D1-D3 nunca o carrega, então "12 minutos" num destaque é factual;
 *   3. `context` termina no marcador de tempo de leitura com o MESMO número
 *      do `text` (`READING_TIME_CONTEXT_TAIL_RE`). "o modelo gera o vídeo em
 *      12 minutos" (fonte diz 40) não termina em "(12 min)" → bloqueia.
 * (#9900) `secondary` sozinho já não isentava (cobre LANÇAMENTOS/RADAR
 * inteiros: "grátis por 30 dias" com fonte dizendo 7 tem que bloquear).
 *
 * (#9985) A condição 3 dependia de o agente copiar a descrição ATÉ O FIM no
 * `context` — formato que o prompt não pede (os exemplos do fact-checker.md
 * truncam com "..."). Com `useMelhorItems` (itens do USE MELHOR do
 * `02-reviewed.md` real, via `parseUseMelhorReadingTimeItems`), a condição 3
 * também vale quando o `context` — truncado ou não — identifica um item do
 * USE MELHOR cujo texto termina no marcador com o MESMO número. O `context`
 * continua obrigatório (é o que amarra a claim ao item; vazio → bloqueia).
 */
export function isReadingTimeEstimate(c: FactClaim, useMelhorItems?: UseMelhorReadingTimeItem[]): boolean {
  if (c.claim_type !== "duration") return false;
  if (c.destaque !== "secondary") return false;
  if (!READING_TIME_TEXT_RE.test(c.text)) return false;
  const textMinutes = Number(/\d{1,3}/.exec(c.text)?.[0]);
  const tail = typeof c.context === "string" ? READING_TIME_CONTEXT_TAIL_RE.exec(c.context) : null;
  if (tail) {
    const ctxMinutes = tail[1] ?? tail[2] ?? tail[3];
    if (ctxMinutes !== undefined && Number(ctxMinutes) === textMinutes) return true;
  }
  if (!useMelhorItems || typeof c.context !== "string") return false;
  const fragments = contextFragments(c.context);
  const fragmentChars = fragments.reduce((n, f) => n + f.length, 0);
  // Contexto curto demais não identifica item nenhum ("12 min", "guia") —
  // fail-closed.
  if (fragmentChars < MIN_CONTEXT_MATCH_CHARS) return false;
  return useMelhorItems.some(
    (item) => item.minutes === textMinutes && fragments.every((f) => item.normalized.includes(f)),
  );
}

/** (#9985) Mínimo de caracteres (normalizados) do `context` pra casar um item do USE MELHOR. */
const MIN_CONTEXT_MATCH_CHARS = 12;

/** (#9985) Item do USE MELHOR cujo texto termina num marcador de tempo de leitura. */
export interface UseMelhorReadingTimeItem {
  /** Minutos do marcador final ("(12 min)" → 12). */
  minutes: number;
  /** Título + descrição sem markdown, minúsculo, espaços colapsados. */
  normalized: string;
}

const USE_MELHOR_HEADER_RE = sectionHeaderRegex(String.raw`USE\s+MELHOR`, { capture: "none", flags: "u" });
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, { capture: "none", flags: "u" });
const ITEM_LINK_START_RE = /^\s*\*{0,2}\[[^\]]+\]\(/;

/** Normaliza texto de MD/`context` pra comparação: tira link/ênfase, minúsculo, espaços colapsados. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[“”"]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Fragmentos do `context` separados por reticências ("..." ou "…"), normalizados. */
function contextFragments(context: string): string[] {
  return context
    .split(/\.{3,}|…/)
    .map(normalizeForMatch)
    .filter((f) => f.length > 0);
}

/**
 * (#9985) Extrai do MD da newsletter (`02-reviewed.md`) os itens da seção USE
 * MELHOR que terminam num marcador de tempo de leitura — mesmo marcador e
 * mesmas fronteiras de seção que o lint `use-melhor-tempo` (#2396): a seção
 * começa no header USE MELHOR e acaba em `---` ou no próximo header de seção.
 * Cada item começa numa linha de link (`**[Título](url)**`) e agrega as linhas
 * seguintes (formato canônico inline ou legado de 2 linhas).
 */
export function parseUseMelhorReadingTimeItems(md: string): UseMelhorReadingTimeItem[] {
  const items: string[][] = [];
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!inSection) {
      if (USE_MELHOR_HEADER_RE.test(t)) inSection = true;
      continue;
    }
    if (/^-{3,}$/.test(t) || ANY_SECTION_HEADER_RE.test(t)) {
      if (USE_MELHOR_HEADER_RE.test(t)) continue;
      inSection = false;
      continue;
    }
    if (!t) continue;
    if (ITEM_LINK_START_RE.test(t) || items.length === 0) items.push([t]);
    else items[items.length - 1].push(t);
  }
  const out: UseMelhorReadingTimeItem[] = [];
  for (const lines of items) {
    const joined = lines.join(" ");
    const tail = READING_TIME_CONTEXT_TAIL_RE.exec(joined);
    const minutes = tail ? (tail[1] ?? tail[2] ?? tail[3]) : undefined;
    if (minutes === undefined) continue;
    out.push({ minutes: Number(minutes), normalized: normalizeForMatch(joined) });
  }
  return out;
}

/**
 * Valida e normaliza o output do subagente fact-checker.
 * Garante que o JSON tem o schema esperado antes de gravar.
 * Retorna o resultado normalizado ou lança erro se inválido.
 */
export function normalizeFactCheckResult(raw: unknown, edition: string): FactCheckResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("fact-checker output não é um objeto JSON");
  }
  const obj = raw as Record<string, unknown>;

  const claims: FactClaim[] = Array.isArray(obj.claims)
    ? (obj.claims as FactClaim[])
        .filter(
          // destaque: validar que é um número finito, OU o literal "secondary"
          // (#8992 — claim de item fora de D1-D3) (#2468 finding 2 + code-review).
          // O check antigo (`c.destaque` truthy) descartava destaque=0 — bug original.
          // `!= null` corrige isso mas aceitaria "" / NaN de um subagente que alucina
          // (renderizam como "D"/"DNaN" no gate). FactClaim.destaque é `ClaimDestaque`
          // (`number | "secondary"`), então exigir number finito OU o literal exato
          // "secondary" é o fix no nível certo do boundary unknown→FactClaim — qualquer
          // outra string (ex: "1", alucinação) continua sendo filtrada.
          (c) =>
            c &&
            typeof c === "object" &&
            c.text &&
            c.verdict &&
            (c.destaque === "secondary" ||
              (typeof c.destaque === "number" && Number.isFinite(c.destaque))),
        )
        .map((c) => ({
          ...c,
          // Coerce suggested_fix: o LLM pode emitir número (ex: 24.99) em vez de string.
          // Conversão implícita produziria "24.99" quando o correto é "R$ 24,99" — bug
          // silencioso. Dropamos valores não-string; o autofix trata ausência como skipped_no_fix.
          // #9383: título nunca recebe autofix — descarta suggested_fix de headline.
          suggested_fix:
            c.claim_type !== "headline" && typeof c.suggested_fix === "string"
              ? c.suggested_fix
              : undefined,
          // Guard: fact-checker pode omitir sources (#2628 gap 2) → default [] para
          // evitar TypeError em entry.sources.includes() downstream.
          sources: Array.isArray(c.sources) ? c.sources : [],
        }))
    : [];

  const summary: FactCheckSummary = {
    total: claims.length,
    sustained: claims.filter((c) => c.verdict === "SUSTAINED").length,
    divergent: claims.filter((c) => c.verdict === "DIVERGENT").length,
    not_found_in_source: claims.filter((c) => c.verdict === "NOT_FOUND_IN_SOURCE").length,
    source_unreachable: claims.filter((c) => c.verdict === "SOURCE_UNREACHABLE").length,
    inferred: claims.filter((c) => c.verdict === "INFERRED").length,
    attention_items: computeAttentionItems(claims),
  };

  return {
    edition,
    checked_at: typeof obj.checked_at === "string" ? obj.checked_at : new Date().toISOString(),
    claims,
    summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface PrefetchedSource {
  destaque: number;
  url: string;
  /** Path do texto bruto; ausente se o download falhou. */
  path?: string;
  /** Motivo da falha (ex.: "HTTP 451: fonte bloqueada; tente equivalente"). */
  error?: string;
}

/**
 * (#8782) Lê `manifest.json` já existente em `{dir}`, se houver.
 * Retorna `null` se ausente ou ilegível (JSON malformado, shape inesperado) —
 * fail-soft: tratado como "sem cache" pelo caller, nunca lança.
 */
export function readExistingManifest(dir: string): ManifestEntry[] | null {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw as ManifestEntry[];
  } catch {
    return null;
  }
}

/**
 * (#8782) Compara as URLs REGISTRADAS no manifest (última vez que as fontes
 * foram baixadas) contra as URLs ATUAIS dos destaques (extraídas de
 * `01-approved.json` pelo caller). Retorna `true` só quando o cache é
 * seguro de reusar: mesmo número de destaques, mesma URL por posição (`d{N}`),
 * e toda entrada com `status: "ok"` (uma entrada `blocked`/`error` nunca é
 * reusada — o próximo run deve tentar de novo, já que a falha pode ter sido
 * transitória).
 *
 * Puro — não toca o filesystem. Espelha o estilo de `checkInputHtmlFreshness`
 * em `substitute-image-urls.ts` (#2316): função de decisão isolada e testável,
 * caller decide o que fazer com o resultado.
 *
 * Caso real que motivou (#8782): um `ajustar` no gate trocou D1/D2/D3 por
 * completo (promoção de itens do RADAR) sem que `fact-check-sources/`
 * refletisse os destaques novos — comparar URL a URL antes de decidir reusar
 * o cache é o que impede servir ao fact-checker o texto bruto da história
 * ERRADA.
 */
export function manifestMatchesCurrentUrls(
  manifest: ManifestEntry[] | null,
  currentUrls: Array<string | undefined>,
): boolean {
  if (!manifest) return false;
  // Ignora slots vazios (edição de 2 destaques) na comparação de tamanho.
  const expected = currentUrls.filter((u): u is string => Boolean(u));
  if (manifest.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const entry = manifest[i];
    if (!entry || entry.destaque !== i + 1) return false;
    if (entry.url !== expected[i]) return false;
    if (entry.status !== "ok") return false;
  }
  return true;
}

/**
 * (#8595, #8782) Pré-baixa o texto BRUTO das URLs dos destaques para
 * `{internalDir}/fact-check-sources/d{N}.txt`, para o fact-checker ler via Read
 * (o WebFetch resume a página e omite detalhes → falso NOT_FOUND).
 * Fail-soft: falha de um destaque vira `error`, nunca aborta.
 *
 * (#8782) Antes de refazer o download, compara as URLs atuais contra o
 * `manifest.json` já existente (`manifestMatchesCurrentUrls`) — se baterem
 * URL a URL e todo status anterior for `"ok"`, REUSA o cache (nenhuma rede,
 * nenhum `rm`). Qualquer divergência (URL trocada, contagem diferente,
 * manifest ausente/ilegível, ou entrada não-`ok`) força refetch completo —
 * nunca serve ao fact-checker texto bruto de uma URL que não é mais a do
 * destaque atual.
 */
/**
 * (#9102) URL de cada destaque (máx. 3) em `01-approved.json`, por posição.
 * Fallback pra `article.url` quando o wrapper não traz `url` no topo — o
 * wrapper montado à mão na substituição de §4d.1b pode esquecer o campo.
 */
export function highlightSourceUrls(approved: unknown): Array<string | undefined> {
  const highlights =
    (approved as { highlights?: Array<{ url?: string; article?: { url?: string } }> } | null)?.highlights ?? [];
  return Array.from({ length: Math.min(highlights.length, 3) }, (_, i) => highlights[i]?.url ?? highlights[i]?.article?.url);
}

/**
 * (#8782, #9102) Critério ÚNICO de reuso do cache de `fact-check-sources/`:
 * manifest bate URL a URL com os destaques atuais, todo status `ok` e todo
 * `d{N}.txt` presente. Usado por `prefetchHighlightSources` e por
 * `refresh-destaque-sources.ts` — nunca duplicar.
 */
export function isHighlightSourcesCacheFresh(approved: unknown, internalDir: string): boolean {
  const dir = join(internalDir, "fact-check-sources");
  const manifest = readExistingManifest(dir);
  return (
    manifestMatchesCurrentUrls(manifest, highlightSourceUrls(approved)) &&
    // Cinto e suspensório: manifest pode bater mas o .txt ter sido apagado
    // manualmente (ou nunca escrito) — nesse caso não há o que reusar.
    manifest!.every((entry) => existsSync(join(dir, `d${entry.destaque}.txt`)))
  );
}

export async function prefetchHighlightSources(
  approved: unknown,
  internalDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PrefetchedSource[]> {
  const dir = join(internalDir, "fact-check-sources");
  const out: PrefetchedSource[] = [];
  const manifest: ManifestEntry[] = [];
  mkdirSync(dir, { recursive: true });

  const currentUrls = highlightSourceUrls(approved);
  if (isHighlightSourcesCacheFresh(approved, internalDir)) {
    const existingManifest = readExistingManifest(dir);
    // Cache fresco: reusa os d{N}.txt já em disco, sem tocar rede nem rm.
    return existingManifest!.map((entry) => ({
      destaque: entry.destaque,
      url: entry.url,
      path: join(dir, `d${entry.destaque}.txt`),
    }));
  }

  // Cache ausente/divergente/com falha anterior: invalida tudo e refaz do zero.
  // Nunca mistura entradas velhas com novas — o agente nunca deve ler fonte velha.
  for (const n of [1, 2, 3]) rmSync(join(dir, `d${n}.txt`), { force: true });
  rmSync(join(dir, "manifest.json"), { force: true });
  for (let i = 0; i < currentUrls.length; i++) {
    const url = currentUrls[i];
    if (!url) continue;
    const fetched_at = new Date().toISOString();
    const r = await fetchSourceText(url, fetchImpl);
    if (r.ok) {
      const path = join(dir, `d${i + 1}.txt`);
      writeFileSync(path, r.text, "utf8");
      out.push({ destaque: i + 1, url, path });
      manifest.push({ destaque: i + 1, url, status: "ok", erro: null, bytes: r.bytes, fetched_at });
    } else {
      out.push({ destaque: i + 1, url, error: r.message });
      manifest.push({ destaque: i + 1, url, status: r.kind === "blocked" ? "blocked" : "error", erro: r.message, bytes: 0, fetched_at });
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return out;
}

export interface ManifestEntry {
  destaque: number;
  url: string;
  status: "ok" | "blocked" | "error";
  erro: string | null;
  bytes: number;
  fetched_at: string;
}

function extractEditionId(editionDir: string): string {
  // Extrai AAMMDD do path (ex: data/editions/260622/ → 260622)
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

async function main(): Promise<number | void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));

  // (#8996) Modo utilitário — formata a mensagem "indisponível" do gate de
  // forma consistente, distinguindo erro de rede (retry já esgotado) do
  // motivo genérico. Não requer --edition-dir (não faz fact-check nenhum,
  // só formata texto). Sempre exit 0 — é puro output de string.
  if (flags.has("unavailable-message")) {
    if (!args.reason) {
      console.error("Uso: run-fact-checker.ts --unavailable-message --reason <texto> [--network-error]");
      return 1;
    }
    console.log(formatFactCheckUnavailableMessage(args.reason, { networkError: flags.has("network-error") }));
    return;
  }

  if (!args["edition-dir"]) {
    console.error("Uso: run-fact-checker.ts --edition-dir data/editions/AAMMDD/");
    return 1;
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);

  const newsletterPath = join(editionDir, "02-reviewed.md");
  const socialPath = join(editionDir, "03-social.md");
  const approvedPath = join(editionDir, "_internal", "01-approved.json");
  const internalDir = join(editionDir, "_internal");
  const outPath = join(internalDir, "fact-check.json");

  // Verificar pré-condições
  for (const [label, p] of [
    ["02-reviewed.md", newsletterPath],
    ["03-social.md", socialPath],
    ["_internal/01-approved.json", approvedPath],
  ] as const) {
    if (!existsSync(p)) {
      console.error(`[run-fact-checker] ERRO: ${label} não encontrado em ${p}`);
      console.error(
        "  Fact-checker requer Stage 2 completado. Verifique se 02-reviewed.md e 03-social.md existem.",
      );
      return 1;
    }
  }

  mkdirSync(internalDir, { recursive: true });

  // Modo dry-run: só extrai claims heurísticos sem invocar o subagente.
  // Output schema: DryRunOutput (alinhado com ExtractedClaim — #2468 finding 1).
  if (flags.has("dry-run")) {
    const newsletter = readFileSync(newsletterPath, "utf8");
    const social = readFileSync(socialPath, "utf8");
    const allText = `${newsletter}\n${social}`;
    const extracted = parseClaimsFromText(allText);

    const dryRunOutput: DryRunOutput = {
      mode: "dry-run",
      edition,
      claims_heuristic: extracted,
      note: "Dry-run: só extração heurística. Omite verificação por URL (sem subagente).",
    };
    console.log(JSON.stringify(dryRunOutput, null, 2));
    return;
  }

  // Modo normal: chamar subagente fact-checker via Agent tool
  // Na pipeline real, o orchestrator despacha este script como passo do Stage 4;
  // o próprio orchestrator (top-level) invoca o subagente fact-checker via Agent.
  // Este script: (1) valida pré-condições, (2) grava o out_path passado ao agente,
  // e (3) formata o gate summary. O invoke do agente é responsabilidade do orchestrator.
  //
  // Para teste de integração isolado, o script aceita --input-json com o resultado
  // já computado pelo subagente (útil em CI sem acesso ao Agent tool).

  if (args["input-json"]) {
    // Modo integração: recebe JSON do subagente via arquivo
    const inputPath = resolve(process.cwd(), args["input-json"]);
    if (!existsSync(inputPath)) {
      console.error(`[run-fact-checker] --input-json não encontrado: ${inputPath}`);
      return 1;
    }
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const result = normalizeFactCheckResult(raw, edition);

    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(formatGateSummary(result));

    // Exit code 0 sempre neste modo, SALVO --check-blocking (#2468 finding 4 + code-review):
    // A presença de attention_items em geral NÃO é um erro — o fact-check é
    // assistido, não gate-blocking (orchestrator-stage-4.md §4c.6). A distinção
    // "sem claims" vs "rodou ok com claims" é comunicada via stdout
    // (formatGateSummary) + o campo `summary.attention_items` em fact-check.json,
    // ambos lidos pelo orchestrator. Um exit não-zero aqui SEM --check-blocking
    // seria interpretado pelo orchestrator como "Fact-check indisponível" (só
    // exit 0/1 são tratados no modo default), ESCONDENDO as divergências do
    // editor — exatamente o oposto do desejado.
    //
    // #4361: --check-blocking é um MODO SEPARADO e opt-in, só usado pelo
    // orchestrator na 2ª chamada de §4c.6 (depois de já ter formatado o gate
    // summary acima). Sem o flag, o comportamento de exit code é IDÊNTICO ao
    // de antes do #4361 — nenhum caller existente é afetado.
    if (flags.has("check-blocking")) {
      // #9985: confere o marcador de tempo de leitura contra o MD real.
      const blocking = getBlockingClaims(result.claims, { newsletterMd: readFileSync(newsletterPath, "utf8") });
      if (blocking.length > 0) {
        console.error(
          `\n[run-fact-checker] GATE-BLOCKING (#4361): ${blocking.length} claim(s) NOT_FOUND_IN_SOURCE sem suporte na fonte primária:`,
        );
        for (const c of blocking) {
          console.error(`  ${destaqueLabel(c.destaque)} [${c.claim_type}] "${c.text}"`);
          if (c.note) console.error(`     → ${c.note}`);
        }
        console.error(
          "  Ação: reescrever/remover o claim em 02-reviewed.md e/ou 03-social.md (ou localizar suporte " +
          "adicional na fonte), depois re-rodar o fact-checker + este check antes de aprovar o gate.",
        );
        return 2;
      }
    }
    return;
  }

  // Modo padrão: imprimir instrução para o orchestrator.
  // Exit 0 sempre — este modo só valida pré-condições, não executa fact-checking.
  console.log(
    `[run-fact-checker] Pré-condições validadas para edição ${edition}.`,
  );
  console.log(`  Newsletter: ${newsletterPath}`);
  console.log(`  Social:     ${socialPath}`);
  console.log(`  Approved:   ${approvedPath}`);
  console.log(`  Output:     ${outPath}`);
  try {
    const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as unknown;
    const sources = await prefetchHighlightSources(approved, internalDir);
    console.log("  Fontes brutas pré-baixadas (#8595 — ler via Read antes de WebFetch):");
    for (const s of sources) {
      console.log(
        s.path ? `    D${s.destaque}: ${s.path}` : `    D${s.destaque}: (indisponível) ${s.error} — ${s.url}`,
      );
    }
  } catch (e) {
    console.log(`  Fontes brutas: pré-download falhou (${(e as Error).message}); usar WebFetch.`);
  }
  console.log("");
  console.log(
    "  O orchestrator deve despachar o subagente fact-checker com os parâmetros acima.",
  );
  console.log(
    "  Após o subagente gravar fact-check.json, rodar com --input-json para formatar o gate summary.",
  );
  // Exit 0 — pré-condições ok, nenhum claim verificado ainda
}

if (isMainModule(import.meta.url)) {
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main, { onError: (e) => console.error("[run-fact-checker] ERRO:", e) });
}
