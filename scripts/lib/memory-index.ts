/**
 * memory-index.ts (#7533)
 *
 * Funções puras para o par extrator/gerador do índice `MEMORY.md` (memória
 * de longo prazo do Claude Code, `~/.claude/projects/{slug}/memory/`).
 *
 * Problema que resolve: `MEMORY.md` é editado à mão em cada máquina e é o
 * único arquivo do acervo de memória que de fato colide entre sessões/
 * máquinas (interseção medida entre acervos de máquinas diferentes: só esse
 * arquivo, #7533). A curadoria (agrupamento de memórias relacionadas em
 * blocos, labels curtos, ordem editorial) é o valor real do arquivo — 82%
 * das linhas medidas agrupam 2+ memórias, e o `description` médio do
 * frontmatter (144 chars) é longo demais para virar label direto.
 *
 * Design (separar por frequência de mudança, ver corpo da issue #7533):
 *   - arquivos de memória (`*.md` individuais) mudam a toda hora → sincronizam
 *     via git, append-only, colisão rara;
 *   - manifesto de curadoria (`MemoryManifest`) muda raramente (reorganização
 *     manual) → sincroniza via git, conflito raro e resolvível;
 *   - `MEMORY.md` é DERIVADO dos dois → nunca sincronizado, sempre gerado
 *     localmente por `buildMemoryMd`.
 *
 * Memória nova (arquivo `.md` presente no diretório mas ausente de todo
 * `MemoryRef` do manifesto) nunca é escrita no manifesto automaticamente —
 * cai num bloco `## Recentes (não classificadas)` gerado no fim do arquivo,
 * preservando os blocos curados intactos byte a byte.
 *
 * Gramática de `MEMORY.md` (a única que este módulo entende — arquivos
 * legados fora deste formato precisam de migração manual antes de virar
 * fonte de round-trip):
 *
 *   # Memory index
 *   <linha em branco>
 *   - [label](arquivo.md) — descrição
 *   - [label1](arquivo1.md) + [label2](arquivo2.md) — descrição
 *   - Categoria: [label](arquivo.md) + [label2](arquivo2.md) — descrição
 *   <linha em branco>
 *   ## Nome do bloco opcional
 *   - [label](arquivo.md) — descrição
 *
 * A "Categoria: " antes da 1ª ref (#7692) é um prefixo opcional, delimitado
 * por ": " logo depois do "- " e antes do primeiro "[" — agrupamento inline
 * legado, sem uso em nenhum `MEMORY.md` do projeto hoje (o `## heading` de
 * bloco cobre o mesmo caso de uso). Suportado só para não travar o
 * round-trip se reaparecer.
 *
 * Blocos são separados por exatamente uma linha em branco (`\n\n` após
 * normalizar `\r\n`→`\n`). Um bloco pode abrir com um cabeçalho `## texto`
 * (sem linha em branco entre o cabeçalho e a primeira entrada). Cada
 * entrada é uma linha `- ` seguida de 1+ refs `[label](arquivo)` unidas por
 * ` + `, opcionalmente seguida de ` — descrição`.
 */

export interface MemoryRef {
  /** Texto do link markdown, ex: "Limite de uso da assinatura é o gargalo". */
  label: string;
  /** Nome do arquivo de memória referenciado (relativo ao diretório de memória). */
  file: string;
}

export interface MemoryLine {
  refs: MemoryRef[];
  /** Texto após " — ". String vazia quando a linha não tem descrição. */
  description: string;
  /**
   * Categoria opcional antes da 1ª ref, delimitada por ": " (ex: `Beehiiv/
   * editor: [autor vazio](arquivo.md)`), #7692. Formato legado de agrupamento
   * inline — hoje sem uso em nenhum `MEMORY.md` do projeto (o agrupamento
   * atual usa `## heading` de bloco, que já vira estrutura em vez de texto
   * dentro do bullet), mas suportado para o parser não travar o round-trip
   * caso reapareça. `undefined` quando a linha não tem prefixo.
   */
  prefix?: string;
  /**
   * Linha (ou bloco multi-linha) preservada verbatim, quando a entrada não é
   * um bullet `- [label](arquivo) — descrição` — hoje só comentário HTML
   * (`<!-- ... -->`, #7601). Quando presente, `refs`/`description` ficam
   * vazios e `renderLine` devolve `raw` sem modificação, byte a byte
   * (inclusive quebras de linha internas do comentário).
   */
  raw?: string;
}

