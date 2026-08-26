/**
 * beehiiv-kit-reconcile.ts (#6269)
 *
 * Miolo PURO (sem I/O de rede) do guard de reconciliação Beehiiv×Kit —
 * pré-condição do switchover do #6114. O achado do #6269: as duas bases têm
 * a MESMA contagem de ativos (587 = 587), mas a interseção é menor (584) —
 * 3 e-mails só numa base, 3 só na outra. A divergência é SIMÉTRICA, então
 * qualquer verificação por CONTAGEM (a que qualquer um faria primeiro)
 * passa e o problema fica invisível. Este módulo compara os CONJUNTOS de
 * e-mail, nunca as contagens.
 *
 * O script CLI (`scripts/reconcile-beehiiv-kit.ts`) faz só o fetch paginado
 * das duas APIs e delega toda a lógica de comparação pra cá — é o que torna
 * este módulo testável sem rede (mesmo padrão de `apoios-diff-alarm.ts`,
 * `daily-carousel-card.ts` etc: I/O fino em `scripts/`, lógica em
 * `scripts/lib/`).
 *
 * ## Critério de saída — ASSIMÉTRICO de propósito (corpo da issue #6269)
 *
 * - `onlyInBeehiiv.length > 0` → **bloqueante** (exit != 0 no CLI). Ninguém
 *   que recebe hoje (ativo na Beehiiv) pode ficar de fora no Kit — é o
 *   invariante que o switchover do #6114 depende.
 * - `onlyInKit.length > 0` → **warning, não bloqueia**. Pode ser legítimo
 *   (alguém pediu pra sair da Beehiiv e ainda não saiu do Kit, ou o inverso
 *   de um fluxo de opt-out em andamento) — decisão editorial, não erro
 *   mecânico. Tratar como bloqueante faria o guard gritar por algo que às
 *   vezes é o comportamento correto.
 *
 * O SHA-256 de cada conjunto ORDENADO (não a lista bruta — ordem de chegada
 * da API não é estável) é o que torna a divergência simétrica DETECTÁVEL
 * sem depender de olhar a diferença item a item: dois conjuntos de mesmo
 * tamanho com conteúdo diferente produzem hashes diferentes mesmo quando a
 * contagem bate.
 */

import { createHash } from "node:crypto";

/** Pure: normaliza um e-mail pra comparação — trim + lowercase. Mesma regra
 *  usada em todo lugar do repo que compara e-mail entre Beehiiv/Kit/apoia.se
 *  (ex: `fetchCurrentBeehiivState`/`fetchCurrentKitState`). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pure: normaliza + deduplica uma lista de e-mails num Set. */
export function toNormalizedEmailSet(emails: readonly string[]): Set<string> {
  return new Set(emails.map(normalizeEmail).filter((e) => e.length > 0));
}

export interface NormalizationStats {
  /** Entradas normalizadas não-vazias que colapsaram em cima de outra já
   *  vista — duplicata de verdade (mesmo e-mail 2×). */
  duplicates: number;
  /** Entradas que normalizaram pra string vazia (whitespace/vazio) e foram
   *  descartadas — não é duplicata, é dado ausente/mal formado. Volume alto
   *  aqui é sinal de parsing quebrado do lado da API, não de gente
   *  cadastrada 2×. */
  emptyDiscarded: number;
}

/** Pure: separa, do total de entradas cruas menos o tamanho do set final
 *  (`raw.length - set.size`, o que antes o guard reportava como um único
 *  número "deduped"), quanto veio de duplicata real vs. entrada vazia
 *  descartada (#6269 finding — as duas causas eram conflacionadas num só
 *  contador, escondendo justamente o sinal de parsing quebrado). */
export function computeNormalizationStats(emails: readonly string[]): NormalizationStats {
  const seen = new Set<string>();
  let duplicates = 0;
  let emptyDiscarded = 0;
  for (const raw of emails) {
    const normalized = normalizeEmail(raw);
    if (normalized.length === 0) {
      emptyDiscarded++;
      continue;
    }
    if (seen.has(normalized)) duplicates++;
    else seen.add(normalized);
  }
  return { duplicates, emptyDiscarded };
}

/** Pure: SHA-256 hex de um conjunto de e-mails já normalizados — ORDENA
 *  antes de hashear (ordem de chegada da API não é estável, então hashear
 *  sem ordenar produziria hashes diferentes pro MESMO conjunto lógico entre
 *  duas rodadas). Junta com `\n` — separador que nunca aparece num e-mail
 *  válido, então não há ambiguidade de fronteira entre entradas. */
