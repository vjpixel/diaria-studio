/**
 * raffle-numbers.ts (#2724)
 *
 * Registro determinístico do concurso "ache o erro intencional, ganhe um
 * número pro sorteio". Resolve duas lacunas do §0-replies (Stage 0):
 *
 *   1. Hoje o número é alocado 100% manualmente (lido nos e-mails enviados) —
 *      sem fonte de verdade, risco real de colisão entre edições/ciclos.
 *   2. O rascunho automático de resposta a assinante (Gmail draft) nunca
 *      inclui o número quando o assinante acerta o erro intencional — o
 *      editor precisa adicionar isso manualmente (caso real: Joshu acertou o
 *      erro da 260629 — papéis de Sol/Luna invertidos no "Por que isso
 *      importa" — e o rascunho saiu sem número).
 *
 * Arquivo de registro: `data/raffle-numbers.json` (gitignored — vive em
 * `data/`, blanket .gitignore). Schema: array de RaffleEntry, keyed por
 * `cycle` (mês do sorteio, formato "AAMM" derivado da edição — ex: edição
 * "260629" → ciclo "2606").
 *
 * Tudo aqui é função pura e testável sem depender de Gmail/LLM ao vivo — a
 * orquestração (ler thread, decidir qual edição a reply referencia, chamar
 * `create_draft`) fica no playbook `orchestrator-stage-0-preflight.md`
 * (§0-replies), análogo ao padrão de `filter-subscriber-replies.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";

export interface RaffleEntry {
  /** Ciclo do sorteio — "AAMM", derivado dos 4 primeiros dígitos da edição. */
  cycle: string;
  /** E-mail do assinante (lowercase, usado como chave de idempotência). */
  email: string;
  /** Nome/apelido pra exibição (best-effort, vem do header From). */
  nickname?: string;
  /** Número alocado pro sorteio (sequencial dentro do ciclo, começa em 1). */
  number: number;
  /** Edição (AAMMDD) em que o assinante acertou o erro intencional. */
  edition: string;
  /** ISO timestamp de quando o número foi alocado. */
  issued_at: string;
}

/** Subconjunto do record `_internal/intentional-error.json` (#3222) relevante pro matching. */
export interface IntentionalErrorForMatch {
  category?: string;
  location?: string;
  description?: string;
  correct_value?: string;
}

/**
 * Pure: parseia o JSON do registro. Tolerante a arquivo ausente/corrompido —
 * retorna [] (presume zero números emitidos ainda), nunca lança.
 */
export function parseRaffleRegistry(content: string): RaffleEntry[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RaffleEntry =>
        e &&
        typeof e.cycle === "string" &&
        typeof e.email === "string" &&
        typeof e.number === "number",
    );
  } catch {
    return [];
  }
}

