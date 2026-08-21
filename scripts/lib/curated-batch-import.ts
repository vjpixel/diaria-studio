/**
 * Núcleo PURO do importador de lote curado pro canal `brevo_diaria` (#5841).
 *
 * O I/O (leitura do arquivo, MillionVerifier, escrita na Brevo, store, log)
 * vive em `scripts/import-curated-batch-brevo.ts`; aqui só ficam as decisões,
 * pra serem testáveis sem tocar rede, `data/` real, nem `process.env`.
 *
 * ## Contexto (#5841)
 *
 * O editor descadastrou manualmente 62 contatos em 11 e 13/07/2026 e quer dar
 * a eles uma chance no canal de reativação. Cruzando os snapshots de 17/06 e
 * 16/08, a janela contém 71 contatos (os 62 manuais + ~9 de churn orgânico do
 * período, indistinguíveis sem data por assinante). Desses 71, a checagem de
 * consentimento identificou 13 descadastros orgânicos, 6 dos quais estavam na
 * lista — daí os 65 finais de
 * `data/analysis/descadastrados-manuais-2607.json`.
 *
 * Não existia caminho no código pra esse lote: `refresh-pending-pool` (#5183)
 * só olha o segmento **Pending** da Beehiiv, e estes 65 estão descadastrados,
 * não pendentes.
 *
 * ## Por que script próprio, e não `--input` no sunset (desvio da spec)
 *
 * A #5841 sugeriu implementar como `--input` em `sunset-dead-subscribers.ts`.
 * Optei por script separado: o sunset seleciona ativos de um snapshot, aplica
 * guard de blast radius e **descadastra na Beehiiv**; este lote já está
 * descadastrado, não vem de snapshot, e exige verificação MV (regra #1297 —
 * são não-assinantes agora, risco de bounce real). Bolar três condicionais de
 * "pula esta etapa" no sunset deixaria os dois fluxos piores e mais fáceis de
 * quebrar — exatamente a classe de erro do #5843.
 *
 * O que É compartilhado fica compartilhado: `ingestContactToBrevo` +
 * `upsertIngested` (a dupla cuja separação causou o #5843),
 * `computeAvailableSlots`/`computeCurrentActiveCount` (cap da fila) e
 * `loadBrevoDiariaTarget`.
 */

export interface CuratedEntry {
  email: string;
  /** Métricas do lote — informativas, entram no log de auditoria. */
  received: number;
  opened: number;
  clicked: number;
}

/**
 * Motivos pelos quais um contato do lote NÃO foi importado.
 *
 * Os quatro primeiros são decisões (pré-flight ou pós-MV); os dois últimos são
 * FALHAS de execução. Estas últimas viviam só num contador `failed` sem tipo e
 * em linhas soltas de log — invisíveis pro `summarizeSkips`, justamente nos
 * modos de falha que mais precisam de triagem depois (rate limit, 5xx
 * transitório da Brevo). Ficam aqui pra que o relatório tenha uma fonte única.
 */
export type SkipReason =
  | "ja_no_store"
  | "sem_slot_na_fila"
  | "mv_rejected"
  | "mv_unknown"
  | "email_invalido"
  | "metrica_invalida"
  | "duplicado_no_arquivo"
  | "mv_falhou"
  | "ingestao_falhou";

export interface SkippedEntry {
  email: string;
  reason: SkipReason;
  detail?: string;
}

/** Normalização única — mesma semântica de `normalizeEmail` do store. */
function norm(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Pura — valida e normaliza o conteúdo bruto do arquivo de lote.
 *
 * Aceita o formato de `descadastrados-manuais-2607.json`: array de
 * `{ email, received, opened, clicked }`. Linha sem `email` utilizável entra
 * em `skipped` com motivo explícito em vez de derrubar a rodada inteira — um
 * lote curado à mão é justamente onde erro de digitação aparece.
 */
export function parseCuratedBatch(raw: unknown): { entries: CuratedEntry[]; skipped: SkippedEntry[] } {
  const entries: CuratedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(raw)) {
    return { entries, skipped: [{ email: "(arquivo)", reason: "email_invalido", detail: "o JSON não é um array" }] };
  }

  for (const item of raw) {
    const email = typeof item?.email === "string" ? norm(item.email) : "";
    if (!email || !email.includes("@") || /\s/.test(email)) {
      skipped.push({
        email: String(item?.email ?? "(vazio)"),
        reason: "email_invalido",
        detail: "campo email ausente ou malformado",
      });
      continue;
    }
    if (seen.has(email)) {
      skipped.push({ email, reason: "duplicado_no_arquivo" });
      continue;
    }
    // Métricas entram no log de auditoria, que é o ponto deste fluxo — um
    // `Number("abc")` viraria NaN (tipo `number` válido pro TS) e o
    // `JSON.stringify` do jsonl o gravaria como `null`, indistinguível de um
    // zero legítimo. O campo `email` logo acima já é validado; estas não eram.
    const received = Number(item?.received ?? 0);
    const opened = Number(item?.opened ?? 0);
    const clicked = Number(item?.clicked ?? 0);
    if (![received, opened, clicked].every(Number.isFinite)) {
      skipped.push({ email, reason: "metrica_invalida", detail: "received/opened/clicked não numérico" });
      continue;
    }
    seen.add(email);
    entries.push({ email, received, opened, clicked });
  }
  return { entries, skipped };
}