export interface MemoryBlock {
  /** Texto do cabeçalho `## ...` sem o prefixo, se houver. */
  heading?: string;
  lines: MemoryLine[];
}

export interface MemoryManifest {
  /** Linha de título, ex: "# Memory index". */
  title: string;
  blocks: MemoryBlock[];
}

/** Campos de frontmatter de um arquivo de memória individual que este módulo consome. */
export interface MemoryFileFrontmatter {
  name?: string;
  description?: string;
  /** Label curto opcional para o índice (#7533 item 1) — nunca deriva do `name`, que é imutável e pode envelhecer para o oposto do conteúdo atual (ver issue). */
  index_label?: string;
}

/** Um arquivo de memória no diretório, com o frontmatter já parseado. */
export interface MemoryFileEntry {
  /** Nome do arquivo (ex: "foo-bar.md"), não o caminho completo. */
  filename: string;
  frontmatter: MemoryFileFrontmatter;
}

export const RECENTES_HEADING = "Recentes (não classificadas)";

const REF_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
/**
 * Grupo 1 (opcional): prefixo de categoria antes da 1ª ref, delimitado por
 * ": " — texto sem "[" seguido de dois-pontos+espaço, imediatamente antes do
 * primeiro `[label](arquivo)` (#7692). Grupo 2: refs. Grupo 3: descrição.
 */
const LINE_REGEX = /^- (?:([^[]+): )?((?:\[[^\]]+\]\([^)]+\)(?: \+ )?)+)(?: — (.*))?$/;

/**
 * Extrai o manifesto de curadoria a partir do conteúdo bruto de um
 * `MEMORY.md` existente. Puro — não lê arquivo, não sabe de disco.
 *
 * Lança se alguma linha não-vazia dentro de um bloco não casar a gramática
 * esperada (`- [label](file) [+ [label](file) ...] [— descrição]`, OU um
 * comentário HTML `<!-- ... -->`, tolerado desde #7601 e preservado verbatim
 * no round-trip) — falha alta é preferível a silenciosamente descartar uma
 * memória curada. O erro identifica o número da linha (1-based, dentro do
 * `MEMORY.md` inteiro) e o que era esperado, em vez de uma stack trace crua.
 */
export function extractManifest(raw: string): MemoryManifest {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const chunks = normalized.split("\n\n");
  if (chunks.length === 0 || !chunks[0].trim()) {
    throw new Error("MEMORY.md vazio ou sem linha de título");
  }
  const title = chunks[0];
  let consumed = title.split("\n").length; // nº de linhas (1-based) já consumidas pelo título
  const blocks: MemoryBlock[] = [];
  for (const chunk of chunks.slice(1)) {
    consumed += 1; // a linha em branco que separa este chunk do anterior
    const chunkStartLine = consumed + 1; // 1ª linha do chunk, 1-based
    if (chunk.trim().length > 0) {
      blocks.push(parseBlockChunk(chunk, chunkStartLine));
    }
    consumed += chunk.split("\n").length;
  }
  return { title, blocks };
}