export function sha256OfSortedEmailSet(emails: Iterable<string>): string {
  const sorted = [...emails].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

export interface ReconcileEmailSetsResult {
  /** Total bruto informado por cada lado (após normalização+dedup — inclui
   *  qualquer duplicata já colapsada, ver `dedupedFrom*`). */
  beehiivTotal: number;
  kitTotal: number;
  /** Quantos e-mails de entrada foram colapsados por duplicata OU
   *  descartados por normalizar pra vazio — soma das duas causas em
   *  `NormalizationStats` (mantido para não quebrar consumidores do total;
   *  ver `beehiivStats`/`kitStats` pra causa discriminada). */
  dedupedFromBeehiiv: number;
  dedupedFromKit: number;
  /** Causa discriminada do descarte de cada lado (#6269 finding) —
   *  duplicata real vs. entrada vazia (sinal de parsing quebrado). */
  beehiivStats: NormalizationStats;
  kitStats: NormalizationStats;
  intersectionSize: number;
  /** Sorted — determinístico entre rodadas com o mesmo conjunto lógico. */
  onlyInBeehiiv: string[];
  onlyInKit: string[];
  /** SHA-256 do conjunto ORDENADO de cada lado — ver docstring do módulo. */
  beehiivHash: string;
  kitHash: string;
}

/**
 * Pure: compara os CONJUNTOS de e-mail ativo entre Beehiiv e Kit. Nunca
 * compara contagens — é exatamente a comparação que o achado do #6269 prova
 * insuficiente (587 == 587 com interseção 584).
 */
export function reconcileEmailSets(
  beehiivEmailsRaw: readonly string[],
  kitEmailsRaw: readonly string[],
): ReconcileEmailSetsResult {
  const beehiivSet = toNormalizedEmailSet(beehiivEmailsRaw);
  const kitSet = toNormalizedEmailSet(kitEmailsRaw);

  const onlyInBeehiiv: string[] = [];
  const onlyInKit: string[] = [];
  let intersectionSize = 0;

  for (const email of beehiivSet) {
    if (kitSet.has(email)) intersectionSize++;
    else onlyInBeehiiv.push(email);
  }
  for (const email of kitSet) {
    if (!beehiivSet.has(email)) onlyInKit.push(email);
  }
  onlyInBeehiiv.sort();
  onlyInKit.sort();

  const beehiivStats = computeNormalizationStats(beehiivEmailsRaw);
  const kitStats = computeNormalizationStats(kitEmailsRaw);

  return {
    beehiivTotal: beehiivSet.size,
    kitTotal: kitSet.size,
    dedupedFromBeehiiv: beehiivEmailsRaw.length - beehiivSet.size,
    dedupedFromKit: kitEmailsRaw.length - kitSet.size,
    beehiivStats,
    kitStats,
    intersectionSize,
    onlyInBeehiiv,
    onlyInKit,
    beehiivHash: sha256OfSortedEmailSet(beehiivSet),
    kitHash: sha256OfSortedEmailSet(kitSet),
  };
}

export interface GuardDecision {
  /** 0 = guard passa (switchover pode prosseguir); 1 = bloqueante. */
  exitCode: 0 | 1;
  /** true quando `onlyInBeehiiv.length > 0` — o invariante real (ver
   *  docstring do módulo). */
  blocking: boolean;
  /** true quando `onlyInKit.length > 0` — reportado, nunca bloqueia
   *  sozinho. */
  hasWarning: boolean;
}

/** Pure: decide o exit code do guard a partir do resultado da comparação —
 *  critério ASSIMÉTRICO (ver docstring do módulo). Só `onlyInBeehiiv`
 *  bloqueia; `onlyInKit` é warning. */
export function decideGuardExitCode(result: ReconcileEmailSetsResult): GuardDecision {
  const blocking = result.onlyInBeehiiv.length > 0;
  const hasWarning = result.onlyInKit.length > 0;
  return { exitCode: blocking ? 1 : 0, blocking, hasWarning };
}

/** Pure: mascara um e-mail pra saída que pode ir a stdout/log — mantém só o
 *  1º caractere do local-part + o domínio completo (ex: `joao@example.com`
 *  -> `j***@example.com`). Mesmo formato de `maskEmailForIssue` em
 *  `apoios-diff-alarm.ts` (não reimportado daqui de propósito: aquele
 *  módulo é do domínio apoio/Beehiiv-Kit-agnóstico só por acidente de onde
 *  nasceu; duplicar essa função de 3 linhas evita acoplar dois guards sem
 *  relação editorial entre si por um utilitário de string). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email.length > 0 ? `${email[0]}***` : "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Pure: versão de `ReconcileEmailSetsResult` segura pra `--json` — mesma
 * disciplina "sem PII crua no stdout" da issue (#6269), que a saída humana
 * já respeitava (`formatGuardReport`/`maskEmail`) mas `--json` não: antes
 * deste helper, o CLI serializava `onlyInBeehiiv`/`onlyInKit` com e-mail
 * cru, e esse é justamente o caminho de maior alcance — a saída `--json`
 * existe pra ser consumida por pipeline/log/CI (pré-condição do #6114),
 * não só lida por humano na hora. Reusa `maskEmail` — a MESMA máscara da
 * saída texto, nunca uma segunda implementação divergente. */
export interface ReconcileEmailSetsResultMasked
  extends Omit<ReconcileEmailSetsResult, "onlyInBeehiiv" | "onlyInKit"> {
  onlyInBeehiiv: string[];
  onlyInKit: string[];
}

/** Pure: mascara os e-mails de `onlyInBeehiiv`/`onlyInKit` — único uso
 *  pretendido é alimentar `JSON.stringify` no `--json` do CLI. Preserva a
 *  ordenação já garantida por `reconcileEmailSets`. */
export function maskResultForJson(result: ReconcileEmailSetsResult): ReconcileEmailSetsResultMasked {
  return {
    ...result,
    onlyInBeehiiv: result.onlyInBeehiiv.map(maskEmail),
    onlyInKit: result.onlyInKit.map(maskEmail),
  };
}

/**
 * Pure: monta o relatório humano (texto) do guard — contagens, interseção,
 * hashes, e-mails mascarados só-em-um-lado, e o veredito. Sem PII crua no
 * texto (e-mails sempre mascarados) — mesma disciplina do corpo da issue
 * ("Saída sem PII no stdout: contagens + e-mails mascarados").
 */
export function formatGuardReport(result: ReconcileEmailSetsResult, decision: GuardDecision): string {
  const lines: string[] = [];
  lines.push("[reconcile-beehiiv-kit] Reconciliação de conjuntos de e-mail ativo");
  lines.push(`  Beehiiv (ativos): ${result.beehiivTotal}`);
  lines.push(`  Kit (state=active): ${result.kitTotal}`);
  lines.push(`  interseção: ${result.intersectionSize}`);
  lines.push(`  só na Beehiiv: ${result.onlyInBeehiiv.length}`);
  lines.push(`  só no Kit: ${result.onlyInKit.length}`);
  lines.push(`  SHA-256 (Beehiiv, conjunto ordenado): ${result.beehiivHash}`);
  lines.push(`  SHA-256 (Kit, conjunto ordenado): ${result.kitHash}`);
  if (result.beehiivStats.duplicates > 0) {
    lines.push(`  aviso: ${result.beehiivStats.duplicates} duplicata(s) colapsada(s) do lado Beehiiv`);
  }
  if (result.beehiivStats.emptyDiscarded > 0) {
    lines.push(
      `  aviso: ${result.beehiivStats.emptyDiscarded} entrada(s) vazia(s) descartada(s) do lado Beehiiv — possível parsing quebrado`,
    );
  }
  if (result.kitStats.duplicates > 0) {
    lines.push(`  aviso: ${result.kitStats.duplicates} duplicata(s) colapsada(s) do lado Kit`);
  }
  if (result.kitStats.emptyDiscarded > 0) {
    lines.push(
      `  aviso: ${result.kitStats.emptyDiscarded} entrada(s) vazia(s) descartada(s) do lado Kit — possível parsing quebrado`,
    );
  }
  if (result.onlyInBeehiiv.length > 0) {
    lines.push(`  BLOQUEANTE — só na Beehiiv (${result.onlyInBeehiiv.length}):`);
    for (const e of result.onlyInBeehiiv) lines.push(`    - ${maskEmail(e)}`);
  }
  if (result.onlyInKit.length > 0) {
    lines.push(`  warning — só no Kit (${result.onlyInKit.length}), não bloqueia:`);
    for (const e of result.onlyInKit) lines.push(`    - ${maskEmail(e)}`);
  }
  lines.push(
    decision.blocking
      ? "  VEREDITO: DIVERGE (bloqueante) — switchover do #6114 NÃO deve prosseguir."
      : decision.hasWarning
        ? "  VEREDITO: OK (com warning só-no-Kit, não bloqueante) — switchover pode prosseguir."
        : "  VEREDITO: OK — conjuntos idênticos, switchover pode prosseguir.",
  );
  return lines.join("\n");
}