/**
 * Pura — aplica dedup contra o store e o cap da fila, NESSA ordem.
 *
 * Dedup primeiro: contato já tratado (`in_brevo`, `suppressed`,
 * `unsubscribed`, `promoted_beehiiv`) nunca deve consumir slot. Mesma
 * disciplina de `computeContactsToIngest` em `sync-pending-to-brevo.ts` — o
 * dedup vive no store, nunca na Beehiiv.
 *
 * `availableSlots` vem de `computeAvailableSlots(currentActiveCount, cap)`, o
 * mesmo par usado pelo backfill e pelo sunset: a fila é compartilhada e o cap
 * (`brevo_diaria.daily_send_cap`) vale pro canal inteiro, não por script.
 *
 * Quem sobra do cap NÃO é erro: permanece elegível pra próxima rodada, porque
 * nada foi gravado no store pra ele.
 */
export function selectCuratedCandidates(params: {
  entries: CuratedEntry[];
  storeEmails: Iterable<string>;
  availableSlots: number;
  /**
   * Ordena os elegíveis por cliques (desc) antes do corte. Quem já clicou
   * alguma vez é leitor real com pixel de abertura bloqueado (mesma lógica do
   * guard de `leitor-v1`), então num envio graduado é por eles que se começa.
   *
   * Existe porque o corte é POSICIONAL: sem ordenar, `--limit N` pega os N
   * primeiros na ordem do arquivo, que não tem relação com engajamento — o
   * lote de referência tem o 1º contato com clique só no índice 6.
   *
   * Default `false`: preserva a ordem do arquivo, que é a curadoria do editor.
   */
  prioritizeClicked?: boolean;
}): { selected: CuratedEntry[]; skipped: SkippedEntry[] } {
  const known = new Set<string>();
  for (const e of params.storeEmails) known.add(norm(e));

  const skipped: SkippedEntry[] = [];
  const eligible: CuratedEntry[] = [];
  for (const entry of params.entries) {
    if (known.has(entry.email)) {
      skipped.push({ email: entry.email, reason: "ja_no_store" });
      continue;
    }
    eligible.push(entry);
  }

  // Estável: entradas com o mesmo número de cliques mantêm a ordem do arquivo.
  const ordered = params.prioritizeClicked ? [...eligible].sort((a, b) => b.clicked - a.clicked) : eligible;

  const slots = Math.max(0, params.availableSlots);
  const selected = ordered.slice(0, slots);
  for (const over of ordered.slice(slots)) {
    skipped.push({ email: over.email, reason: "sem_slot_na_fila" });
  }
  return { selected, skipped };
}

/**
 * Pura — decide o destino de um contato a partir do bucket devolvido pela
 * MillionVerifier. `verified` (ok/catch_all) entra; `rejected`
 * (invalid/disposable) e `unknown` ficam de fora.
 *
 * `unknown` NÃO entra de propósito (mais conservador que o fluxo de cohort do
 * `verify-emails-mv.ts`, que só separa em arquivos): este lote são
 * não-assinantes que já saíram uma vez, então o custo de um bounce é maior que
 * o de deixar um endereço duvidoso de fora. Regra #1297.
 */
export type MvDecision = { ingest: true } | { ingest: false; reason: SkipReason };

export function decideFromMvBucket(bucket: "verified" | "rejected" | "unknown"): MvDecision {
  if (bucket === "verified") return { ingest: true };
  return { ingest: false, reason: bucket === "rejected" ? "mv_rejected" : "mv_unknown" };
}

/** Pura — agrupa os motivos de skip pra um resumo legível. */
export function summarizeSkips(skipped: SkippedEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}