function parseBlockChunk(chunk: string, chunkStartLine: number): MemoryBlock {
  const rawLines = chunk.split("\n");
  let heading: string | undefined;
  let bodyStart = 0;
  if (rawLines[0]?.startsWith("## ")) {
    heading = rawLines[0].slice(3);
    bodyStart = 1;
  }
  const lines: MemoryLine[] = [];
  let i = bodyStart;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    if (raw.length === 0) {
      i += 1;
      continue;
    }
    if (raw.trimStart().startsWith("<!--")) {
      const commentLines = [raw];
      let j = i;
      while (!commentLines[commentLines.length - 1].includes("-->") && j + 1 < rawLines.length) {
        j += 1;
        commentLines.push(rawLines[j]);
      }
      if (!commentLines[commentLines.length - 1].includes("-->")) {
        throw new Error(
          `MEMORY.md linha ${chunkStartLine + i}: comentário HTML aberto (\`<!--\`) sem fechamento ` +
            `(\`-->\`) até o fim do arquivo — esperado um comentário fechado na mesma seção.`,
        );
      }
      lines.push({ refs: [], description: "", raw: commentLines.join("\n") });
      i = j + 1;
      continue;
    }
    lines.push(parseLine(raw, chunkStartLine + i));
    i += 1;
  }
  return { heading, lines };
}

function parseLine(line: string, lineNumber: number): MemoryLine {
  const match = line.match(LINE_REGEX);
  if (!match) {
    throw new Error(
      `MEMORY.md linha ${lineNumber}: formato inesperado — esperado um bullet ` +
        `"- [label](arquivo.md) — descrição" (ou "+ [label](arquivo.md)" para múltiplas refs) ` +
        `ou um comentário HTML "<!-- ... -->". Recebido: ${JSON.stringify(line)}`,
    );
  }
  const prefix = match[1];
  const refsPart = match[2];
  const description = match[3] ?? "";
  const refs: MemoryRef[] = [];
  let m: RegExpExecArray | null;
  REF_REGEX.lastIndex = 0;
  while ((m = REF_REGEX.exec(refsPart))) {
    refs.push({ label: m[1], file: m[2] });
  }
  return prefix !== undefined ? { refs, description, prefix } : { refs, description };
}

function renderLine(line: MemoryLine): string {
  if (line.raw !== undefined) return line.raw;
  const refsStr = line.refs.map((r) => `[${r.label}](${r.file})`).join(" + ");
  // `!== undefined` e não truthy: mesma disciplina de `parseLine` e do
  // `line.raw !== undefined` logo abaixo nesta função (achado P3 do review
  // da PR #7796). Hoje `parseLine` nunca produz prefixo vazio, então os dois
  // se comportam igual — mas se um dia produzir, o truthy silenciosamente
  // DESCARTA o prefixo em vez de round-tripá-lo, que é exatamente a perda
  // que esta PR existe pra impedir.
  const prefixed = line.prefix !== undefined ? `${line.prefix}: ${refsStr}` : refsStr;
  return line.description ? `- ${prefixed} — ${line.description}` : `- ${prefixed}`;
}

function renderBlock(block: MemoryBlock): string {
  const parts: string[] = [];
  if (block.heading) parts.push(`## ${block.heading}`);
  parts.push(...block.lines.map(renderLine));
  return parts.join("\n");
}

/**
 * Regenera o texto de `MEMORY.md` a partir só do manifesto (sem considerar
 * arquivos novos/não classificados). Usado internamente por `buildMemoryMd`
 * e diretamente pelo teste de round-trip puro.
 */
export function generateMemoryMd(manifest: MemoryManifest): string {
  const blockTexts = manifest.blocks.map(renderBlock);
  return blockTexts.length > 0 ? `${manifest.title}\n\n${blockTexts.join("\n\n")}` : manifest.title;
}

/** Todos os nomes de arquivo já referenciados em qualquer bloco do manifesto. */
export function collectReferencedFilenames(manifest: MemoryManifest): Set<string> {
  const set = new Set<string>();
  for (const block of manifest.blocks) {
    for (const line of block.lines) {
      for (const ref of line.refs) set.add(ref.file);
    }
  }
  return set;
}

