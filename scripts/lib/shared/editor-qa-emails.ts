/**
 * scripts/lib/shared/editor-qa-emails.ts (#9491)
 *
 * E-mails do editor/QA que SEMPRE entram nas allowlists de apoio (Retrospectiva
 * do Mês, KV `ALLOWLIST`; Artigo Especial, KV `ARTIGOS_APOIO_NIVEL`) — para o
 * editor conferir o que o apoiador vê sem ser apoiador.
 *
 * O repo é PÚBLICO: a lista NÃO vive em código nem em `platform.config.json`.
 * Vem do env `EDITOR_QA_EMAILS` (CSV; Doppler/.env, nunca commitado) e só chega
 * ao Worker via KV, gravado pelos scripts de sync. Env ausente/vazio = lista
 * vazia (comportamento anterior, nada muda).
 */

export const EDITOR_QA_EMAILS_ENV = "EDITOR_QA_EMAILS";

/** Pura: CSV (vírgula/;/espaço/quebra de linha) → e-mails normalizados, únicos, ordenados. */
export function parseEditorQaEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e.includes("@")) out.add(e);
  }
  return [...out].sort();
}

export function readEditorQaEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseEditorQaEmails(env[EDITOR_QA_EMAILS_ENV]);
}
