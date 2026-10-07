/**
 * editorial-domain-cuts.ts (#9787)
 *
 * Domínios que o editor mais RETIRA do que MANTÉM no gate 4 — lógica pura da
 * auditoria retroativa e do monitor contínuo que alimentam a blacklist
 * editorial (`editorial-blocklist.ts`) e a lista de mantidos
 * (`editorial-keep-list.ts`). I/O (leitura das edições, estado em `data/`,
 * registro de decisão) vive em `scripts/editorial-domain-cuts.ts`.
 *
 * Definições (corpo da #9787):
 * - **retirado**: a URL estava no rascunho que chegou ao gate 4 e não está no
 *   aprovado. Vale para destaques e pool (USE MELHOR, LANÇAMENTOS, RADAR...).
 * - **mantido**: a URL estava no rascunho e continua no aprovado — em
 *   qualquer seção (item trocado de seção conta como mantido) ou como link no
 *   corpo de um destaque. A comparação é por URL, nunca por posição.
 * - Agregação por domínio registrável EDITORIAL (`editorialDomain`, o mesmo
 *   critério de `validate-domain-diversity.ts`, #5735/#5813).
 * - **Candidato**: `retirado > mantido` E `retirado + mantido >=
 *   MIN_CUT_OCCURRENCES` (10 — decisão do editor, 06/10/2026) E o domínio não
 *   está decidido (blacklist, lista de mantidos ou decisão registrada).
 *
 * A decisão é SEMPRE do editor (trade-off editorial — critério 2 do
 * "Perguntar é exceção"); nada aqui bane um domínio sozinho.
 */
import { editorialDomain } from "./domain-diversity.ts";
import {
  destaqueUrlKey,
  extractNewsletterItems,
  isCorrectedUrl,
  linkTargets,
} from "./manual-edit-diff.ts";

/** Piso mínimo de ocorrências (retirado + mantido) — decisão do editor, 06/10/2026 (#9787). */
export const MIN_CUT_OCCURRENCES = 10;

export type ItemOutcome = "retirado" | "mantido";

export interface ItemOutcomeRecord {
  url: string;
  domain: string;
  /** Seção do item no rascunho que chegou ao gate (ex. `DESTAQUE 1`, `RADAR`). */
  section: string;
  outcome: ItemOutcome;
}

/**
 * Classifica cada item editorial do rascunho que chegou ao gate 4
 * (`baselineMd`) como retirado ou mantido no aprovado (`finalMd`). Itens da
 * intro, dos blocos da pipeline (É IA?, sorteio...) e de host não-editorial
 * (rodapé, link de casa) ficam de fora. Uma URL conta uma vez por edição.
 * URL corrigida para a mesma página (mesmo host + slug, `isCorrectedUrl`)
 * conta como mantida. @pure
 */
