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
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { cleanSummary } from "./lib/clean-summary.ts";
import { looksEnglish } from "./lib/lang-detect.ts"; // #1790 (era inline divergente)
import {
  estimateUseMelhorTempo,
  normalizeDashToParens,
} from "./lib/use-melhor-curation.ts"; // #2447/#2450
import { USE_MELHOR_TEMPO_RE } from "./lib/lint-checks/use-melhor-tempo.ts"; // #2464 finding 5 — evitar cópia de regex
import { DIARIA_FACEBOOK_PAGE_URL, DIARIA_LINKEDIN_PAGE_URL } from "./lib/canonical-urls.ts"; // #2695/#2790 fonte única
import {
  splitEncerramentoSocialApoio,
  renderEncerramentoSocialApoio,
  ENCERRAMENTO_OPENING_DAILY,
} from "./lib/shared/encerramento-snippet.ts"; // #3219 fonte única (social + apoio Apoia.se), compartilhada com o mensal; split #3368 (reorder); renderEncerramentoSocialApoio #3382 fix (fallback de conteúdo real quando o split falha)
import { readSnippetFile } from "./lib/shared/snippet-loader.ts"; // #3219 leitura crua compartilhada com loadEncerramentoSocialApoioTemplate
import { extractBoxDivulgacao1 } from "./lib/newsletter-parse.ts"; // #3232 idempotência marcador-agnóstica (ver boxAlreadyPresentInGap)

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

  // #3219: cabeçalho da seção — fixo, sem parametrização, sempre o primeiro
  // elemento do bloco PARA ENCERRAR (#3368: o parágrafo de apoio entra
  // DEPOIS do cabeçalho, não antes — só a ordem dos parágrafos internos
  // mudou, o cabeçalho continua abrindo a seção).
  para_encerrar_header: `**🙋🏼‍♀️ PARA ENCERRAR**`,

  // #3219: parágrafo de ferramentas + pills "Acesse:" — fixos, sem
  // parametrização. O parágrafo de apoio (Apoia.se) + convite social
  // (LinkedIn/Facebook) vêm de `buildParaEncerrar()` abaixo, carregados do
  // snippet compartilhado com o mensal.
  para_encerrar_tools: `Nessa edição da **Diar.ia**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

- [Cursos de IA](https://cursos.diaria.workers.dev)
- [Livros sobre IA](https://livros.diaria.workers.dev)`,

  erro_intencional_placeholder: `**ERRO INTENCIONAL**

{placeholder, script render-erro-intencional.ts substitui pós-Clarice}

Esta edição tem um erro proposital. Responda este e-mail com a correção para concorrer ao sorteio mensal.`,
};

/**
 * #3219/#3368: monta o bloco PARA ENCERRAR completo — cabeçalho (fixo,
 * `FIXED_BLOCKS.para_encerrar_header`) + parágrafo de apoio (Apoia.se) +
 * parágrafo de ferramentas/pills "Acesse:" (fixo,
 * `FIXED_BLOCKS.para_encerrar_tools`) + convite social (LinkedIn/Facebook).
 * Apoio e convite social vêm de `context/snippets/encerramento-social-apoio.md`
 * via `splitEncerramentoSocialApoio` — fonte única compartilhada com o
 * mensal (mesmo texto aprovado pelo editor, ver comentário do snippet).
 *
 * Ordem (#3368, pedido do editor na edição 260713): cabeçalho > apoio >
 * ferramentas/Acesse, com o convite social como ÚLTIMO parágrafo da seção —
 * antes (#3219) a ordem era cabeçalho > ferramentas/Acesse > apoio > convite
 * social (só o cabeçalho não mudou de posição).
 *
 * `splitEncerramentoSocialApoio` retorna `null` em 2 situações BEM diferentes
 * (finding de self-review do #3382, thread em encerramento-snippet.ts:80):
 *   1. Arquivo ausente/vazio (`renderEncerramentoSocialApoio` também `null`)
 *      — nunca houve conteúdo real pra perder, cai no fallback hardcoded
 *      genérico (comportamento graceful original, #3219).
 *   2. Arquivo existe e RENDERIZOU, mas não tem exatamente 2 parágrafos
 *      separados por linha em branco (ex: editor fundiu apoio+social num só
 *      parágrafo). Antes deste fix, esse caso caía indistintamente no MESMO
 *      fallback hardcoded do caso 1 — descartando silenciosamente conteúdo
 *      real do editor só porque o reorder (#3368) não conseguiu separar os
 *      parágrafos. Agora usa o render INTEIRO, não-dividido, na posição
 *      ANTERIOR ao reorder (header > tools > render inteiro) — perde só o
 *      reorder (apoio não fica mais em primeiro), nunca o conteúdo.
 */
