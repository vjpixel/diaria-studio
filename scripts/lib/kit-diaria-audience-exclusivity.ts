/**
 * kit-diaria-audience-exclusivity.ts (#6582)
 *
 * Miolo PURO (sem I/O) da auditoria bidirecional pedida pelo item 5 da
 * issue: "existe alguém na tag do Kit que não está ativo na Beehiiv, e
 * alguém ativo na Beehiiv que está na tag?"
 *
 * As DUAS perguntas têm severidade oposta, e é por isso que este módulo é
 * separado de `beehiiv-kit-reconcile.ts` (#6269) em vez de reusar aquele
 * resultado diretamente — `reconcileEmailSets` daquele módulo devolve só o
 * TAMANHO da interseção (`intersectionSize`), suficiente pro guard do
 * switchover, mas não pra ESTA auditoria, que precisa da LISTA de quem
 * está nas duas pontas pra ser acionável:
 *
 * - **Tag do Kit ∖ ativos-Beehiiv** (`onlyInKitTag`) — a direção ESPERADA.
 *   `platform.config.json` → `kit_diaria.audience_tag_note` documenta que a
 *   onda 0/1 foi levantada exatamente como esse conjunto (quem está no Kit
 *   e NÃO está ativo na Beehiiv). Presença aqui não é alarme — é a prova de
 *   que a partição está correta.
 * - **Tag do Kit ∩ ativos-Beehiiv** (`overlapping`) — a direção PERIGOSA.
 *   O mesmo `audience_tag_note` documenta que, a partir da 2ª onda em
 *   diante, mover alguém pra tag do Kit sem desativar na Beehiiv é PASSO
 *   MANUAL, sem guard de código algum (achado do review da PR #6491, citado
 *   ali) — `decideKitChannelDispatch` só protege no nível GLOBAL de backend
 *   (`publishing.newsletter.backend === "kit"`), nunca por tag. Qualquer
 *   e-mail aqui é candidato a receber a edição EM DOBRO (Kit + Beehiiv).
 *
 * O script CLI (`scripts/audit-kit-diaria-exclusivity.ts`) faz só o fetch
 * paginado (Kit: membros da tag via `listTagSubscribersPage`; Beehiiv:
 * ativos via `list_subscriptions`) e delega a comparação pra cá — mesmo
 * padrão de `reconcile-beehiiv-kit.ts`/`beehiiv-kit-reconcile.ts`.
 */

import { normalizeEmail, maskEmail } from "./beehiiv-kit-reconcile.ts";

export interface ExclusivityAuditResult {
  kitTagTotal: number;
  beehiivActiveTotal: number;
  /** Sorted, normalizado. Direção ESPERADA — não é alarme. */
  onlyInKitTag: string[];
  /** Sorted, normalizado. Direção PERIGOSA — candidato a edição em dobro. */
  overlapping: string[];
}

/**
 * Pure: compara os e-mails da tag do Kit contra os e-mails ativos na
 * Beehiiv. Nunca compara contagens — mesma lição do #6269 (a mesma classe
 * de divergência simétrica que uma checagem por tamanho esconderia se
 * aplicasse aqui, embora a pergunta desta auditoria já seja
 * intrinsecamente sobre CONJUNTOS, não contagens).
 */
export function auditKitTagAgainstBeehiivActive(
  kitTagEmailsRaw: readonly string[],
  beehiivActiveEmailsRaw: readonly string[],
): ExclusivityAuditResult {
  const kitSet = new Set(kitTagEmailsRaw.map(normalizeEmail).filter((e) => e.length > 0));
  const beehiivSet = new Set(beehiivActiveEmailsRaw.map(normalizeEmail).filter((e) => e.length > 0));

  const onlyInKitTag: string[] = [];
  const overlapping: string[] = [];
  for (const email of kitSet) {
    if (beehiivSet.has(email)) overlapping.push(email);
    else onlyInKitTag.push(email);
  }
  onlyInKitTag.sort();
  overlapping.sort();

  return {
    kitTagTotal: kitSet.size,
    beehiivActiveTotal: beehiivSet.size,
    onlyInKitTag,
    overlapping,
  };
}

export type AuditDecision =
  | { exitCode: 0; blocking: false }
  | { exitCode: 1; blocking: true };

/**
 * Pure: só `overlapping.length > 0` bloqueia (exit 1 no CLI) — a direção
 * perigosa documentada acima. `onlyInKitTag` não bloqueia nunca: é o estado
 * esperado da partição (#6048).
 */
export function decideAuditExitCode(result: ExclusivityAuditResult): AuditDecision {
  return result.overlapping.length > 0 ? { exitCode: 1, blocking: true } : { exitCode: 0, blocking: false };
}

export interface ExclusivityAuditResultMasked {
  kitTagTotal: number;
  beehiivActiveTotal: number;
  onlyInKitTag: string[];
  overlapping: string[];
}

/** Mascara os e-mails de `ExclusivityAuditResult` pra saída que pode ir a
 *  stdout/log — reusa `maskEmail` de `beehiiv-kit-reconcile.ts` (mesmo
 *  formato do resto do projeto). */
export function maskAuditResult(result: ExclusivityAuditResult): ExclusivityAuditResultMasked {
  return {
    kitTagTotal: result.kitTagTotal,
    beehiivActiveTotal: result.beehiivActiveTotal,
    onlyInKitTag: result.onlyInKitTag.map(maskEmail),
    overlapping: result.overlapping.map(maskEmail),
  };
}

/** Relatório human-readable (stderr do CLI) — mesmo padrão de
 *  `formatGuardReport` em `beehiiv-kit-reconcile.ts`. */
export function formatAuditReport(result: ExclusivityAuditResult, decision: AuditDecision): string {
  const lines: string[] = [];
  lines.push(`[audit-kit-diaria-exclusivity] tag do Kit: ${result.kitTagTotal} membro(s).`);
  lines.push(`[audit-kit-diaria-exclusivity] ativos na Beehiiv: ${result.beehiivActiveTotal}.`);
  lines.push(
    `[audit-kit-diaria-exclusivity] só na tag do Kit (esperado, não bloqueia): ${result.onlyInKitTag.length}.`,
  );
  if (result.overlapping.length > 0) {
    lines.push(
      `[audit-kit-diaria-exclusivity] ⚠️ NA TAG DO KIT E ATIVO NA BEEHIIV (edição em DOBRO): ` +
        `${result.overlapping.length}.`,
    );
    for (const e of result.overlapping) lines.push(`    - ${maskEmail(e)}`);
  } else {
    lines.push(`[audit-kit-diaria-exclusivity] nenhuma sobreposição — partição íntegra.`);
  }
  lines.push(decision.blocking ? "[audit-kit-diaria-exclusivity] RESULTADO: BLOQUEANTE (exit 1)." : "[audit-kit-diaria-exclusivity] RESULTADO: ok (exit 0).");
  return lines.join("\n");
}
