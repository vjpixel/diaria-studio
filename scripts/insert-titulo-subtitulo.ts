#!/usr/bin/env tsx
/**
 * insert-titulo-subtitulo.ts (#916)
 *
 * Insere ou atualiza, no topo do `02-reviewed.md`, uma seção:
 *
 *   TÍTULO
 *
 *   {título de D1}
 *
 *   SUBTÍTULO
 *
 *   {título de D2} | {título de D3}
 *
 *   ---
 *
 * Stage 4 (publicação Beehiiv) precisa dessa info pra preencher subject line
 * e preview text. Sem o bloco no topo do MD, isso vira trabalho manual do
 * editor todo dia. Render automatizado depois do gate Stage 2 elimina o
 * passo + reduz risco de typo.
 *
 * Uso:
 *   npx tsx scripts/insert-titulo-subtitulo.ts \
 *     --in data/editions/AAMMDD/02-reviewed.md
 *     [--out data/editions/AAMMDD/02-reviewed.md]
 *
 * `--out` defaulta a `--in` (in-place). Idempotente: re-rodar com mesmo
 * input → output igual ao anterior (sem duplicar a seção).
 *
 * Exit codes:
 *   0  OK (inserido, atualizado ou no-change)
 *   1  Erro (input ausente, parse falhou, sem D1/D2/D3 reconhecíveis)
 *
 * Output JSON em stdout: `{ action, d1_title, d2_title, d3_title, path }`.
 *
 * Edge cases tratados:
 * - Apenas 2 destaques (sem D3): SUBTÍTULO usa só o título de D2 (sem ` | `).
 * - Apenas 1 destaque: SUBTÍTULO em branco (renderizado vazio).
 * - Pré-gate (3 opções de título por destaque): usa a primeira opção como D1
 *   (parseDestaques retorna o primeiro `looksLikeTitleOption`).
 *
 * Falha de parse vira exit 1 — caller decide se bloqueia (writer ainda
 * gerando) ou só warn (skill `/diaria-2-escrita` trata como warning per
 * issue spec).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseDestaques, type Destaque } from "./extract-destaques.ts";

const TITULO_HEADER = "TÍTULO";
const SUBTITULO_HEADER = "SUBTÍTULO";

/**
 * Pure: detecta se o MD já começa com um bloco TÍTULO/SUBTÍTULO. Procura
 * dentro das primeiras N linhas não-vazias (default 30) — sem isso um
 * "TÍTULO" mencionado lá embaixo no body acionaria atualização incorreta.
 */
export function hasTituloSubtituloBlock(md: string, scanLines = 30): boolean {
  const lines = md.split("\n").slice(0, scanLines);
  return lines.some((l) => l.trim() === TITULO_HEADER);
}

/**
 * Pure: compõe o bloco TÍTULO/SUBTÍTULO a partir dos títulos.
 *
 * Layout (sem markdown — output final do MD não tem `**`/`#`/`-`):
 *
 *   TÍTULO
 *
 *   {d1}
 *
 *   SUBTÍTULO
 *
 *   {d2} | {d3}
 *
 *   ---
 */
export function renderTituloSubtituloBlock(
  d1Title: string,
  d2Title: string,
  d3Title: string,
): string {
  const subtitleParts = [d2Title, d3Title].filter((t) => t.trim().length > 0);
  const subtitle = subtitleParts.join(" | ");
  const lines = [
    TITULO_HEADER,
    "",
    d1Title,
    "",
    SUBTITULO_HEADER,
    "",
    subtitle,
    "",
    "---",
    "",
  ];
  return lines.join("\n");
}

/**
 * Pure: insere ou atualiza o bloco TÍTULO/SUBTÍTULO no topo do MD. Idempotente.
 *
 * Estratégia:
 * - Se já existe bloco no topo (header `TÍTULO` nas primeiras 30 linhas):
 *   substituir do início até o primeiro `---` (inclusive) pelo bloco novo.
 * - Se não existe: prepend ao MD inteiro.
 *
 * Frontmatter YAML (`---\n...\n---`) no topo: o bloco entra DEPOIS do
 * frontmatter, antes do primeiro conteúdo. Detecta por linha 1 = `---`.
 *
 * Retorna `{ md, action }` onde `action ∈ "inserted" | "updated" | "no_change"`.
 */
