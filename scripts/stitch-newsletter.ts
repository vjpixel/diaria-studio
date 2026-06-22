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
import { looksEnglish } from "./lib/lang-detect.ts"; // #1790 (era inline divergente)
import {
  estimateUseMelhorTempo,
  normalizeDashToParens,
} from "./lib/use-melhor-curation.ts"; // #2447/#2450
import { USE_MELHOR_TEMPO_RE } from "./lib/lint-checks/use-melhor-tempo.ts"; // #2464 finding 5 — evitar cópia de regex

interface ArticleLike {
  url?: string;
  title?: string;
  summary?: string;
  summary_lang?: string;
}

// #1790: looksEnglish unificado no lib canônico (./lib/lang-detect.ts, importado
// no topo) — usado abaixo só pra marcar [TRADUZIR] na DESCRIÇÃO de itens EN
// (o título sai sempre verbatim, #1634).

interface ApprovedJsonShape {
  coverage?: { line?: string };
  highlights?: Array<{ article: ArticleLike }>;
  lancamento?: ArticleLike[];
  // #1629: buckets renomeados
  radar?: ArticleLike[];
  use_melhor?: ArticleLike[];
  video?: ArticleLike[];
}

const FIXED_BLOCKS = {
  sorteio: `**🎁 SORTEIO**

Você presta atenção ao conteúdo gerado por IA que consome? Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição.

**Responda indicando qual é o erro, ou se não há nenhum, e receba um número para concorrer a uma caneca da Diar.ia, a ser sorteada mês que vem.** Sua resposta deve chegar até mim antes do envio da edição seguinte.`,

  para_encerrar: `**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

- [Cursos de IA](https://cursos.diaria.workers.dev)
- [Livros sobre IA](https://livros.diaria.workers.dev)

Agora que chegou ao final da edição, que tal interagir em uma publicação no [LinkedIn](https://www.linkedin.com/company/diaria/) ou no [Facebook](https://www.facebook.com/diar.ia.br)? Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante!`,

  erro_intencional_placeholder: `**ERRO INTENCIONAL**

{placeholder, script render-erro-intencional.ts substitui pós-Clarice}

Esta edição tem um erro proposital. Responda este e-mail com a correção para concorrer ao sorteio mensal.`,
};

/**
 * #1938: carrega o bloco canônico de divulgação CLARICE (`**📣 …**`) de
 * `context/snippets/clarice-divulgacao.md` — fonte ÚNICA reaproveitada na
 * diária (midCallout) e na mensal. Strip do comentário HTML de header; retorna
 * o bloco `**📣 …**` trimado, ou `null` se o arquivo não existir / não tiver o
 * marcador (graceful — daily sai sem sponsor em vez de quebrar).
 */
export function loadClariceCallout(): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const p = join(root, "context", "snippets", "clarice-divulgacao.md");
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  // Exige o bloco bold-wrapped iniciado por 📣 (mesmo que extractMidCallout casa).
  const m = raw.match(/\*\*\s*📣[\s\S]+?\*\*/);
  return m ? m[0].trim() : null;
}

