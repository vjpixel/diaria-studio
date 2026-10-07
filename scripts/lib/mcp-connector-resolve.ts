/**
 * mcp-connector-resolve.ts (#9823)
 *
 * Um conector claude.ai (Gmail, Beehiiv, …) às vezes chega na sessão sob um
 * prefixo de INSTALAÇÃO (`mcp__<uuid>__search_threads`) em vez do prefixo
 * estável `mcp__claude_ai_Gmail__` (#7279, #8902). O `tools:` de um agent é
 * allowlist por NOME — com o prefixo trocado, as tools somem em silêncio e o
 * `review-test-email` volta `inconclusive`/`mcp_unavailable` sem abrir o
 * e-mail (edição 261007). O #9000 moveu a busca do e-mail pro top-level
 * (`orchestrator-stage-5.md` §5f passo 0), mas a DESCOBERTA do prefixo ficava
 * em prosa ("ToolSearch carrega o schema sob o nome que existir") — e na
 * 261007 o top-level não achou e nem tentou.
 *
 * Este módulo é a parte determinística: dada a lista de nomes de tool que a
 * sessão expõe (o top-level cola a saída de um `ToolSearch`), decide QUAL
 * prefixo é o do conector, sem heurística de memória:
 *   1. agrupa os nomes por prefixo `mcp__{server}__`;
 *   2. candidatos = prefixos que têm TODAS as tools `required`;
 *   3. o prefixo estável vence se estiver entre os candidatos;
 *   4. senão, vence o candidato com mais tools de `signature` (assinatura do
 *      conector — ex.: `list_labels`/`create_label` só existem no Gmail);
 *      empate ou nenhum com assinatura → `ambiguous` (nunca chutar: chamar a
 *      tool de outro conector com a query do e-mail de teste seria pior que
 *      `inconclusive`).
 *
 * Nunca grava o UUID em texto versionado (#7307 — `validate-agent-frontmatter`
 * rejeita): o resultado vive só na sessão.
 */

export interface ConnectorSpec {
  /** Prefixo estável do conector claude.ai (com os `__` finais). */
  stablePrefix: string;
  /** Tools que o chamador precisa — todas têm que existir sob o mesmo prefixo. */
  required: string[];
  /** Tools que identificam o conector entre outros que também tenham `required`. */
  signature: string[];
}

export const CONNECTORS: Record<string, ConnectorSpec> = {
  gmail: {
    stablePrefix: "mcp__claude_ai_Gmail__",
    required: ["search_threads", "get_thread"],
    signature: ["list_labels", "create_label", "label_thread", "create_draft", "list_drafts", "get_message"],
  },
};

export type ResolveStatus = "stable" | "renamed" | "missing" | "ambiguous";

export interface ResolveResult {
  status: ResolveStatus;
  /** Prefixo escolhido (`mcp__…__`), ou null em missing/ambiguous. */
  prefix: string | null;
  /** Nome completo de cada tool `required` sob o prefixo escolhido. */
  tools: Record<string, string>;
  /** Argumento pronto pro `ToolSearch` carregar os schemas (`select:a,b`). */
  select: string | null;
  /** Prefixos que tinham todas as `required` (diagnóstico). */
  candidates: string[];
}

const TOOL_NAME_RE = /^(mcp__.+?__)([A-Za-z0-9_]+)$/;

/** Separa a lista colada (vírgula, espaço ou quebra de linha) em nomes `mcp__…`. */
export function parseToolNames(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => TOOL_NAME_RE.test(s));
}

export function resolveConnectorTools(names: string[], spec: ConnectorSpec): ResolveResult {
  const byPrefix = new Map<string, Set<string>>();
  for (const name of names) {
    const m = name.match(TOOL_NAME_RE);
    if (!m) continue;
    const set = byPrefix.get(m[1]) ?? new Set<string>();
    set.add(m[2]);
    byPrefix.set(m[1], set);
  }
  const candidates = [...byPrefix.entries()]
    .filter(([, tools]) => spec.required.every((t) => tools.has(t)))
    .map(([prefix]) => prefix)
    .sort();

  const build = (status: ResolveStatus, prefix: string | null): ResolveResult => {
    const tools: Record<string, string> = {};
    if (prefix) for (const t of spec.required) tools[t] = `${prefix}${t}`;
    return {
      status,
      prefix,
      tools,
      select: prefix ? `select:${spec.required.map((t) => `${prefix}${t}`).join(",")}` : null,
      candidates,
    };
  };

  if (candidates.length === 0) return build("missing", null);
  if (candidates.includes(spec.stablePrefix)) return build("stable", spec.stablePrefix);

  const scored = candidates.map((prefix) => ({
    prefix,
    hits: spec.signature.filter((t) => byPrefix.get(prefix)!.has(t)).length,
  }));
  const best = Math.max(...scored.map((s) => s.hits));
  const winners = scored.filter((s) => s.hits === best);
  if (best === 0 || winners.length !== 1) return build("ambiguous", null);
  return build("renamed", winners[0].prefix);
}