export function insertOrUpdateTituloSubtitulo(
  md: string,
  d1Title: string,
  d2Title: string,
  d3Title: string,
): { md: string; action: "inserted" | "updated" | "no_change" } {
  const block = renderTituloSubtituloBlock(d1Title, d2Title, d3Title);

  // Frontmatter detection: linha 1 = `---` indica YAML front-matter.
  // Pular o frontmatter inteiro quando inserindo/substituindo.
  let frontmatterEnd = 0;
  const lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        frontmatterEnd = i + 1;
        // pular newlines em branco depois do frontmatter
        while (frontmatterEnd < lines.length && lines[frontmatterEnd].trim() === "") {
          frontmatterEnd++;
        }
        break;
      }
    }
  }

  const beforeBody = lines.slice(0, frontmatterEnd).join("\n");
  const body = lines.slice(frontmatterEnd).join("\n");

  let newBody: string;
  let hadExisting = false;

  if (hasTituloSubtituloBlock(body)) {
    hadExisting = true;
    // Substitui do início do body até o primeiro `---` (inclusive) + linhas em branco subsequentes.
    const bodyLines = body.split("\n");
    let endIdx = -1;
    for (let i = 0; i < Math.min(bodyLines.length, 30); i++) {
      if (bodyLines[i].trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) {
      // bloco existe mas sem `---` terminador — substitui só o header e até a próxima
      // linha em branco após a linha de subtitulo (heurística defensiva).
      // Esse caminho é raro (bloco corrompido); preferimos manter conteúdo.
      newBody = block + body;
    } else {
      // pular linhas em branco subsequentes depois do `---`
      let after = endIdx + 1;
      while (after < bodyLines.length && bodyLines[after].trim() === "") after++;
      const remaining = bodyLines.slice(after).join("\n");
      newBody = block + remaining;
    }
  } else {
    // Prepend
    newBody = block + body;
  }

  const out = beforeBody
    ? beforeBody + (beforeBody.endsWith("\n") ? "" : "\n") + newBody
    : newBody;

  if (out === md) return { md, action: "no_change" };
  return { md: out, action: hadExisting ? "updated" : "inserted" };
}

/**
 * Pure: extrai os títulos D1/D2/D3 do MD. Retorna `null` em campos faltantes
 * (caller decide se erro ou rendering parcial).
 *
 * Observação pré-gate: writer entrega 3 opções de título por destaque
 * (linhas inline-link separadas). `parseDestaques` extrai a primeira
 * opção como `title` — comportamento existente, e o que queremos pra
 * pré-gate. Pós-gate: já só tem 1 título por destaque.
 */
export function extractTitlesFromMd(md: string): {
  d1: string | null;
  d2: string | null;
  d3: string | null;
} {
  const destaques = parseDestaques(md);
  const byN = new Map<number, Destaque>();
  for (const d of destaques) byN.set(d.n, d);
  return {
    d1: byN.get(1)?.title ?? null,
    d2: byN.get(2)?.title ?? null,
    d3: byN.get(3)?.title ?? null,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) {
    console.error(
      "Uso: insert-titulo-subtitulo.ts --in <md-path> [--out <md-path>]",
    );
    process.exit(1);
  }
  const inPath = resolve(ROOT, args.in);
  const outPath = args.out ? resolve(ROOT, args.out) : inPath;
  if (!existsSync(inPath)) {
    console.error(`Arquivo não existe: ${inPath}`);
    process.exit(1);
  }
  const md = readFileSync(inPath, "utf8");

  const { d1, d2, d3 } = extractTitlesFromMd(md);
  if (!d1) {
    console.error(
      "Nenhum DESTAQUE 1 reconhecível em " +
        inPath +
        " — verifique formato (DESTAQUE 1 | CATEGORIA + título logo abaixo).",
    );
    process.exit(1);
  }

  const { md: updated, action } = insertOrUpdateTituloSubtitulo(
    md,
    d1,
    d2 ?? "",
    d3 ?? "",
  );
  if (action !== "no_change") {
    writeFileSync(outPath, updated, "utf8");
  }

  const result = {
    action,
    d1_title: d1,
    d2_title: d2,
    d3_title: d3,
    path: outPath,
  };
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
