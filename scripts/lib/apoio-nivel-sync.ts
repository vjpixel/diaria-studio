/**
 * scripts/lib/apoio-nivel-sync.ts (#11225)
 *
 * Lógica de nível de apoio, sem I/O de plataforma, compartilhada pelos syncs
 * de `apoio_nivel` (`sync-apoio-nivel-kit.ts`, `sync-apoio-nivel-brevo.ts`),
 * pelo KV dos Artigos (`sync-artigos-apoio-kv.ts`) e pelo alarme diário
 * (`apoios-diff-alarm.ts`). Morava em `scripts/sync-apoio-nivel-beehiiv.ts`,
 * aposentado no #11225 junto com a escrita na Beehiiv (o git guarda a parte de
 * API, inclusive a armadilha do `PATCH {tags}` que responde 200 e não grava).
 *
 * ## Carência de 1 mês (#4436, decisão do editor 260801)
 *
 * `computeRewardGroup` sozinho parte do valor pago NO MÊS CORRENTE, que zera
 * no dia 1º e só volta conforme a cobrança de cada apoiador entra. Um `--push`
 * no dia 1º removeria todos os apoiadores até a cobrança de cada um entrar.
 * Por isso o nível DESEJADO é o MAIOR entre a faixa paga no mês corrente e a
 * do mês ANTERIOR: cancelamento real só remove depois de 2 meses sem
 * pagamento. Não há janela por dia do mês: `BackerStatus` não guarda data de
 * pagamento, só "pagou no mês X". Ver `computeDesiredApoioLevels`.
 *
 * ## Guard de blast radius (#4436, limiar 30%)
 *
 * Se as remoções calculadas passarem de 30% de quem tem `apoio_nivel` setado
 * hoje, o `--push` inteiro é recusado. `shouldBlockRemovals` só cobre dado
 * parcial, nunca "removeu demais por outro motivo" (bug de cálculo, apoia.se
 * respondendo `nao_apoia` em massa). `--force-blast-radius` é o escape hatch.
 * Ver `evaluateBlastRadiusGuard`.
 *
 * ## Fail-closed em leitura parcial
 *
 * Com erro de `buildApoiosData`, contato `sem_dados` ou snapshot do mês
 * anterior ausente (#7195), o `--push` recusa gerar remoções; adições e trocas
 * prosseguem (atraso de benefício é menos grave que remoção indevida).
 * `--allow-partial` é o escape hatch. Contato `sem_dados` nunca gera ação: o
 * nível dele é desconhecido, não "sem apoio".
 *
 * Os tipos de entrada (`ApoioLevelContact`, `ApoioMonthSnapshot`) são
 * estruturais porque `scripts/lib/**` não importa de `scripts/studio-ui/**`
 * (`test/lib-boundary.test.ts`, #5899); `ContactWithStatus` e `MonthSnapshot`
 * do painel satisfazem os dois.
 */
import { type ApoioNivel, isApoioNivel } from "./shared/apoio-nivel-types.ts";
import { previousMonthKey } from "./apoio-month-key.ts";
import { findEmailMatchCandidates, type EmailMatchCandidate } from "./apoio-email-heuristics.ts";
import { computeRewardGroup } from "./reward-tier-thresholds.ts";

export { previousMonthKey };

const DEFAULT_LOG_PREFIX = "[apoio-nivel]";

/** Limiar do guard de blast radius — decisão do editor, #4436 comentário
 * 260801 ("sim, limiar 30%"). */
const BLAST_RADIUS_THRESHOLD = 0.3;

/** Forma mínima de um contato já resolvido pelo painel Apoios. */
export interface ApoioLevelContact {
  id: string;
  name: string;
  emails: string[];
  status: { label: string; monthlyValue?: number };
}

/** Forma mínima do snapshot de um mês passado (`readPastMonthSnapshots`). */
export interface ApoioMonthSnapshot {
  month: string;
  statuses: Record<string, { isPaidThisMonth?: boolean; thisMonthPaidValue?: number } | undefined>;
}

/** Ordinal de faixa — usado só por `maxLevel` pra decidir a carência (#4436).
 * `null` (sem apoio) é sempre o mínimo. */
const LEVEL_RANK: Record<ApoioNivel, number> = { amigo: 1, apoiador: 2, mantenedor: 3, patrono: 4 };