/** Carrega o registro do disco. Path ausente → []. */
export function loadRaffleRegistry(path: string): RaffleEntry[] {
  if (!existsSync(path)) return [];
  try {
    return parseRaffleRegistry(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Subconjunto mínimo aceito por `saveRaffleRegistry` — `AllocateRaffleNumberResult`
 * satisfaz este shape estruturalmente, então o caller comum
 * `saveRaffleRegistry(path, allocateRaffleNumber(...))` funciona sem wrapper.
 */
export interface RaffleRegistrySave {
  entries: RaffleEntry[];
}

/**
 * Grava o registro completo (pretty JSON, determinístico). Usa `writeFileAtomic`
 * (temp file + fsync + rename com retry) em vez de write direto — `data/` é a
 * junction OneDrive (CLAUDE.md), sujeita a locks/races de sync; write direto
 * arriscaria deixar o JSON truncado/corrompido no meio de uma leitura
 * concorrente ou de um crash mid-write.
 *
 * **Assinatura (#2780):** recebe `{ entries }` (ex: o próprio
 * `AllocateRaffleNumberResult` retornado por `allocateRaffleNumber`), NÃO um
 * `RaffleEntry[]` cru. Antes aceitava o array diretamente — o risco real era
 * o caller persistir o array ORIGINALMENTE carregado (`loadRaffleRegistry`)
 * em vez de `result.entries` (o novo array com a entry recém-alocada),
 * perdendo a alocação silenciosamente. `allocateRaffleNumber` é pura e só
 * retorna um array NOVO quando `isNew=true` — com essa assinatura, o erro de
 * passar o array antigo vira erro de compilação (arrays não têm `.entries`),
 * em vez de bug silencioso descoberto só em produção. Ver §0-replies em
 * `.claude/agents/orchestrator-stage-0-preflight.md`.
 */
export function saveRaffleRegistry(path: string, result: RaffleRegistrySave): void {
  writeFileAtomic(path, `${JSON.stringify(result.entries, null, 2)}\n`);
}

/** Pure: deriva o ciclo do sorteio (AAMM) a partir da edição (AAMMDD). */
export function cycleFromEdition(edition: string): string {
  const m = String(edition).match(/^(\d{4})\d{2}$/);
  if (!m) throw new Error(`cycleFromEdition: edição inválida "${edition}" (esperado AAMMDD)`);
  return m[1];
}

const STOPWORDS = new Set([
  "que",
  "para",
  "com",
  "uma",
  "uns",
  "umas",
  "dos",
  "das",
  "este",
  "esta",
  "isso",
  "aquele",
  "aquela",
  "pelo",
  "pela",
  "mas",
  "por",
  "não",
  "nao",
  "foi",
  "era",
  "são",
  "sao",
  "tem",
  "tinha",
]);

/** Normaliza texto: lowercase + remove acentos + colapsa espaço. */
function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai palavras-chave "significativas": >3 chars fora da stopword list, OU
 * qualquer token puramente numérico (>=1 dígito) — cobre `correct_value`
 * numéricos curtos como "22" (categoria `numeric`) ou "V5" (não puramente
 * numérico, mas >3 chars já cobre versões tipo "v5w2"; tokens tipo "22" ou
 * "7" sozinhos são o caso que o filtro de 3+ chars descartaria).
 */
function significantWords(s: string): string[] {
  return normalizeText(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && (w.length > 3 || /^\d+$/.test(w)) && !STOPWORDS.has(w));
}

/**
 * Pure: heurística de match entre o corpo de uma reply de assinante e o
 * `intentional_error` declarado em `_internal/intentional-error.json` (#3222)
 * da edição referenciada.
 *
 * Critério (conservador — preferimos falso-negativo a falso-positivo, já que
 * o fallback "sem número" é seguro e o editor revisa o rascunho no gate):
 *   - se `correct_value` está declarado, a reply precisa mencionar pelo menos
 *     1 palavra-chave significativa dele (cobre tanto "errei X, correto é Y"
 *     quanto "Y é o certo");
 *   - E precisa haver overlap de pelo menos 1 palavra-chave significativa com
 *     `description` OU `location` (garante que a reply está falando do erro
 *     certo, não só citando um número que bate por acaso).
 *
 * Sem `correct_value` declarado: cai só no overlap de description/location
 * (sinal mais fraco, mas ainda exige pelo menos 1 termo em comum).
 */
export function matchesIntentionalError(
  replyBody: string,
  error: IntentionalErrorForMatch,
): boolean {
  if (!replyBody || !replyBody.trim()) return false;
  const bodyNorm = normalizeText(replyBody);

  const correctWords = error.correct_value ? significantWords(error.correct_value) : [];
  const descWords = [
    ...(error.description ? significantWords(error.description) : []),
    ...(error.location ? significantWords(error.location) : []),
  ];

  if (correctWords.length === 0 && descWords.length === 0) return false;

  const hasCorrectMatch =
    correctWords.length === 0 || correctWords.some((w) => bodyNorm.includes(w));
  const hasDescMatch = descWords.length === 0 || descWords.some((w) => bodyNorm.includes(w));

  // Exige sinal real de cada conjunto que existir — quando um conjunto está
  // vazio (ex: sem correct_value), o flag correspondente já é `true` por
  // default acima, então o `&&` efetivamente exige só o(s) conjunto(s) não-vazio(s).
  return hasCorrectMatch && hasDescMatch;
}

/** Pure: próximo número sequencial disponível no ciclo (max + 1, default 1). */
export function nextRaffleNumber(entries: RaffleEntry[], cycle: string): number {
  const inCycle = entries.filter((e) => e.cycle === cycle);
  if (inCycle.length === 0) return 1;
  return Math.max(...inCycle.map((e) => e.number)) + 1;
}

export interface AllocateRaffleNumberResult {
  entries: RaffleEntry[];
  entry: RaffleEntry;
  /** `false` quando o email já tinha número no ciclo (idempotência, #2724 item 4). */
  isNew: boolean;
}

/**
 * Pure: aloca (ou retorna o já existente) número de sorteio pra
 * `email` no `cycle`. Idempotente — se o email já tem número nesse ciclo
 * (de qualquer edição), retorna a entry existente sem realocar nem duplicar.
 * `nowIso` é injetável pra testes determinísticos.
 */
export function allocateRaffleNumber(
  entries: RaffleEntry[],
  params: { cycle: string; email: string; nickname?: string; edition: string },
  nowIso: string = new Date().toISOString(),
): AllocateRaffleNumberResult {
  const emailNorm = params.email.trim().toLowerCase();
  const existing = entries.find((e) => e.cycle === params.cycle && e.email === emailNorm);
  if (existing) {
    return { entries, entry: existing, isNew: false };
  }
  const entry: RaffleEntry = {
    cycle: params.cycle,
    email: emailNorm,
    nickname: params.nickname,
    number: nextRaffleNumber(entries, params.cycle),
    edition: params.edition,
    issued_at: nowIso,
  };
  return { entries: [...entries, entry], entry, isNew: true };
}
