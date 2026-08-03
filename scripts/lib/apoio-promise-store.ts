/**
 * apoio-promise-store.ts (#4490 causa 4)
 *
 * Store dedicado de PROMESSAS de apoio (apoia.se) ainda não confirmadas como
 * pagamento — separado de `contacts.jsonl` de propósito.
 *
 * `scripts/lib/apoia-se-gmail-drain.ts` + `scripts/studio-ui/studio-apoios.ts`
 * já sabem drenar promessas e criar um contato PENDENTE a partir delas
 * (`importPendingApoiadoresFromGmail`, #3912) — mas isso só roda dentro de
 * `refreshApoiosData`, usado pelo botão "Atualizar status" do painel Apoios
 * (ação MANUAL do editor). Nem `scripts/sync-apoio-nivel-beehiiv.ts` nem
 * `scripts/apoios-diff-alarm.ts` (a task diária AGENDADA de verdade —
 * `Diaria-Apoios-Diff-Alarm`, #4485 item 2) drenavam Gmail antes desta
 * unidade — então uma promessa que confirma pagamento SEM que ninguém
 * clique o botão manual nunca era promovida a contato, e a pessoa ficava
 * invisível ao sync pra sempre. Caso comprovado: Fabiana, 260802 (#4490) —
 * prometeu R$50 às 21:45, pagamento confirmado na API minutos depois, só
 * descoberta por investigação manual. Precedente: Ivan, 260722 (#3912),
 * mesma classe de problema.
 *
 * Fix: este módulo guarda as promessas NUM ARQUIVO PRÓPRIO
 * (`data/apoia-se/{campaign}/pending-promises.jsonl`) e
 * `reconcilePendingPromises` (exportado de
 * `scripts/sync-apoio-nivel-beehiiv.ts`, chamado tanto de lá quanto de
 * `scripts/apoios-diff-alarm.ts` desde o self-review finding 1 do PR #4503 —
 * a task diária real precisa da MESMA reconciliação, não só a invocação
 * manual) reconsulta `checkBacker` (forceRefresh) pra cada uma A CADA RODADA
 * — se confirmar pagamento no mês corrente, promove a pessoa a contato
 * (mesmo `importNewApoiadoresFromGmail` já usado pro drain de confirmados) e
 * remove a entrada do store (resolvida). Promessa que ainda não converteu
 * continua no store pra próxima rodada.
 *
 * Deliberadamente PARALELO ao mecanismo de `importPendingApoiadoresFromGmail`
 * (não o substitui) — aquele cria um contato PENDENTE imediato pro editor ver
 * no painel; este garante que o SYNC AUTOMATIZADO também nunca perde uma
 * promessa que converteu, mesmo que ninguém tenha clicado o botão manual.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import type { DrainedPromessa } from "./apoia-se-gmail-drain.ts";

export interface PendingPromise {
  name: string;
  /** Normalizado (lowercase/trim). */
  email: string;
  value: number;
  /** ISO — momento em que a promessa foi recebida (envelope Gmail). */
  receivedAtIso: string;
}

export function pendingPromisesPath(rootDir: string, campaign: string): string {
  return resolve(rootDir, "data", "apoia-se", campaign, "pending-promises.jsonl");
}

/** Fail-soft: arquivo ausente ou linha corrompida nunca lança — mesma
 * disciplina do resto do módulo apoia-se (`loadMonthCache`). */
export function loadPendingPromises(path: string): PendingPromise[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: PendingPromise[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<PendingPromise>;
      if (
        typeof parsed.name === "string" &&
        typeof parsed.email === "string" &&
        typeof parsed.value === "number" &&
        typeof parsed.receivedAtIso === "string"
      ) {
        out.push({ name: parsed.name, email: parsed.email, value: parsed.value, receivedAtIso: parsed.receivedAtIso });
      }
    } catch {
      // linha corrompida — ignora, mesma disciplina fail-soft do resto do módulo.
    }
  }
  return out;
}

export function savePendingPromises(path: string, promises: PendingPromise[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = promises.length === 0 ? "" : promises.map((p) => JSON.stringify(p)).join("\n") + "\n";
  writeFileAtomic(path, body);
}

/**
 * Pure: funde promessas recém-drenadas no store existente — dedup por e-mail
 * normalizado (uma promessa repetida do mesmo e-mail nunca duplica; a mais
 * recente vence). Promessa com e-mail vazio é descartada (defensivo, nunca
 * deveria acontecer — `parsePromessaEmail` já exige e-mail não-vazio).
 */
export function mergeNewPromises(existing: PendingPromise[], drained: readonly DrainedPromessa[]): PendingPromise[] {
  const byEmail = new Map<string, PendingPromise>();
  for (const p of existing) {
    const email = p.email.trim().toLowerCase();
    if (email) byEmail.set(email, { ...p, email });
  }
  for (const d of drained) {
    const email = d.email.trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, { name: d.name, email, value: d.value, receivedAtIso: d.receivedAtIso });
  }
  return Array.from(byEmail.values());
}