export function classifyEditionItems(baselineMd: string, finalMd: string): ItemOutcomeRecord[] {
  const finalTargets = [...linkTargets(finalMd)];
  const finalKeys = new Set(finalTargets.map(destaqueUrlKey));
  const seen = new Set<string>();
  const out: ItemOutcomeRecord[] = [];
  for (const it of extractNewsletterItems(baselineMd)) {
    if (it.section === "intro") continue;
    const key = destaqueUrlKey(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = editorialDomain(it.url);
    if (!domain) continue;
    const kept = finalKeys.has(key) || finalTargets.some((t) => isCorrectedUrl(it.url, t));
    out.push({ url: it.url, domain, section: it.section, outcome: kept ? "mantido" : "retirado" });
  }
  return out;
}

export interface DomainExample {
  edition: string;
  url: string;
  section: string;
  outcome: ItemOutcome;
}

export interface DomainTally {
  domain: string;
  retirado: number;
  mantido: number;
  total: number;
  /** Ocorrências, edição mais recente primeiro. */
  examples: DomainExample[];
}

/**
 * Agrega os itens classificados de várias edições por domínio. Ordem: mais
 * retirados primeiro, depois maior total, depois domínio (estável). @pure
 */
export function tallyByDomain(editions: Readonly<Record<string, readonly ItemOutcomeRecord[]>>): DomainTally[] {
  const byDomain = new Map<string, DomainTally>();
  for (const edition of Object.keys(editions).sort().reverse()) {
    for (const r of editions[edition]) {
      const t = byDomain.get(r.domain) ?? { domain: r.domain, retirado: 0, mantido: 0, total: 0, examples: [] };
      t[r.outcome]++;
      t.total++;
      t.examples.push({ edition, url: r.url, section: r.section, outcome: r.outcome });
      byDomain.set(r.domain, t);
    }
  }
  return [...byDomain.values()].sort(
    (a, b) => b.retirado - a.retirado || b.total - a.total || a.domain.localeCompare(b.domain),
  );
}

export type DomainDecision = "retirar" | "manter";

export interface CandidateOptions {
  minOccurrences?: number;
  /** true se o domínio já foi decidido (blacklist, lista de mantidos ou decisão registrada). */
  isDecided: (domain: string) => boolean;
}

/** Candidatos à pergunta: retirado > mantido, total ≥ piso, ainda não decididos. @pure */
export function selectCandidates(tallies: readonly DomainTally[], opts: CandidateOptions): DomainTally[] {
  const min = opts.minOccurrences ?? MIN_CUT_OCCURRENCES;
  return tallies.filter((t) => t.total >= min && t.retirado > t.mantido && !opts.isDecided(t.domain));
}

/** Match de domínio contra uma lista (igualdade ou subdomínio). @pure */
export function domainInList(domain: string, list: Iterable<string>): boolean {
  const d = domain.replace(/^www\./, "").toLowerCase();
  for (const x of list) {
    const e = x.replace(/^www\./, "").toLowerCase();
    if (d === e || d.endsWith("." + e)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Estado persistido (monitor contínuo) — evita recontar o histórico inteiro
// ---------------------------------------------------------------------------

export const STATE_VERSION = 1;

export interface EditionCutRecord {
  baseline_source: "snapshot" | "reconstructed";
  items: ItemOutcomeRecord[];
}

export interface DomainCutState {
  version: number;
  updated_at: string;
  /** Edições já contadas (fechadas — gate 4 aprovado), por AAMMDD. */
  editions: Record<string, EditionCutRecord>;
}

export function emptyState(now: string): DomainCutState {
  return { version: STATE_VERSION, updated_at: now, editions: {} };
}

/**
 * Lê o estado; JSON inválido ou versão diferente ⇒ estado vazio (recontagem
 * completa — barata e correta, nunca um estado parcial). @pure
 */
export function parseState(raw: string | null, now: string): DomainCutState {
  if (!raw) return emptyState(now);
  try {
    const j = JSON.parse(raw);
    if (j?.version !== STATE_VERSION || typeof j.editions !== "object" || j.editions === null) return emptyState(now);
    return j as DomainCutState;
  } catch {
    return emptyState(now);
  }
}

/** Itens por edição do estado, no formato de `tallyByDomain`. @pure */
export function stateItems(state: DomainCutState): Record<string, ItemOutcomeRecord[]> {
  const out: Record<string, ItemOutcomeRecord[]> = {};
  for (const [e, rec] of Object.entries(state.editions)) out[e] = rec.items;
  return out;
}

// ---------------------------------------------------------------------------
// Decisões do editor
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  domain: string;
  decision: DomainDecision;
  decided_at: string;
  /** Edição em cujo gate 4 a pergunta foi respondida. */
  edition?: string;
  retirado?: number;
  mantido?: number;
}

/**
 * `"chatprd.ai=retirar,foo.com=manter"` → decisões. Domínio é normalizado
 * (minúsculo, sem `www.`). Valor fora de retirar/manter ⇒ lança (nada é
 * gravado). Aceita `sim`→retirar e `nao`/`não`→manter, a mesma forma curta das
 * perguntas do gate. @pure
 */
export function parseDecisionAnswers(answers: string): Array<{ domain: string; decision: DomainDecision }> {
  const out: Array<{ domain: string; decision: DomainDecision }> = [];
  for (const part of answers.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z0-9.-]+)\s*=\s*(\S+)$/i);
    if (!m) throw new Error(`resposta mal formada: "${part}" (esperado dominio=retirar|manter)`);
    const v = m[2].toLowerCase();
    const decision: DomainDecision | null =
      v === "retirar" || v === "sim" ? "retirar" : v === "manter" || v === "nao" || v === "não" ? "manter" : null;
    if (!decision) throw new Error(`decisão inválida para ${m[1]}: "${m[2]}" (use retirar ou manter)`);
    out.push({ domain: m[1].toLowerCase().replace(/^www\./, ""), decision });
  }
  if (out.length === 0) throw new Error("--answers vazio");
  return out;
}

/** JSONL de decisões → registros válidos (linhas ruins são ignoradas). Última decisão por domínio vence. @pure */
export function parseDecisions(raw: string): DecisionRecord[] {
  const byDomain = new Map<string, DecisionRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.domain === "string" && (r.decision === "retirar" || r.decision === "manter")) byDomain.set(r.domain, r);
    } catch {
      /* linha corrompida: ignora */
    }
  }
  return [...byDomain.values()];
}

