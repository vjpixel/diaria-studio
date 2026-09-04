/**
 * scripts/lib/hermes-config-writer.ts (#6817 item 3)
 *
 * Miolo PURO do "verbo único" pra escrever config de runtime do Hermes
 * (`~/.hermes/config.yaml`, `cron/jobs.json`, perfis) — mesmo padrão de
 * `scripts/route-issue.ts` (#5969 Fase 1, citado explicitamente na issue):
 * uma chamada, um veredito, validação pós-escrita. O CLI que faz I/O é
 * `scripts/write-hermes-config.ts`; este módulo só decide nomes de arquivo
 * e transforma texto — nunca toca disco nem spawna processo.
 *
 * ## Por que existe
 *
 * A issue nomeia o padrão de falha: editar `config.yaml` na unha dentro de
 * um tick autônomo, sem backup nem validação, é como o histórico de
 * `config.yaml.bak-*` "informal" ao lado do arquivo vivo nasceu — convenção
 * ad-hoc, nunca um mecanismo. O verbo formaliza:
 *
 *   1. backup automático ANTES de escrever (nome com motivo + data —
 *      `buildBackupFileName`);
 *   2. validação (comando externo, `hermes config`/parse — o CLI decide
 *      QUAL comando; este módulo não conhece o binário `hermes`);
 *   3. smoke probe (comando externo também — ex: `hermes -z "OK" -m
 *      <modelo>`);
 *   4. revert automático em 1 comando se validação/probe falhar — o CLI
 *      restaura o backup; `planRevert` só decide QUAL backup (explícito ou
 *      o mais recente pelo prefixo);
 *   5. eco redigido pro snapshot do fork (`~/hermes-agent/config/hermes-
 *      home/`) — `redactConfigText` faz a redação, o CLI decide se o
 *      destino passa pela allowlist de raízes antes de escrever.
 *
 * ## Redação do snapshot — blacklist de chave, não allowlist de campo
 *
 * Diferente do leitor de `sessions.json` (#6817 item 2, `hermes-session-
 * status.ts`), que a decisão do editor fixou como allowlist de SAÍDA, o eco
 * de `config.yaml` segue o precedente JÁ em produção no fork: o commit
 * `3ca1040ad` (mencionado no corpo da issue) versiona `config/hermes-home/
 * config.yaml` com `dashboard.basic_auth.password_hash` redigido à mão —
 * blacklist de NOME DE CHAVE. A distinção da decisão de 03/09/2026 era
 * especificamente sobre COMO ler `sessions.json` (estrutura desconhecida,
 * campos de credencial sem padrão de nome fixo); `config.yaml` é o oposto —
 * schema conhecido, um punhado de chaves sensíveis identificáveis por nome
 * — então reusar o padrão já validado em produção (blacklist de chave) é
 * consistente, não uma contradição da decisão. `DEFAULT_SENSITIVE_CONFIG_KEYS`
 * é AMPLIADA quando um nome novo de chave sensível aparecer — igual
 * `redact_secrets_in_file` em `claude-openrouter.sh` já opera.
 */

/** Chaves cujo VALOR é substituído por `<redacted>` na saída de
 * `redactConfigText`, independente de indentação/aninhamento — casamento é
 * pelo nome da chave (parte antes do primeiro `:` na linha, trimmed),
 * nunca pelo caminho completo no YAML (schema desconhecido a priori). */
export const DEFAULT_SENSITIVE_CONFIG_KEYS: readonly string[] = [
  "password_hash",
  "password",
  "token",
  "api_key",
  "apikey",
  "secret",
  "auth_token",
];

/** Sanitiza `motivo` pra um trecho de nome de arquivo seguro — minúsculas,
 * `[^a-z0-9]` vira `-`, hífens repetidos colapsam, sem hífen nas pontas.
 * `motivo` vazio (ou só caracteres não-alfanuméricos) vira `"sem-motivo"` —
 * nunca produz um nome de backup com um segmento vazio (`config.yaml.bak--
 * 20260904`), que seria ambíguo de parsear de volta. */
export function slugifyMotivo(motivo: string): string {
  const slug = motivo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "sem-motivo";
}

