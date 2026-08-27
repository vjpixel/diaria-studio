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
  /** Registros malformados (sem `email_address` string) que a API do Kit
   *  devolveu — tratados como "não-fixture" e pulados, nunca lançam (#6383
   *  F3: a docstring de `kit-client.ts`, #6181, documenta que essa API tem
   *  armadilhas reais de shape). Vazio no caminho feliz. */
  skipped?: Array<{ id: unknown; reason: string }>;
}

export function auditKitFixtures(subscribers: KitFixtureAuditInput[]): KitFixtureAuditResult {
  const all: KitFixtureFinding[] = [];
  const skipped: KitFixtureAuditResult["skipped"] = [];
  for (const s of subscribers) {
    if (typeof s?.email_address !== "string") {
      skipped.push({ id: s?.id, reason: `email_address ausente/não-string (${typeof s?.email_address})` });
      continue;
    }
    const reason = matchFixtureEmail(s.email_address);
    if (reason) {
      all.push({ id: s.id, email: s.email_address, state: s.state, reason });
    }
  }
  const active = all.filter((f) => f.state === "active");
  return { all, active, skipped };
}

/**
 * Renderiza o resultado como texto legível — usado tanto pelo CLI
 * (`scripts/audit-kit-fixtures.ts`, stdout) quanto pela mensagem de
 * violation do invariant check (Stage 4), que embute o stdout do CLI.
 */
export function renderKitFixtureAuditReport(result: KitFixtureAuditResult): string {
  const lines: string[] = [];
  if (result.all.length === 0) {
    lines.push("Nenhum assinante de fixture encontrado na base Kit.");
  } else {
    lines.push(
      `${result.all.length} assinante(s) de fixture encontrado(s) (${result.active.length} ATIVO(s)):`,
    );
    for (const f of result.all) {
      const flag = f.state === "active" ? "ATIVO" : f.state;
      lines.push(`  - [${flag}] ${f.email} (id=${f.id}) — ${f.reason}`);
    }
  }
  if (result.skipped?.length) {
    lines.push(
      `${result.skipped.length} registro(s) malformado(s) pulado(s) (sem email_address válido):`,
    );
    for (const sk of result.skipped) {
      lines.push(`  - id=${String(sk.id)} — ${sk.reason}`);
    }
  }
  return lines.join("\n");
}