/**
 * Corta uma description longa na primeira fronteira natural (" — " ou ": "),
 * depois trunca em fronteira de palavra até `maxLen` chars. Ver decisão do
 * editor no comentário da issue #7533 (fallback de label, não fonte
 * primária — só exercido quando `index_label` está ausente do frontmatter).
 */
export function truncateForLabel(description: string, maxLen = 52): string {
  const emdashIdx = description.indexOf(" — ");
  const colonIdx = description.indexOf(": ");
  const candidates = [emdashIdx, colonIdx].filter((i) => i >= 0);
  let cut = candidates.length > 0 ? description.slice(0, Math.min(...candidates)) : description;
  cut = cut.trim();
  if (cut.length <= maxLen) return cut;
  const truncated = cut.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

/**
 * Deriva o label de índice de um arquivo de memória: `index_label` do
 * frontmatter tem prioridade; na ausência, primeiro segmento truncado da
 * `description`; na ausência de ambos, o nome do arquivo sem extensão.
 * Nunca deriva do `name` do frontmatter — decisão registrada na issue
 * #7533 (o `name` é imutável e pode envelhecer para o oposto do conteúdo
 * atual do arquivo).
 */
export function deriveIndexLabel(frontmatter: MemoryFileFrontmatter, filename: string): string {
  const explicit = frontmatter.index_label?.trim();
  if (explicit) return explicit;
  const description = frontmatter.description?.trim();
  if (description) return truncateForLabel(description);
  return filename.replace(/\.md$/, "");
}

/**
 * Gera o `MEMORY.md` final: blocos curados do manifesto, inalterados, mais
 * um bloco `## Recentes (não classificadas)` (append-only, sempre por
 * último) com qualquer arquivo de `files` que nenhum bloco do manifesto
 * referencia ainda. Quando não há arquivo não classificado, o resultado é
 * idêntico a `generateMemoryMd(manifest)` — é o invariante de round-trip
 * que os testes travam.
 *
 * Arquivos deliberadamente descartados da curadoria (ex: memória
 * transitória já resolvida) devem ser removidos do disco ou listados em
 * `discardedFilenames` — do contrário reaparecem em "Recentes" a cada
 * regeneração (achado ao vivo da unificação manual 260906, ver issue).
 */
export function buildMemoryMd(
  manifest: MemoryManifest,
  files: MemoryFileEntry[],
  options: { discardedFilenames?: readonly string[] } = {},
): string {
  const referenced = collectReferencedFilenames(manifest);
  const discarded = new Set(options.discardedFilenames ?? []);
  const unclassified = files.filter((f) => !referenced.has(f.filename) && !discarded.has(f.filename));

  if (unclassified.length === 0) {
    return generateMemoryMd(manifest);
  }

  const recentesLines: MemoryLine[] = unclassified
    .slice()
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((f) => ({
      refs: [{ label: deriveIndexLabel(f.frontmatter, f.filename), file: f.filename }],
      description: f.frontmatter.description?.trim() ?? "",
    }));

  const recentesBlock: MemoryBlock = { heading: RECENTES_HEADING, lines: recentesLines };
  const fullManifest: MemoryManifest = { title: manifest.title, blocks: [...manifest.blocks, recentesBlock] };
  return generateMemoryMd(fullManifest);
}

/**
 * Parser mínimo de frontmatter YAML — só extrai chaves de topo com valor na
 * mesma linha (`chave: valor`); ignora blocos aninhados (ex: `metadata:`
 * seguido de linhas indentadas) porque nenhum consumidor deste módulo
 * precisa deles. Não é um parser YAML geral — não usar fora do contexto de
 * arquivo de memória do Claude Code.
 */
export function parseMemoryFrontmatter(content: string): MemoryFileFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: MemoryFileFrontmatter = {};
  for (const line of match[1].split("\n")) {
    if (/^\s/.test(line) || !line.trim()) continue; // linha indentada = valor aninhado, pular
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (!value) continue; // "metadata: " (abre bloco aninhado) — sem valor de topo
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "index_label") {
      result[key] = value;
    }
  }
  return result;
}
