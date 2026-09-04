/**
 * scripts/lib/hermes-session-status.ts (#6817 item 2, decisão do editor 03/09/2026)
 *
 * ## Por que existe
 *
 * `~/.hermes/sessions/sessions.json` guarda estado de sessão que o contínuo
 * precisa ler (status da última rodada, override de modelo, sinal de
 * exaustão de conta) — mas o arquivo pode carregar campos que não deveriam
 * sair num log que vai pro Telegram. A decisão do editor (03/09/2026,
 * comentário na issue #6817) foi explícita sobre o DESENHO, não só sobre a
 * permissão:
 *
 * > "O desenho é allowlist de saída, não blacklist de segredo — e essa
 * > distinção é a decisão."
 *
 * O precedente óbvio seria copiar `hermes/scripts/claude-openrouter.sh`
 * (`redact_secrets_in_file`, linhas ~296-310), que já lê `~/.hermes/
 * auth.json`, extrai só o `sk-or-*` num subshell, e redige qualquer string
 * com esse prefixo nos logs. Funciona, está em produção — mas é
 * **blacklist**: redige o que RECONHECE. Os tokens OAuth do Codex têm
 * formato diferente de `sk-or-*`; uma redação calibrada pra OpenRouter não
 * os cobre. Blacklist falha ABERTO: campo novo em `sessions.json` vaza por
 * padrão até alguém lembrar de adicioná-lo à lista de redação.
 *
 * Allowlist falha FECHADO: campo novo não sai a menos que seja adicionado
 * de propósito a `allowedFields`. Quando o custo do erro é vazar credencial
 * num canal público, é a direção certa — mesmo custando ergonomia (um campo
 * legítimo novo em `sessions.json` fica invisível pro contínuo até alguém
 * atualizar `DEFAULT_ALLOWED_SESSION_FIELDS`, em vez de vazar por padrão).
 *
 * ## Honestidade de escopo — schema real não inspecionado
 *
 * Este módulo nunca teve acesso ao `sessions.json` real (vive em `~/.hermes`
 * no `helios`, fora do alcance desta sessão/worktree). `DEFAULT_ALLOWED_
 * SESSION_FIELDS` é um ponto de partida derivado literalmente da decisão do
 * editor ("last_status, override de modelo da sessão, sinal de exaustão de
 * conta") — os nomes de campo exatos (`last_status` vs. `status`, etc.)
 * precisam ser confirmados contra o arquivo real na próxima vez que alguém
 * tiver acesso ao `helios`, e ajustados via `--fields` (CLI) ou um novo
 * default aqui. `extractSessionStatus` é pura e agnóstica ao nome exato dos
 * campos — o comportamento de allowlist-fecha-por-padrão não depende de
 * acertar os nomes de primeira.
 *
 * ## Contrato
 *
 * `extractSessionStatus` é PURA — recebe o JSON já parseado e a lista de
 * campos permitidos, nunca toca disco. O CLI (`scripts/read-hermes-session-
 * status.ts`) é o único lugar que lê o arquivo — e ele próprio passa pelo
 * gate de `isPathAllowed` (mesma allowlist de raízes do #6817 item 1) antes
 * de abrir o arquivo, então "ler `sessions.json` direto, por conveniência
 * de debug" nem chega a compilar contra o mecanismo — precisa contornar
 * dois gates, não um.
 */

/** Campos que a decisão do editor (03/09/2026) nomeou explicitamente.
 * Ajustar aqui (ou via `--fields` no CLI) quando o schema real de
 * `sessions.json` for confirmado — nunca ampliar "pra garantir que pega
 * tudo": a lista curta É o mecanismo de segurança, não um detalhe a
 * completar depois. */
export const DEFAULT_ALLOWED_SESSION_FIELDS: readonly string[] = [
  "last_status",
  "model_override",
  "exhausted",
];

/**
 * Filtra um único registro de sessão (objeto raso) contra `allowedFields`.
 * Campos ausentes no registro são omitidos (não viram `null`/`undefined`
 * explícito) — a saída só tem o que o registro de fato carregava E estava
 * na allowlist. `undefined` quando `value` não é um objeto filtrável (nunca
 * repassa um valor cru desconhecido).
 */
function filterSessionRecord(value: unknown, allowedFields: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      out[field] = record[field];
    }
  }
  return out;
}

/**
 * Extrai uma view redigida do conteúdo já parseado de `sessions.json`.
 * Suporta as 2 formas plausíveis de um arquivo "sessions.json" sem assumir
 * qual é a real (#6817 — schema não inspecionado):
 *
 *   - `Array<SessionRecord>` — cada elemento é filtrado por `allowedFields`
 *     (nenhum campo de identidade é repassado a menos que esteja na
 *     allowlist — inclua explicitamente `"session_id"`/`"id"` etc. se
 *     precisar dele no output).
 *   - `Record<string, SessionRecord>` — mapa `sessionId -> registro`. A
 *     CHAVE do mapa é estrutural (identifica QUAL sessão, não um valor que
 *     possa carregar segredo) e é sempre repassada; o VALOR é filtrado.
 *
 * Qualquer outra forma no topo (escalar, `null`, algo inesperado) retorna
 * `null` — nada seguro a extrair, nunca adivinha uma forma pra tentar
 * salvar alguma coisa.
 */
export function extractSessionStatus(raw: unknown, allowedFields: readonly string[] = DEFAULT_ALLOWED_SESSION_FIELDS): unknown {
  if (Array.isArray(raw)) {
    return raw.map((entry) => filterSessionRecord(entry, allowedFields) ?? {});
  }
  if (raw !== null && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = filterSessionRecord(value, allowedFields) ?? {};
    }
    return out;
  }
  return null;
}