/**
 * Renderiza uma section secundária (USE MELHOR/LANÇAMENTOS/RADAR/VÍDEOS)
 * com emoji prefix + items em formato canonical `[**title**](url)` + summary.
 *
 * Singular vs plural conforme `count` (#1324).
 *
 * #1855: USE MELHOR deixou de ser PT-only (revert do #1632). Tutoriais EN agora
 * aparecem como em qualquer outra seção secundária — título verbatim + [TRADUZIR]
 * na descrição EN. A grande maioria de cookbooks de qualidade é em inglês;
 * descartá-los esvaziava a seção recorrentemente (#1851).
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
    // #1697/#1634: o TÍTULO de item de seção secundária sai SEMPRE no idioma
    // original — nunca prefixar [TRADUZIR] no título. O prefixo no título induzia
    // o orchestrator a traduzir o título no pre-gate, violando #1634 (preservar o
    // nome original do recurso). O título do recurso fica verbatim.
    lines.push(`**[${a.title}](${a.url})**  `);
    if (a.summary) {
      // #1697: a DESCRIÇÃO pode ser PT (#1634). Se o summary está em EN, marcar
      // [TRADUZIR] só na descrição — o writer/editor traduz a descrição e remove
      // o prefixo, mantendo o título original. Detecção pelo summary (não pelo
      // título): um recurso de título EN com descrição PT não deve ser marcado.
      // #1790: minWords:4 preserva o bar baixo da impl antiga do stitch — sem
      // isso, summary EN curto (4-9 palavras) deixava de ganhar [TRADUZIR].
      const summaryIsEn = a.summary_lang === "en" || looksEnglish(a.summary, { minWords: 4 });
      const descPrefix = summaryIsEn ? "[TRADUZIR] " : "";
      lines.push(descPrefix + cleanSummary(a.summary, a.title));
    }
    lines.push("");
  }
  // Remove trailing blank
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * #2447/#2450: Renderiza a seção USE MELHOR com injeção automática de estimativa
 * de tempo `(X min)` quando a descrição ainda não tem tempo.
 *
 * Diferenças em relação a `renderSection` genérico:
 *   1. Detecta se a descrição já contém tempo → não injeta duplicata.
 *   2. Se não tem tempo → appenda `estimateUseMelhorTempo(title, url)` ao fim.
 *   3. Normaliza `— X min` → `(X min)` (formato canônico, #2450).
 *
 * O editor pode ajustar a estimativa no gate Stage 2 → Stage 4. O lint
 * `use-melhor-tempo` (Stage 4, error) garante que nenhum item chegue sem tempo.
 *
 * Finding 3 (#2464): retorna "" quando TODOS os items são inválidos (sem url/title).
 * Sem esse guard, o header "🛠️ USE MELHOR" seria emitido órfão sem itens.
 */
export function renderUseMelhorSection(items: ArticleLike[]): string {
  if (items.length === 0) return "";
  const header = `**🛠️ USE MELHOR**`;
  const lines: string[] = [header, ""];
  let validCount = 0;
  for (const a of items) {
    if (!a.url || !a.title) continue;
    validCount++;
    lines.push(`**[${a.title}](${a.url})**  `);
    if (a.summary) {
      const summaryIsEn = a.summary_lang === "en" || looksEnglish(a.summary, { minWords: 4 });
      const descPrefix = summaryIsEn ? "[TRADUZIR] " : "";
      // #2464 finding 4: cleanSummary pode retornar "" — evitar espaço à esquerda.
      const cleanedSummary = cleanSummary(a.summary, a.title);
      let desc = cleanedSummary ? descPrefix + cleanedSummary : "";

      // #2450: normalizar `— X min` → `(X min)` primeiro (atalho editorial)
      desc = normalizeDashToParens(desc);

      // #2447: injetar estimativa auto se não tiver nenhuma.
      // USE_MELHOR_TEMPO_RE importado do lint (finding 5 #2464 — sem cópia duplicada).
      if (!USE_MELHOR_TEMPO_RE.test(desc)) {
        const estimate = estimateUseMelhorTempo(a.title, a.url);
        desc = desc ? `${desc.trimEnd()} ${estimate}` : estimate;
      }

      lines.push(desc);
    } else {
      // Sem summary: injetar placeholder de tempo mínimo para o lint não bloquear.
      // O editor vai preencher a descrição + ajustar o tempo no gate.
      const estimate = estimateUseMelhorTempo(a.title, a.url);
      lines.push(`[DESCRIÇÃO PENDENTE] ${estimate}`);
    }
    lines.push("");
  }
  // Finding 3 (#2464): se todos os items eram inválidos (sem url/title), retornar
  // string vazia em vez de emitir o header órfão "**🛠️ USE MELHOR**".
  if (validCount === 0) return "";
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
  /** #2343: D3 é opcional. Ausente quando destaque_count == 2 (2-destaque edition). */
  d3Path?: string | null;
  approvedCappedPath: string;
  editionDir: string;
  /** #1938: injeta o midCallout de divulgação CLARICE entre D1 e D2. Default
   * `true` (todo daily — decisão editorial). Kill-switch: `false` / `--no-sponsor`. */
  sponsor?: boolean;
}