export function buildParaEncerrar(): string {
  const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
  if (split) {
    return `${FIXED_BLOCKS.para_encerrar_header}\n\n${split.apoio}\n\n${FIXED_BLOCKS.para_encerrar_tools}\n\n${split.socialInvite}`;
  }
  // Split falhou — distingue arquivo ausente (caso 1) de arquivo presente mas
  // com forma inesperada (caso 2, #3382).
  const whole = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
  if (whole) {
    return `${FIXED_BLOCKS.para_encerrar_header}\n\n${FIXED_BLOCKS.para_encerrar_tools}\n\n${whole}`;
  }
  const socialFallback = `Agora que chegou ao final da edição, que tal interagir em uma publicação no [LinkedIn](${DIARIA_LINKEDIN_PAGE_URL}) ou no [Facebook](${DIARIA_FACEBOOK_PAGE_URL})? Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante!`;
  return `${FIXED_BLOCKS.para_encerrar_header}\n\n${FIXED_BLOCKS.para_encerrar_tools}\n\n${socialFallback}`;
}

/**
 * #2978: carrega um bloco de divulgação de `context/snippets/{file}`,
 * format-agnóstico — aceita tanto o formato bold-line (`**📚/📣/🎉 …**`)
 * quanto o formato carrinho (`🛒 …`, multi-parágrafo com CTA, sem bold-wrap).
 * Strip do comentário HTML de header; retorna o bloco trimado, ou `null` se o
 * arquivo não existir / não tiver nenhum dos dois formatos (graceful — a
 * edição sai sem o box em vez de quebrar).
 *
 * Leitura crua (resolve root + readFileSync + strip comentário HTML + trim)
 * delegada a `readSnippetFile` (#3219 — extraído pra parar de duplicar essa
 * lógica em paralelo com `loadEncerramentoSocialApoioTemplate`); esta função
 * mantém só o pós-processamento específico de formato (marker bold-line vs
 * carrinho) por cima da leitura compartilhada.
 */
function loadDivulgacaoSnippet(file: string | null | undefined): string | null {
  if (!file) return null;
  const raw = readSnippetFile(file);
  if (!raw) return null;
  // Formato carrinho (🛒): texto cru, sem bold-wrap — igual ao que
  // BOX_DIVULGACAO_CART_RE (newsletter-parse.ts) espera no reviewed.md.
  if (raw.startsWith("🛒")) return raw;
  // Formato bold-line: bloco `**📚/📣/🎉 …**` (mesmo que extractBoxDivulgacao1/2 casa).
  const m = raw.match(/\*\*\s*(?:📚|📣|🎉)[\s\S]+?\*\*/);
  return m ? m[0].trim() : null;
}

/**
 * #2527: carrega o box de divulgação DIÁRIO default (slot 1, D1/D2) — bloco de
 * curadoria de LIVROS (`**📚 …**`) de `context/snippets/livros-divulgacao.md`.
 * Substituiu o bloco 📣 Clarice como padrão (decisão editorial). Graceful:
 * snippet ausente → null.
 */
export function loadDailyCallout(): string | null {
  return loadDivulgacaoSnippet("livros-divulgacao.md");
}

/**
 * #1938: bloco canônico de divulgação CLARICE (`**📣 …**`) — mantido para reuso
 * (mensal, ou troca pontual do callout diário). Não é mais o default diário (#2527).
 */
export function loadClariceCallout(): string | null {
  return loadDivulgacaoSnippet("clarice-divulgacao.md");
}

/**
 * #2978: shape da config `boxes_divulgacao` de `platform.config.json` — nome
 * do snippet (`context/snippets/{file}`) por slot, ou `null` pra slot vazio.
 */
export interface BoxesDivulgacaoConfig {
  slot1: string | null;
  slot2: string | null;
}

/**
 * #2978: lê `platform.config.json.boxes_divulgacao` — mapeia cada slot (1 =
 * gap D1/D2, 2 = gap D2/D3) pro nome do snippet a injetar. Back-compat: se a
 * chave `boxes_divulgacao` estiver AUSENTE do config inteiro, cai no
 * comportamento legado pré-#2978 (livros no slot 1, nada no slot 2) — edições
 * que nunca tocaram nesse config continuam funcionando sem mudança. Se a
 * chave existe mas um slot individual está ausente, esse slot é `null` (sem
 * cascata pro default legado — a presença da chave é um opt-in explícito pra
 * configuração granular).
 */
