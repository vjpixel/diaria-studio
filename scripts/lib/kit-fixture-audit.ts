/**
 * kit-fixture-audit.ts (#6336)
 *
 * Cruza a listagem de assinantes do Kit (`kit-subscribers.ts`) com o
 * detector puro de padrão de fixture (`kit-fixture-patterns.ts`). Puro —
 * sem I/O — pra ser testável sem rede; `scripts/audit-kit-fixtures.ts` é a
 * casca fina que busca os assinantes reais e chama isto.
 */

import { matchFixtureEmail } from "./kit-fixture-patterns.ts";

/** Subconjunto de `KitSubscriberSummary` que este módulo precisa — evita
 *  acoplar a assinatura pura a todo o shape de `kit-subscribers.ts`. */
export interface KitFixtureAuditInput {
  id: number;
  email_address: string;
  state: string;
}

export interface KitFixtureFinding {
  id: number;
  email: string;
  state: string;
  reason: string;
}

export interface KitFixtureAuditResult {
  /** Todo assinante cujo e-mail bate um padrão de fixture, qualquer estado. */
  all: KitFixtureFinding[];
  /** Subconjunto de `all` com `state === "active"` — o caso que importa:
   *  receberia a próxima campanha/broadcast real. */
  active: KitFixtureFinding[];
}

export function auditKitFixtures(subscribers: KitFixtureAuditInput[]): KitFixtureAuditResult {
  const all: KitFixtureFinding[] = [];
  for (const s of subscribers) {
    const reason = matchFixtureEmail(s.email_address);
    if (reason) {
      all.push({ id: s.id, email: s.email_address, state: s.state, reason });
    }
  }
  const active = all.filter((f) => f.state === "active");
  return { all, active };
}

/**
 * Renderiza o resultado como texto legível — usado tanto pelo CLI
 * (`scripts/audit-kit-fixtures.ts`, stdout) quanto pela mensagem de
 * violation do invariant check (Stage 4), que embute o stdout do CLI.
 */
export function renderKitFixtureAuditReport(result: KitFixtureAuditResult): string {
  if (result.all.length === 0) {
    return "Nenhum assinante de fixture encontrado na base Kit.";
  }
  const lines: string[] = [
    `${result.all.length} assinante(s) de fixture encontrado(s) (${result.active.length} ATIVO(s)):`,
  ];
  for (const f of result.all) {
    const flag = f.state === "active" ? "ATIVO" : f.state;
    lines.push(`  - [${flag}] ${f.email} (id=${f.id}) — ${f.reason}`);
  }
  return lines.join("\n");
}