/**
 * Monta o nome do arquivo de backup: `<basename>.bak-<motivo>-<data>`.
 * `dateStr` é injetado pelo caller (nunca `new Date()` aqui — função pura,
 * testável sem mockar relógio) e deve já vir formatado pra ordenar
 * lexicograficamente (`YYYYMMDDTHHMMSSZ`, ver `formatBackupTimestamp`).
 */
export function buildBackupFileName(basename: string, motivo: string, dateStr: string): string {
  return `${basename}.bak-${slugifyMotivo(motivo)}-${dateStr}`;
}

/** Formata um `Date` pro timestamp usado em `buildBackupFileName` — dígitos
 * só, ordena lexicograficamente igual a cronologicamente. Pura (recebe o
 * `Date`, não lê o relógio). */
export function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Dado o basename do arquivo de config e a lista de nomes na mesma pasta
 * (já resolvida pelo caller via `readdirSync` — este módulo não toca
 * disco), devolve o nome de backup mais recente (ordem lexicográfica —
 * válida porque `formatBackupTimestamp` produz timestamps que ordenam
 * assim) ou `undefined` se não houver nenhum. Usado pelo modo `--revert`
 * sem `--backup` explícito.
 */
export function findMostRecentBackup(basename: string, filesInDir: readonly string[]): string | undefined {
  const prefix = `${basename}.bak-`;
  const candidates = filesInDir.filter((f) => f.startsWith(prefix));
  if (candidates.length === 0) return undefined;
  // NÃO ordenar pela string do nome inteiro: `<motivo>` vem ANTES do
  // timestamp no nome (`<basename>.bak-<motivo>-<data>`), então ordenar
  // pelo nome completo ordena por MOTIVO primeiro (alfabético) — um backup
  // "a-..." de HOJE perderia pra um "b-..." de ONTEM. `slugifyMotivo` nunca
  // deixa hífen nas pontas e `formatBackupTimestamp` nunca produz hífen —
  // então o timestamp é sempre o trecho depois do ÚLTIMO `-` do nome.
  const withTimestamp = candidates.map((f) => ({ file: f, timestamp: f.slice(f.lastIndexOf("-") + 1) }));
  withTimestamp.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return withTimestamp[withTimestamp.length - 1].file;
}

export interface RedactionResult {
  readonly redacted: string;
  /** Chaves de `sensitiveKeys` que de fato casaram com ao menos 1 linha —
   * o CLI usa isto pro resumo ("redigiu password_hash, token; api_key não
   * apareceu no arquivo"), útil pra quem revisar o eco confirmar que a
   * redação tocou o que esperava. */
  readonly matchedKeys: readonly string[];
}

/**
 * Redige valores de chaves sensíveis num texto YAML — line-based (não
 * parseia o YAML de verdade, o repo não tem parser YAML como dependência
 * hoje — ver docstring do CLI). Casa `<indentação>chave:<resto da linha>`
 * contra `sensitiveKeys` (nome da chave = trecho entre a indentação e o
 * primeiro `:`, comparado case-insensitive); substitui o resto da linha
 * por ` <redacted>`. Linhas que não têm esse formato (comentários, listas,
 * blocos multi-linha) passam intactas — `redactConfigText` é
 * deliberadamente conservador: prefere deixar uma linha ambígua como está
 * a arriscar corromper YAML válido tentando reescrevê-lo estruturalmente.
 */
export function redactConfigText(text: string, sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_CONFIG_KEYS): RedactionResult {
  const keysLower = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const matched = new Set<string>();
  const lines = text.split("\n").map((line) => {
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!m) return line;
    const [, indent, key, rest] = m;
    if (!keysLower.has(key.toLowerCase())) return line;
    // Valor vazio (bloco YAML aninhado abaixo, ex: `token:` seguido de
    // sub-chaves) não tem nada a redigir nesta linha — deixa como está,
    // as sub-chaves (se também sensíveis por nome) são redigidas por si.
    if (rest.trim().length === 0) return line;
    matched.add(sensitiveKeys.find((k) => k.toLowerCase() === key.toLowerCase()) ?? key);
    return `${indent}${key}: <redacted>`;
  });
  return { redacted: lines.join("\n"), matchedKeys: [...matched] };
}