export function stitchNewsletter(input: StitchInput): string {
  // #2343: D3 is optional for 2-destaque editions. Required paths = d1, d2, approvedCapped.
  const requiredReads = [input.d1Path, input.d2Path, input.approvedCappedPath];
  for (const p of requiredReads) {
    if (!existsSync(p)) {
      throw new Error(`stitch: input ausente: ${p}`);
    }
  }
  const d1 = readFileSync(input.d1Path, "utf8").trim();
  const d2 = readFileSync(input.d2Path, "utf8").trim();
  // #2343: D3 is present only for 3-destaque editions.
  const d3: string | null = (input.d3Path != null && existsSync(input.d3Path))
    ? readFileSync(input.d3Path, "utf8").trim()
    : null;
  // If d3Path is provided but missing, crash loudly (caller passed wrong path).
  if (input.d3Path != null && d3 === null) {
    throw new Error(`stitch: input ausente: ${input.d3Path}`);
  }
  // #2355 fix 1: required draft files must not be empty/whitespace-only —
  // an empty destaque block produces a bare `---` in the output (silently corrupt edition).
  // D1 and D2 are always required; D3 only when d3Path is provided.
  if (!d1) throw new Error(`stitch: 02-d1-draft.md vazio: ${input.d1Path}`);
  if (!d2) throw new Error(`stitch: 02-d2-draft.md vazio: ${input.d2Path}`);
  if (input.d3Path != null && d3 === "") {
    throw new Error(`stitch: 02-d3-draft.md vazio (esperado para edição de 3 destaques): ${input.d3Path}`);
  }
  // #2355 fix 2: wrap parse to give a diagnostic when the capped JSON is corrupt.
  let approved: ApprovedJsonShape;
  try {
    approved = JSON.parse(readFileSync(input.approvedCappedPath, "utf8")) as ApprovedJsonShape;
  } catch (parseErr) {
    throw new Error(`stitch: approved-capped.json corrompido (parse falhou): ${input.approvedCappedPath} — ${(parseErr as Error).message}`);
  }

  const coverageLine = approved.coverage?.line ??
    "Para esta edição, eu (o editor) enviei N submissões e a Diar.ia encontrou outros M artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter.";

  const eiaBlock = readEiaBlock(input.editionDir);

  // #1752: USE MELHOR (bucket use_melhor) era tipado mas NUNCA renderizado —
  // a seção sumia da newsletter mesmo com conteúdo selecionado pelo scorer.
  // Ordem: USE MELHOR vem ANTES de LANÇAMENTOS (decisão editorial 260603).
  // #1855: tutoriais EN agora aparecem (revert do PT-only #1632) — mesma regra
  // [TRADUZIR]-na-descrição das demais seções. O mínimo de 2 itens é garantido
  // upstream pelo promoteUseMelhorToMinimum em apply-stage2-caps.
  // #2447/#2450: USE MELHOR recebe tratamento especial — injetar estimativa de
  // tempo auto-gerada `(X min)` quando a descrição ainda não tem tempo, e
  // normalizar `— X min` → `(X min)` para garantir formato canônico de parênteses.
  const useMelhor = renderUseMelhorSection(approved.use_melhor ?? []);
  const lancamentos = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", approved.lancamento ?? []);
  // #1569 / #1629: RADAR é bucket único (Pesquisas + Outras Notícias fundidos
  // no categorize.ts). Editor pode re-ordenar no gate Stage 2.
  const radar = renderSection("📡", "RADAR", "RADAR", approved.radar ?? []);
  const videos = renderSection("📺", "VÍDEO", "VÍDEOS", approved.video ?? []);

  // #1938: midCallout de divulgação CLARICE entre D1 e D2, isolado entre dois
  // `---` (posição que extractMidCallout procura; #1972 garante de-dup no render).
  // Idempotente: pula se D1/D2 já trazem um `**📣 …**` (editor já colou à mão, ou
  // re-run). Kill-switch: sponsor=false. Graceful: snippet ausente → sem callout.
  const wantSponsor = input.sponsor !== false;
  // Code-review #1938: casa QUALQUER marcador de callout (📣/📚/🎉), não só 📣 —
  // se um 📚 (livros) ou 🎉 (sorteio) já estiver na região do D1, um 2º callout
  // 📣 criaria dois midCallouts (extractMidCallout só renderiza o 1º, o outro
  // orfana). Qualquer callout pré-existente suprime a injeção.
  const calloutRe = /\*\*\s*(?:📣|📚|🎉)/;
  const alreadyHasCallout = calloutRe.test(d1) || calloutRe.test(d2);
  const clariceCallout = wantSponsor && !alreadyHasCallout ? loadClariceCallout() : null;

  const parts: string[] = [
    coverageLine,
    "",
    "---",
    "",
    d1,
    "",
    "---",
    "",
  ];
  if (clariceCallout) {
    parts.push(clariceCallout, "", "---", "");
  }
  parts.push(
    d2,
    "",
    "---",
    "",
    eiaBlock,
    "",
    "---",
    "",
  );
  // #2343: D3 is optional. For 2-destaque editions, omit the D3 block entirely.
  if (d3 !== null) {
    parts.push(
      d3,
      "",
      "---",
      "",
    );
  }

  // #1752: USE MELHOR antes de LANÇAMENTOS (decisão editorial 260603).
  if (useMelhor) {
    parts.push(useMelhor);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  if (lancamentos) {
    parts.push(lancamentos);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  // #1569: PESQUISAS + OUTRAS NOTÍCIAS combinadas em RADAR.
  if (radar) {
    parts.push(radar);
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
    // #2343: detect destaque_count from approved-capped.json to determine if D3 exists.
    // #2355 fix 2: report missing/corrupt capped JSON explicitly — don't mask it as a
    // missing D3 draft. Previously: absent → destaqueCount=3 → d3Path set → stitch
    // throws "input ausente: 02-d3-draft.md" (wrong diagnosis). Now: absent/corrupt
    // throws immediately with the real cause.
    const approvedCappedPath = join(editionDir, "_internal", "01-approved-capped.json");
    if (!existsSync(approvedCappedPath)) {
      throw new Error(`stitch: approved-capped.json ausente — execute o Stage 1 antes: ${approvedCappedPath}`);
    }
    let destaqueCount = 3; // default when highlights field is absent (valid)
    try {
      const approved = JSON.parse(readFileSync(approvedCappedPath, "utf8")) as { highlights?: unknown[] };
      if (Array.isArray(approved.highlights)) {
        destaqueCount = approved.highlights.length;
      }
    } catch (parseErr) {
      // #2355 fix 2: parse failure → fail loud with the capped JSON as the cause.
      throw new Error(`stitch: approved-capped.json corrompido (parse falhou): ${approvedCappedPath} — ${(parseErr as Error).message}`);
    }
    // #2343: D3 existe SOMENTE em edições de exatamente 3 destaques. `=== 3`
    // (não `>= 3`): um count corrompido de 4+ que escape do invariant Stage-1
    // não deve silenciosamente virar edição de 3 destaques — fica null e o
    // stitch falha alto no check de arquivo requerido, em vez de dropar o 4º.
    const d3Path = destaqueCount === 3
      ? join(editionDir, "_internal", "02-d3-draft.md")
      : null;

    const out = stitchNewsletter({
      d1Path: join(editionDir, "_internal", "02-d1-draft.md"),
      d2Path: join(editionDir, "_internal", "02-d2-draft.md"),
      d3Path,
      approvedCappedPath,
      editionDir,
      // #1938: kill-switch — `--no-sponsor` pula o midCallout da Clarice.
      sponsor: values["no-sponsor"] ? false : true,
    });
    const outPath = join(editionDir, "_internal", "02-draft.md");
    writeFileSync(outPath, out);
    console.log(JSON.stringify({ out_path: outPath, bytes: out.length, destaque_count: destaqueCount }, null, 2));
  } catch (e) {
    console.error(`[stitch-newsletter] erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const isDirectRun = /\/scripts\/stitch-newsletter\.ts$/.test(_argv1);
if (isDirectRun) main();
