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
 * `scripts/apoios-diff-alarm.ts` (a task diária PRETENDIDA pra rodar
 * automaticamente — `Diaria-Apoios-Diff-Alarm`, #4485 item 2; registro no
 * Task Scheduler + 1ª execução ao vivo ainda são ação PENDENTE do editor,
 * #4506 item 6 — ver CLAUDE.md) drenavam Gmail antes desta
 * unidade — então uma promessa que confirma pagamento SEM que ninguém
 * clique o botão manual nunca era promovida a contato, e a pessoa ficava
 * invisível ao sync pra sempre. Caso comprovado: Fabiana, 260802 (#4490) —
 * prometeu R$50 às 21:45, pagamento confirmado na API minutos depois, só
 * descoberta por investigação manual. Precedente: Ivan, 260722 (#3912),
 * mesma classe de problema.
 *
 * Fix: este módulo guarda as promessas NUM ARQUIVO PRÓPRIO
 * (`data/apoia-se/{campaign}/pending-promises.jsonl`) e
 * `reconcilePendingPromises` (`scripts/lib/apoio-reconciliation-cycle.ts`,
 * reexportada de `scripts/sync-apoio-nivel-beehiiv.ts` — movida pra lá no
 * self-review consolidado do PR #4503 junto com `runApoioReconciliationCycle`,
 * a orquestração inteira chamada tanto de `sync-apoio-nivel-beehiiv.ts`
 * quanto de `scripts/apoios-diff-alarm.ts` — a task diária real precisa da
 * MESMA reconciliação, não só a invocação manual) reconsulta `checkBacker`
 * (forceRefresh) pra cada uma A CADA RODADA — se confirmar pagamento no mês
 * corrente, promove a pessoa a contato (mesmo `importNewApoiadoresFromGmail`
 * já usado pro drain de confirmados) e remove a entrada do store (resolvida).
 * Promessa que ainda não converteu continua no store pra próxima rodada.
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
 * disciplina do resto do módulo apoia-se (`loadMonthCache`). Re-normaliza
 * `email` (lowercase/trim) na leitura (#4506 item 4) — `mergeNewPromises`
 * já normaliza no momento da fusão, mas uma entrada gravada por uma versão
 * anterior do código, ou editada manualmente no disco, podia carregar um
 * e-mail não-normalizado pra sempre; o invariante documentado no campo
 * `email` da interface (normalizado, lowercase/trim) precisa valer também
 * no boundary de LEITURA, não só na escrita via merge. */
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
        out.push({
          name: parsed.name,
          email: parsed.email.trim().toLowerCase(),
          value: parsed.value,
          receivedAtIso: parsed.receivedAtIso,
        });
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
 * Pure (#4506 item 1/item 3): funde DUAS listas de `PendingPromise` por
 * e-mail normalizado — pra um mesmo e-mail presente nas duas, a entrada com
 * `receivedAtIso` MAIS RECENTE vence de verdade (comparação de timestamp,
 * não ordem de iteração — antes do #4506, `mergeNewPromises` documentava
 * "mais recente vence" mas só implementava "o processado por último vence",
 * que coincidia com o timestamp real só enquanto `drained` sempre chegava
 * cronologicamente depois de `existing`). Entrada com e-mail vazio é
 * descartada (defensivo). Exportada porque também alimenta o merge
 * pré-write de `runApoioReconciliationCycle` (item 1 — estreita a janela de
 * lost-update entre 2 writers concorrentes de `pending-promises.jsonl`,
 * re-lendo o disco imediatamente antes do write final e fundindo por cima
 * em vez de sobrescrever cego).
 */
export function mergePendingPromisesPreferRecent(
  a: readonly PendingPromise[],
  b: readonly PendingPromise[],
): PendingPromise[] {
  const byEmail = new Map<string, PendingPromise>();
  const consider = (list: readonly PendingPromise[]) => {
    for (const p of list) {
      const email = p.email.trim().toLowerCase();
      if (!email) continue;
      const candidate: PendingPromise = { ...p, email };
      const current = byEmail.get(email);
      if (!current || new Date(candidate.receivedAtIso).getTime() >= new Date(current.receivedAtIso).getTime()) {
        byEmail.set(email, candidate);
      }
    }
  };
  consider(a);
  consider(b);
  return Array.from(byEmail.values());
}

/**
 * Pure: funde promessas recém-drenadas no store existente — dedup por e-mail
 * normalizado, mais recente por `receivedAtIso` vence (`mergePendingPromisesPreferRecent`,
 * #4506 item 3). Promessa com e-mail vazio é descartada (defensivo, nunca
 * deveria acontecer — `parsePromessaEmail` já exige e-mail não-vazio).
 */
export function mergeNewPromises(existing: PendingPromise[], drained: readonly DrainedPromessa[]): PendingPromise[] {
  const drainedAsPending: PendingPromise[] = [];
  for (const d of drained) {
    const email = d.email.trim().toLowerCase();
    if (!email) continue;
    drainedAsPending.push({ name: d.name, email, value: d.value, receivedAtIso: d.receivedAtIso });
  }
  return mergePendingPromisesPreferRecent(existing, drainedAsPending);
}
