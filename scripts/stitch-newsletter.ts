#!/usr/bin/env npx tsx
/**
 * stitch-newsletter.ts (#1463)
 *
 * Une os 3 destaque drafts (`_internal/02-d{1,2,3}-draft.md` — output do
 * `writer-destaque` em paralelo) em `_internal/02-draft.md` final, injetando
 * seções secundárias (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) do
 * `01-approved-capped.json`, o bloco É IA? do `01-eia.md`, e blocos fixos
 * (ERRO INTENCIONAL + SORTEIO + PARA ENCERRAR) do template.
 *
 * Substitui a responsabilidade que estava na orchestrator inline.
 * Determinístico — sem LLM call.
 *
 * Uso:
 *   npx tsx scripts/stitch-newsletter.ts --edition-dir data/editions/AAMMDD/
 *
 * Exit codes:
 *   0 — stitch ok
 *   1 — input faltando (algum destaque draft, approved-capped JSON)
 *   2 — uso inválido (args)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { cleanSummary } from "./lib/clean-summary.ts";

interface ArticleLike {
  url?: string;
  title?: string;
  summary?: string;
}

interface ApprovedJsonShape {
  coverage?: { line?: string };
  highlights?: Array<{ article: ArticleLike }>;
  lancamento?: ArticleLike[];
  pesquisa?: ArticleLike[];
  noticias?: ArticleLike[];
  video?: ArticleLike[];
}

const FIXED_BLOCKS = {
  sorteio: `**🎁 SORTEIO**

Você presta atenção ao conteúdo gerado por IA que consome? Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição.

**Responda indicando qual é o erro, ou se não há nenhum, e receba um número para concorrer a [um livro sobre IA entre os que recomendamos](https://diaria.beehiiv.com/livros-sobre-ia), a ser sorteado mês que vem.** Sua resposta deve chegar até mim antes do envio da edição seguinte.`,

  para_encerrar: `**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe 25% de desconto com o cupom DIARIA](https://clarice.ai/?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

**Acesse:**

- [Melhores cursos grátis de IA](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)
- [Curadoria de livros sobre IA](https://diaria.beehiiv.com/livros-sobre-ia)

Agora que chegou ao final da edição, que tal interagir em uma publicação no [LinkedIn](https://www.linkedin.com/company/diaria/) ou no [Facebook](https://www.facebook.com/diar.ia.br)? Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante!`,

  erro_intencional_placeholder: `**ERRO INTENCIONAL**

{placeholder, script render-erro-intencional.ts substitui pós-Clarice}

Esta edição tem um erro proposital. Responda este e-mail com a correção para concorrer ao sorteio mensal de livros.`,
};

/**
 * Renderiza uma section secundária (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS)
 * com emoji prefix + items em formato canonical `[**title**](url)` + summary.
 *
 * Singular vs plural conforme `count` (#1324).
 */