export function loadBoxesDivulgacaoConfig(): BoxesDivulgacaoConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const p = join(root, "platform.config.json");
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw.boxes_divulgacao && typeof raw.boxes_divulgacao === "object") {
      return {
        slot1: raw.boxes_divulgacao.slot1 ?? null,
        slot2: raw.boxes_divulgacao.slot2 ?? null,
      };
    }
  } catch {
    // graceful — config ausente/corrompido cai no default legado abaixo
  }
  return { slot1: "livros-divulgacao.md", slot2: null };
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
  /** #1938/#2978: injeta os boxes de divulgação configurados (`boxes_divulgacao`
   * de `platform.config.json`) nos slots 1 (D1/D2) e 2 (D2/D3). Default `true`
   * (todo daily — decisão editorial). Kill-switch: `false` / `--no-sponsor` —
   * suprime a injeção em AMBOS os slots. */
  sponsor?: boolean;
  /** Override de teste: pula a leitura de `platform.config.json` e usa esta
   * config diretamente. Produção nunca passa este campo (sempre lê do disco). */
  boxesDivulgacao?: BoxesDivulgacaoConfig;
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

  // #1938/#2527/#2978: boxes de divulgação nos slots 1 (D1/D2) e 2 (D2/D3),
  // isolados entre dois `---` (posição que extractBoxDivulgacao1/2 procura;
  // #1972 garante de-dup no render). Config-driven via `boxes_divulgacao` de
  // `platform.config.json` — default legado = livros (📚) no slot 1, nada no
  // slot 2 (#2527: livros substituiu o 📣 Clarice como padrão do slot 1).
  // Idempotente: pula um slot se a região correspondente já traz um box
  // (editor já colou à mão, ou re-run). Kill-switch: sponsor=false suprime
  // AMBOS os slots. Graceful: snippet ausente/config sem slot → sem box
  // nesse slot.
  const wantSponsor = input.sponsor !== false;
  const boxesCfg = input.boxesDivulgacao ?? loadBoxesDivulgacaoConfig();
  // #3232: `boxAlreadyPresentInGap` substitui o antigo `calloutRe` (allowlist
  // de marcadores 📣/📚/🎉 bold-line) por detecção marcador-agnóstica — mesma
  // técnica de #3204 (`locateBoxInGap`, por POSIÇÃO+ESTRUTURA). `a`/`b` são os
  // drafts brutos dos 2 destaques que cercam o slot (ex: d1/d2 pro slot 1); um
  // box já injetado aparece GLUADO ao final de `a` (sem `---`, caso real
  // 260609) OU PREPENDED ao início de `b` (antes do próprio header
  // `**DESTAQUE N |`). Sondamos essa mesma forma unindo os 2 textos com um
  // `---` artificial e reusando `extractBoxDivulgacao1` (gapIndex 0 nesse
  // probe de 2 marcadores) — cobre tanto o caminho "bloco isolado" quanto o
  // fallback "bloco colado" (bold-wrap + link) do #3204, sem precisar saber
  // qual emoji abre o bloco.
  //
  // O marcador 🛒 (carrinho) segue verificado explicitamente: não é um emoji
  // de CATEGORIA de conteúdo (como 📣/📚/🎉, que o #3204 já tratou como não-
  // essenciais pra detecção), e sim um sinal ESTRUTURAL de FORMATO — mesmo
  // tratamento que `shouldForceCtaPill` (newsletter-render-html.ts) preserva
  // deliberadamente pós-#3204 ("legado... comportamento pré-#3204
  // preservado"). Um box carrinho colado (sem `---`) não é bold-wrap, então
  // `locateGluedBoxInBlock` não o pegaria — por isso o teste dedicado.
  const CART_MARKER_RE = /(?:^|\n)\s*🛒/u;
  function boxAlreadyPresentInGap(a: string, b: string): boolean {
    if (CART_MARKER_RE.test(a) || CART_MARKER_RE.test(b)) return true;
    return extractBoxDivulgacao1(`${a}\n\n---\n\n${b}`) !== null;
  }
  const slot1AlreadyPresent = boxAlreadyPresentInGap(d1, d2);
  const slot1Box = wantSponsor && !slot1AlreadyPresent
    ? loadDivulgacaoSnippet(boxesCfg.slot1)
    : null;
  // Slot 2 só existe em edições de 3 destaques (sem gap D2/D3 em edições de 2).
  const slot2AlreadyPresent = d3 !== null && boxAlreadyPresentInGap(d2, d3);
  const slot2Box = wantSponsor && d3 !== null && !slot2AlreadyPresent
    ? loadDivulgacaoSnippet(boxesCfg.slot2)
    : null;

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
  if (slot1Box) {
    parts.push(slot1Box, "", "---", "");
  }
  parts.push(
    d2,
    "",
    "---",
    "",
  );
  if (slot2Box) {
    parts.push(slot2Box, "", "---", "");
  }
  // #2343: D3 is optional. For 2-destaque editions, omit the D3 block entirely.
  if (d3 !== null) {
    parts.push(
      d3,
      "",
      "---",
      "",
    );
  }
  // #2546: È IA? renderiza APÓS o último destaque (D3 em edições de 3
  // destaques; D2 em edições de 2). Antes ficava fixo entre D2 e D3.
  parts.push(
    eiaBlock,
    "",
    "---",
    "",
  );

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
  // #3100: VÍDEO antes de RADAR (ordem canônica permanente, decisão editorial
  // do gate 260708 — antes o VÍDEO vinha depois do RADAR).
  if (videos) {
    parts.push(videos);
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

  parts.push(FIXED_BLOCKS.erro_intencional_placeholder);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(FIXED_BLOCKS.sorteio);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(buildParaEncerrar());
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

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) main();