// ---------------------------------------------------------------------------
// Aplicação ao código (EDITORIAL_BLOCKLIST / EDITORIAL_KEEP_LIST)
// ---------------------------------------------------------------------------

/** `2026-10-07T…` → `261007` (formato de data das entradas existentes). @pure */
export function toAammdd(iso: string): string {
  const m = iso.match(/^\d{2}(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : iso;
}

/** Linha de entrada no padrão dos arquivos de lista: domínio + editor AAMMDD + motivo. @pure */
export function formatListEntry(d: DecisionRecord): string {
  const counts = d.retirado !== undefined && d.mantido !== undefined ? `, retirado ${d.retirado}× × mantido ${d.mantido}× no gate 4` : "";
  const where = d.edition ? ` (pergunta no gate 4 da edição ${d.edition}${counts})` : counts ? ` (${counts.slice(2)})` : "";
  const why =
    d.decision === "retirar"
      ? `decisão do editor via monitor de cortes por domínio (#9787)${where}`
      : `editor pediu explicitamente para manter (#9787)${where}`;
  return `  ${JSON.stringify(d.domain)}, // editor ${toAammdd(d.decided_at)} — ${why}`;
}

/**
 * Insere `entry` no literal `new Set<string>([ ... ])` da constante
 * `constName`, logo antes do `]);` que o fecha. Idempotente: se o domínio já
 * está no Set, devolve o texto intacto. Lança se a constante não for achada
 * (nunca escreve em lugar errado). @pure
 */
export function insertSetEntry(source: string, constName: string, domain: string, entry: string): string {
  const start = source.indexOf(`export const ${constName}`);
  if (start < 0) throw new Error(`constante ${constName} não encontrada`);
  const close = source.indexOf("\n]);", start);
  if (close < 0) throw new Error(`fim do Set de ${constName} ("]);") não encontrado`);
  const body = source.slice(start, close);
  if (body.includes(JSON.stringify(domain))) return source;
  return source.slice(0, close) + "\n" + entry + source.slice(close);
}

// ---------------------------------------------------------------------------
// Apresentação
// ---------------------------------------------------------------------------

const EXAMPLES_PER_DOMAIN = 3;

/**
 * Bloco de perguntas para o TOPO do resumo do gate 4 — uma por domínio
 * candidato, com os exemplos. String vazia sem candidato (o playbook omite a
 * seção). @pure
 */
export function formatGateQuestions(candidates: readonly DomainTally[]): string {
  if (candidates.length === 0) return "";
  const lines = [
    `🚫 DOMÍNIOS MAIS CORTADOS DO QUE MANTIDOS NO GATE 4 (#9787) — piso ${MIN_CUT_OCCURRENCES} ocorrências`,
  ];
  for (const c of candidates) {
    lines.push(
      `• ${c.domain}: retirado ${c.retirado}× × mantido ${c.mantido}× — entra na blacklist? responda "${c.domain}=retirar" ou "${c.domain}=manter"`,
    );
    for (const ex of c.examples.filter((e) => e.outcome === "retirado").slice(0, EXAMPLES_PER_DOMAIN)) {
      lines.push(`    ${ex.edition} ${ex.section}: ${ex.url}`);
    }
  }
  return lines.join("\n");
}

/** Tabela markdown da auditoria (todos os domínios com total ≥ piso, ou todos com `all`). @pure */
export function renderAuditTable(
  tallies: readonly DomainTally[],
  opts: { minOccurrences?: number; all?: boolean; status: (domain: string) => string },
): string {
  const min = opts.minOccurrences ?? MIN_CUT_OCCURRENCES;
  const rows = tallies.filter((t) => opts.all || t.total >= min);
  const out = [
    `| Domínio | Retirado | Mantido | Razão | Status | Exemplos retirados |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const t of rows) {
    const ratio = t.mantido === 0 ? "∞" : (t.retirado / t.mantido).toFixed(2);
    const ex = t.examples
      .filter((e) => e.outcome === "retirado")
      .slice(0, EXAMPLES_PER_DOMAIN)
      .map((e) => `${e.edition} ${e.section}: ${e.url}`)
      .join("<br>")
      .replace(/\|/g, "/");
    out.push(`| ${t.domain} | ${t.retirado} | ${t.mantido} | ${ratio} | ${opts.status(t.domain)} | ${ex || "—"} |`);
  }
  return out.join("\n");
}
