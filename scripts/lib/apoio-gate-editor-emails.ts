/**
 * scripts/lib/apoio-gate-editor-emails.ts (#9491)
 *
 * E-mails de editor/QA que entram SEMPRE nas allowlists dos gates de apoio —
 * Retrospectiva do Mês (`workers/retrospectiva`, KV `ALLOWLIST`, populado por
 * `scripts/build-apoiador-allowlist.ts`) e Artigo Especial
 * (`workers/artigos`, KV `ARTIGOS_APOIO_NIVEL`, populado por
 * `scripts/sync-artigos-apoio-kv.ts`).
 *
 * Por que existe: as duas allowlists derivam do CRM de Apoios (apoia.se), e o
 * editor não é apoiador — então ele recebia "não é apoiador" justamente ao
 * conferir o que o apoiador vê (passo do `/diaria-mensal-apoiadores`). Medido
 * em 02/10/2026: o push da allowlist da Retrospectiva enviou 11 e-mails, sem o
 * do editor.
 *
 * A lista vem de CONFIG (`platform.config.json` → `apoio_gate_editor_emails.emails`),
 * nunca de literal no código dos Workers: o Worker continua lendo só o KV, e o
 * e-mail chega lá pelo mesmo push que grava os apoiadores. Os gates seguem
 * fail-closed — isto só ACRESCENTA e-mails à lista que o script já gravaria.
 *
 * Config ausente, chave ausente ou valor fora do formato → lista vazia (sem
 * extras), nunca erro: a ausência de editores não pode bloquear o push dos
 * apoiadores. JSON malformado, por outro lado, LANÇA — não dá pra distinguir
 * "sem editores" de "arquivo quebrado" e o push tem de parar antes de gravar.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Chave de topo em `platform.config.json`. */
export const APOIO_GATE_EDITOR_EMAILS_CONFIG_KEY = "apoio_gate_editor_emails";

/** Mesma normalização dos gates (`normalizeEmail` em
 * `workers/retrospectiva/src/gate-cadastro.ts`; `sha256Hex` em
 * `scripts/lib/shared/subscriber-verify.ts` hasheia trim+lowercase). */
export function normalizeGateEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Pura: extrai a lista de e-mails de editor do objeto de config já parseado.
 * Normaliza, descarta vazios/não-strings/sem `@`, deduplica, ordena.
 *
 * @pure
 */
export function parseApoioGateEditorEmails(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const slice = (config as Record<string, unknown>)[APOIO_GATE_EDITOR_EMAILS_CONFIG_KEY];
  if (!slice || typeof slice !== "object") return [];
  const emails = (slice as Record<string, unknown>).emails;
  if (!Array.isArray(emails)) return [];
  const out = new Set<string>();
  for (const e of emails) {
    if (typeof e !== "string") continue;
    const n = normalizeGateEmail(e);
    if (n && n.includes("@")) out.add(n);
  }
  return [...out].sort();
}

/** Lê `platform.config.json` de `rootDir`. Arquivo ausente → `[]`; JSON
 * inválido → lança (ver cabeçalho). */
export function readApoioGateEditorEmails(rootDir: string): string[] {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `${path} não pôde ser parseado (${(e as Error).message}) — sem ele não dá pra saber os e-mails de ` +
        `editor (${APOIO_GATE_EDITOR_EMAILS_CONFIG_KEY}). Conserte o JSON antes de rodar.`,
    );
  }
  return parseApoioGateEditorEmails(parsed);
}

/**
 * Pura: une a allowlist de apoiadores com os e-mails de editor. Devolve a
 * lista final (normalizada, sem duplicata, ordenada) e quais editores NÃO
 * estavam já na lista de apoiadores — é isso que o diff do push marca como
 * "(editor)", pra nunca se confundir com apoiador novo.
 *
 * @pure
 */
export function mergeEditorEmails(
  apoiadores: readonly string[],
  editors: readonly string[],
): { merged: string[]; editorsOnly: string[] } {
  const apoiadorSet = new Set(apoiadores.map(normalizeGateEmail).filter(Boolean));
  const editorsOnly = [...new Set(editors.map(normalizeGateEmail).filter(Boolean))]
    .filter((e) => !apoiadorSet.has(e))
    .sort();
  const merged = [...new Set([...apoiadorSet, ...editorsOnly])].sort();
  return { merged, editorsOnly };
}