export function renderSection(
  emoji: string,
  nameSingular: string,
  namePlural: string,
  items: ArticleLike[],
): string {
  if (items.length === 0) return "";
  const header = items.length === 1
    ? `**${emoji} ${nameSingular}**`
    : `**${emoji} ${namePlural}**`;
  const lines: string[] = [header, ""];
  for (const a of items) {
    if (!a.url || !a.title) continue;
    // Format canonical: **[title](url)** (bold OUTSIDE link), conforme
    // context/templates/newsletter.md + edições publicadas. Review fix #1463
    // — antes era [**title**](url) (bold INSIDE) que divergia do template.
    lines.push(`**[${a.title}](${a.url})**  `);
    if (a.summary) {
      // #1493: clean scraped meta descriptions — strip arXiv prefix,
      // remove unrelated sentences, truncate to 200 chars.
      lines.push(cleanSummary(a.summary, a.title));
    }
    lines.push("");
  }
  // Remove trailing blank
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Lê o bloco É IA? do `01-eia.md`. Se ausente, retorna placeholder simples.
 * Format do 01-eia.md:
 *   "É IA?\n\n{description}\n\n> Gabarito: **{A|B} é a IA**"
 */
function readEiaBlock(editionDir: string): string {
  const path = join(editionDir, "01-eia.md");
  if (!existsSync(path)) {
    return "É IA?\n\n[É IA? ainda processando — bloco será inserido na Etapa 3]";
  }
  let content = readFileSync(path, "utf8");
  // Strip YAML frontmatter (writer single faz o mesmo — eia_answer fica
  // sidecar, NÃO entra no MD final). Sem isso, 02-draft.md sai com
  // `eia_answer:` raw entre D2 e D3. Review fix #1463.
  const fmMatch = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (fmMatch) {
    content = content.slice(fmMatch[0].length);
  }
  return content.trim();
}

interface StitchInput {
  d1Path: string;
  d2Path: string;
  d3Path: string;
  approvedCappedPath: string;
  editionDir: string;
}

export function stitchNewsletter(input: StitchInput): string {
  const reads = [input.d1Path, input.d2Path, input.d3Path, input.approvedCappedPath];
  for (const p of reads) {
    if (!existsSync(p)) {
      throw new Error(`stitch: input ausente: ${p}`);
    }
  }
  const d1 = readFileSync(input.d1Path, "utf8").trim();
  const d2 = readFileSync(input.d2Path, "utf8").trim();
  const d3 = readFileSync(input.d3Path, "utf8").trim();
  const approved = JSON.parse(readFileSync(input.approvedCappedPath, "utf8")) as ApprovedJsonShape;

  const coverageLine = approved.coverage?.line ??
    "Para esta edição, eu (o editor) enviei N submissões e a Diar.ia encontrou outros M artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter.";

  const eiaBlock = readEiaBlock(input.editionDir);

  const lancamentos = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", approved.lancamento ?? []);
  const pesquisas = renderSection("🔬", "PESQUISA", "PESQUISAS", approved.pesquisa ?? []);
  const noticias = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", approved.noticias ?? []);
  const videos = renderSection("📺", "VÍDEO", "VÍDEOS", approved.video ?? []);

  const parts: string[] = [
    coverageLine,
    "",
    "---",
    "",
    d1,
    "",
    "---",
    "",
    d2,
    "",
    "---",
    "",
    eiaBlock,
    "",
    "---",
    "",
    d3,
    "",
    "---",
    "",
  ];

  if (lancamentos) {
    parts.push(lancamentos);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  if (pesquisas) {
    parts.push(pesquisas);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  if (noticias) {
    parts.push(noticias);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  if (videos) {
    parts.push(videos);
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  parts.push(FIXED_BLOCKS.erro_intencional_placeholder);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(FIXED_BLOCKS.sorteio);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(FIXED_BLOCKS.para_encerrar);
  parts.push("");

  return parts.join("\n");
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: stitch-newsletter.ts --edition-dir data/editions/AAMMDD/");
    process.exit(2);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`[stitch-newsletter] dir não existe: ${editionDir}`);
    process.exit(1);
  }
  try {
    const out = stitchNewsletter({
      d1Path: join(editionDir, "_internal", "02-d1-draft.md"),
      d2Path: join(editionDir, "_internal", "02-d2-draft.md"),
      d3Path: join(editionDir, "_internal", "02-d3-draft.md"),
      approvedCappedPath: join(editionDir, "_internal", "01-approved-capped.json"),
      editionDir,
    });
    const outPath = join(editionDir, "_internal", "02-draft.md");
    writeFileSync(outPath, out);
    console.log(JSON.stringify({ out_path: outPath, bytes: out.length }, null, 2));
  } catch (e) {
    console.error(`[stitch-newsletter] erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const isDirectRun = /\/scripts\/stitch-newsletter\.ts$/.test(_argv1);
if (isDirectRun) main();