function normalizeEmailList(emails: string[] | undefined | null): string[] {
  if (!Array.isArray(emails)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = (raw ?? "").trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

// ── carência de 1 mês (#4436) — puro ────────────────────────────────────

/** Pure: maior das duas faixas (ou `null` se ambas `null`). Usado pra
 * combinar o nível do mês corrente com o do mês anterior (carência). */
export function maxLevel(a: ApoioNivel | null, b: ApoioNivel | null): ApoioNivel | null {
  const rankA = a ? LEVEL_RANK[a] : 0;
  const rankB = b ? LEVEL_RANK[b] : 0;
  return rankA >= rankB ? a : b;
}

/**
 * Pure: nível pago por um contato (qualquer um dos seus e-mails) num
 * snapshot de mês específico — `null` se o snapshot não existe (mês sem
 * cache, ex: primeiro mês de operação) ou se nenhum e-mail pagou naquele
 * mês. Mesma regra de "qualquer e-mail que bate" de `deriveContactStatus`.
 */
export function levelFromSnapshot(emails: readonly string[], snapshot: ApoioMonthSnapshot | undefined): ApoioNivel | null {
  if (!snapshot) return null;
  for (const email of emails) {
    const s = snapshot.statuses[email];
    if (s?.isPaidThisMonth) {
      return computeRewardGroup(s.thisMonthPaidValue);
    }
  }
  return null;
}

// ── estado DESEJADO (puro, de ContactWithStatus[] + histórico) ─────────────

export interface DesiredApoioLevel {
  contactId: string;
  contactName: string;
  /** E-mails normalizados (lowercase/trim, dedup) do contato. */
  emails: string[];
  /** Nível desejado, ou `null` se o contato não deve ter valor nenhum (não
   * apoiou nem no mês corrente nem no anterior — carência esgotada). */
  level: ApoioNivel | null;
  /** `true` quando `status.label === "sem_dados"` — nível DESCONHECIDO (falha
   * transiente de checagem), nunca tratado como "sem apoio". */
  unresolved: boolean;
}

/**
 * Pure: computa o nível de recompensa desejado por contato a partir do
 * `ContactWithStatus[]` já resolvido por `buildApoiosData`, aplicando a
 * carência de 1 mês (#4436): nível desejado = MAIOR faixa entre o mês
 * corrente e o mês anterior (`pastSnapshots`, saída de
 * `readPastMonthSnapshots` — zero chamada de rede nova). Reusa
 * `computeRewardGroup` (mesma fonte única de limiar usada pelo painel Apoios
 * e por `build-apoiador-allowlist.ts`) — SEM reimplementar a lógica de
 * faixas. Contatos "sem_dados" são marcados `unresolved: true` com `level:
 * null` (desconhecido, não "sem apoio") — `diffApoioTags` nunca gera ação
 * pra eles, e a carência não se aplica (nível do mês corrente é
 * desconhecido, não "não pagou").
 */
export function computeDesiredApoioLevels(
  contacts: readonly ApoioLevelContact[],
  pastSnapshots: readonly ApoioMonthSnapshot[],
  currentMonth: string,
): DesiredApoioLevel[] {
  const previousSnapshot = pastSnapshots.find((s) => s.month === previousMonthKey(currentMonth));

  return contacts.map((c) => {
    const unresolved = c.status.label === "sem_dados";
    const emails = normalizeEmailList(c.emails);

    if (unresolved) {
      return { contactId: c.id, contactName: c.name, emails, level: null, unresolved: true };
    }

    const currentLevel = c.status.label === "apoiando" ? computeRewardGroup(c.status.monthlyValue) : null;
    const previousLevel = levelFromSnapshot(emails, previousSnapshot);

    return {
      contactId: c.id,
      contactName: c.name,
      emails,
      level: maxLevel(currentLevel, previousLevel),
      unresolved: false,
    };
  });
}

// ── estado ATUAL (forma comum a qualquer plataforma) ───────────────────────

/** Assinante na plataforma de destino, já lido pelo sync de cada canal. */
export interface ApoioSubscriberSnapshot {
  /** Id do assinante na plataforma. No Kit, o id numérico como string. */
  subscriptionId: string;
  /** E-mail normalizado (lowercase/trim). */
  email: string;
  /** Valor atual do custom field `apoio_nivel` — `""` quando ausente/vazio. */
  apoioNivel: string;
}

// ── diff (puro — desejado × atual) ──────────────────────────────────────

export interface ApoioTagDiffEntry {
  contactId: string;
  contactName: string;
  email: string;
  subscriptionId: string;
  /** `null` = sem valor atual (custom field vazio/ausente). */
  fromLevel: ApoioNivel | null;
  /** `null` = remover (contato não apoia mais). */
  toLevel: ApoioNivel | null;
}

/** #4490 causa 3: apoiador que não casou por e-mail exato, com candidatos
 * heurísticos (0 ou mais) pra confirmação manual do editor — NUNCA aplicados
 * sozinhos, ver `scripts/lib/apoio-email-heuristics.ts`. */
export interface UnmatchedApoiador extends DesiredApoioLevel {
  candidates: EmailMatchCandidate[];
}

export interface ApoioTagDiffResult {
  /** Adições + trocas de faixa — sempre seguro aplicar (nunca gated pelo
   * guard de dados parciais). */
  toApply: ApoioTagDiffEntry[];
  /** Remoções (contato parou de apoiar) — sujeito ao guard fail-closed de
   * dados parciais (`shouldBlockRemovals`) e ao guard de blast radius
   * (`evaluateBlastRadiusGuard`). */
  toRemove: ApoioTagDiffEntry[];
  /** Já convergido — nenhuma ação necessária (idempotência). */
  unchanged: ApoioTagDiffEntry[];
  /** Contatos "sem_dados" — nenhuma ação gerada, nível desconhecido. */
  skippedUnresolved: DesiredApoioLevel[];
  /** Apoiadores (ou não-apoiadores) que NÃO casaram por e-mail exato contra
   * nenhum assinante da plataforma — não é necessariamente "não assina", pode
   * assinar com outro endereço (#4490 causa 3, ver `candidates`). */
  notSubscribed: UnmatchedApoiador[];
}

/**
 * Pure: diffa o estado desejado (por contato) contra o estado atual (por
 * assinante da plataforma). Casamento por e-mail segue a MESMA regra de
 * `deriveContactStatus` (#4273): bate se QUALQUER e-mail do contato bater com
 * uma subscription. Um contato pode casar com MÚLTIPLAS subscriptions
 * (múltiplos e-mails assinados) — cada uma recebe uma entrada de
 * diff própria, pra que a recompensa alcance a pessoa independente de qual
 * e-mail ela usa pra ler a newsletter.
 *
 * Quando NENHUM e-mail conhecido bate exato (#4490 causa 3),
 * `findEmailMatchCandidates` gera candidatos heurísticos (local-part
 * normalizado, nome no local-part, domínio próprio, variação/typo) pra
 * apresentar ao editor — nunca decide um vínculo sozinho.
 */
export function diffApoioTags(
  desired: DesiredApoioLevel[],
  current: ApoioSubscriberSnapshot[],
): ApoioTagDiffResult {
  const currentByEmail = new Map<string, ApoioSubscriberSnapshot>();
  for (const s of current) currentByEmail.set(s.email, s);

  const toApply: ApoioTagDiffEntry[] = [];
  const toRemove: ApoioTagDiffEntry[] = [];
  const unchanged: ApoioTagDiffEntry[] = [];
  const skippedUnresolved: DesiredApoioLevel[] = [];
  const notSubscribed: UnmatchedApoiador[] = [];

  for (const d of desired) {
    if (d.unresolved) {
      skippedUnresolved.push(d);
      continue;
    }

    const matches = d.emails
      .map((e) => currentByEmail.get(e))
      .filter((s): s is ApoioSubscriberSnapshot => s !== undefined);

    if (matches.length === 0) {
      const candidates = findEmailMatchCandidates(d.contactName, d.emails, current);
      notSubscribed.push({ ...d, candidates });
      continue;
    }

    for (const sub of matches) {
      const fromLevel = sub.apoioNivel && isApoioNivel(sub.apoioNivel) ? sub.apoioNivel : null;
      const toLevel = d.level;
      const entry: ApoioTagDiffEntry = {
        contactId: d.contactId,
        contactName: d.contactName,
        email: sub.email,
        subscriptionId: sub.subscriptionId,
        fromLevel,
        toLevel,
      };

      if (fromLevel === toLevel) {
        unchanged.push(entry);
      } else if (toLevel !== null) {
        toApply.push(entry);
      } else {
        toRemove.push(entry);
      }
    }
  }

  return { toApply, toRemove, unchanged, skippedUnresolved, notSubscribed };
}

/**
 * Pure: `true` se o snapshot do mês ANTERIOR está ausente do conjunto lido
 * (#7195). É a pré-condição da carência de 1 mês: `computeDesiredApoioLevels`
 * calcula `max(mês corrente, mês anterior)`, então sem o snapshot de M-1 o
 * `previousLevel` de TODO mundo vira `null` e a carência some — quem pagou
 * no mês passado e não pagou neste é removido na hora, sem nenhuma margem.
 *
 * `readPastMonthSnapshots` é fail-soft por desenho (diretório inexistente →
 * `[]`; arquivo de um mês corrompido → aquele mês é pulado, os outros
 * seguem), e o `catch` do caller só avisa quando a leitura INTEIRA lança.
 * Um único mês faltando passa em silêncio — e é justamente o mês que a
 * carência usa. Daí este guard ser separado: a ausência é indistinguível,
 * pelo resultado, de "ninguém pagou no mês passado".
 */
export function isPreviousMonthSnapshotMissing(
  pastSnapshots: readonly ApoioMonthSnapshot[],
  currentMonth: string,
): boolean {
  return !pastSnapshots.some((s) => s.month === previousMonthKey(currentMonth));
}

/**
 * Pure: decide se remoções devem ser bloqueadas (fail-closed) — `true` se
 * `buildApoiosData` reportou erro de nível topo, OU há qualquer contato
 * "sem_dados" nesta rodada, OU o snapshot do mês anterior está ausente
 * (#7195 — sem ele não há carência, ver `isPreviousMonthSnapshotMissing`),
 * a menos que `allowPartial` (escape hatch `--allow-partial`) esteja
 * explicitamente ligado.
 *
 * Os três motivos compartilham a mesma forma: o dado de entrada está
 * incompleto de um jeito que empurra o cálculo pro lado da REMOÇÃO — nunca
 * pro lado de conceder nível a mais. Por isso fail-closed, e por isso o
 * escape hatch é o mesmo.
 */
export function shouldBlockRemovals(
  dataError: string | null,
  diff: Pick<ApoioTagDiffResult, "skippedUnresolved">,
  allowPartial: boolean,
  opts: { previousMonthSnapshotMissing?: boolean } = {},
): boolean {
  if (allowPartial) return false;
  return (
    dataError !== null ||
    diff.skippedUnresolved.length > 0 ||
    opts.previousMonthSnapshotMissing === true
  );
}

// ── guard de blast radius (#4436) — puro ────────────────────────────────

export interface BlastRadiusGuardResult {
  /** `true` = o `--push` inteiro deve ser recusado (nem adições nem
   * remoções são aplicadas). */
  blocked: boolean;
  removalCount: number;
  /** Quantos assinantes têm `apoio_nivel` setado HOJE na plataforma (antes do
   * push) — denominador do limiar. */
  currentWithLevelCount: number;
  /** `removalCount / currentWithLevelCount` — `0` quando o denominador é 0
   * (não há ninguém com nível hoje, logo não há base pra "% removido"). */
  ratio: number;
}

/**
 * Pure: recusa o `--push` inteiro quando as remoções calculadas excedem
 * `BLAST_RADIUS_THRESHOLD` (30%, decisão do editor #4436) de quem TEM
 * `apoio_nivel` setado hoje na plataforma — independente do motivo (bug de
 * cálculo, virada de mês sem a carência ter pego o caso, apoia.se
 * respondendo `nao_apoia` em massa por instabilidade). Mais amplo que
 * `shouldBlockRemovals` (que só cobre `error`/`sem_dados`): aqui o critério é
 * puramente de MAGNITUDE, não de origem do dado. "Passar de" é estrito —
 * exatamente no limiar (`ratio === threshold`) NÃO bloqueia.
 * `force` (`--force-blast-radius`) é o escape hatch explícito.
 */
export function evaluateBlastRadiusGuard(
  removalCount: number,
  current: readonly ApoioSubscriberSnapshot[],
  force: boolean,
): BlastRadiusGuardResult {
  const currentWithLevelCount = current.filter((s) => s.apoioNivel !== "").length;
  const ratio = currentWithLevelCount > 0 ? removalCount / currentWithLevelCount : 0;
  const blocked = !force && ratio > BLAST_RADIUS_THRESHOLD;
  return { blocked, removalCount, currentWithLevelCount, ratio };
}

// ── logging do diff (dry-run e --push) ──────────────────────────────────

/** Relatório do diff, comum ao dry-run e ao `--push` de `sync-apoio-nivel-kit.ts`. */
export function logDiff(diff: ApoioTagDiffResult, removalsBlocked: boolean, logPrefix = DEFAULT_LOG_PREFIX): void {
  const log = (msg: string) => process.stderr.write(`${logPrefix} ${msg}\n`);

  log(`${diff.toApply.length} adição(ões)/troca(s) de nível:`);
  for (const e of diff.toApply) {
    log(`  + ${e.email} (${e.contactName}): ${e.fromLevel ?? "(nenhum)"} → ${e.toLevel}`);
  }

  if (removalsBlocked && diff.toRemove.length > 0) {
    log(
      `${diff.toRemove.length} remoção(ões) CALCULADA(S) mas BLOQUEADA(S) (dados parciais — ` +
        "ver aviso acima; use --allow-partial pra forçar):",
    );
  } else {
    log(`${diff.toRemove.length} remoção(ões):`);
  }
  for (const e of diff.toRemove) {
    log(`  - ${e.email} (${e.contactName}): ${e.fromLevel} → (nenhum)`);
  }

  if (diff.skippedUnresolved.length > 0) {
    log(
      `${diff.skippedUnresolved.length} contato(s) "sem_dados" pulado(s) (nível desconhecido, ` +
        `nenhuma ação): ${diff.skippedUnresolved.map((d) => d.contactName || d.emails[0]).join(", ")}`,
    );
  }

  if (diff.notSubscribed.length > 0) {
    // #4490 causa 3: texto trocado de "não é erro" (soava conclusivo, e era
    // falso pra 4 de 5 casos reais) pra uma leitura que não afirma ausência
    // de vínculo — pode assinar com outro endereço, ver candidatos abaixo.
    log(
      `${diff.notSubscribed.length} apoiador(es)/contato(s) NÃO casaram por e-mail exato ` +
        "com nenhum assinante da plataforma (pode assinar com outro endereço — ver candidatos heurísticos):",
    );
    for (const d of diff.notSubscribed) {
      const label = d.contactName || d.emails[0];
      if (d.candidates.length === 0) {
        log(`  - ${label} (${d.emails.join(", ")}): nenhum candidato heurístico`);
      } else {
        log(`  - ${label} (${d.emails.join(", ")}): ${d.candidates.length} candidato(s):`);
        for (const c of d.candidates) {
          log(`      ? ${c.email} — ${c.detail} (confirmar manualmente, nunca aplicado sozinho)`); // #4506: reason virou union curta, detail carrega o texto legível
        }
      }
    }
  }

  log(`${diff.unchanged.length} já convergido(s) (nenhuma ação).`);
  // #4485 item 3 (follow-up de #4273): "5 apoiadores pagam e não recebem
  // nada por e-mail" já sai listado acima (notSubscribed) — TODO pro
  // editor: decidir se isso deveria virar um ALARME (não só um item de
  // relatório) quando o mesmo contato persiste sem vínculo por várias
  // rodadas seguidas. Não implementado — é decisão editorial, não técnica.
}

export function logBlastRadiusGuard(guard: BlastRadiusGuardResult, logPrefix = DEFAULT_LOG_PREFIX): void {
  const log = (msg: string) => process.stderr.write(`${logPrefix} ${msg}\n`);
  const pct = (guard.ratio * 100).toFixed(1);
  log(
    `guard de blast radius: ${guard.removalCount} remoção(ões) de ${guard.currentWithLevelCount} ` +
      `com nível hoje (${pct}%, limiar ${(BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%)` +
      (guard.blocked ? " — EXCEDIDO." : "."),
  );
}
