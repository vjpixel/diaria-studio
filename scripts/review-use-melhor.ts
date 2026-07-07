/**
 * review-use-melhor.ts (#1798)
 *
 * Guard determinístico contra item mal-bucketado no `use_melhor` — newsletter/
 * análise/cobertura entrando no lugar de tutorial. Em 260604 dois posts da
 * `latent.space` (newsletter/podcast, EN) caíram no bucket; o editor teve que
 * corrigir na mão. As regras de julgamento ficam em `context/editorial-rules.md`
 * (#1798), mas dependem da memória do agente — este guard fecha o loop surfando
 * os suspeitos no gate da Etapa 1, de forma determinística.
 *
 * WARN-ONLY: nunca bloqueia (o editor cura `use_melhor` no gate, 0-1 item).
 * Só lista os suspeitos com o motivo, pra não embarcar silenciosamente.
 *
 * Uso:
 *   npx tsx scripts/review-use-melhor.ts --approved data/editions/AAMMDD/_internal/01-approved.json
 *
 * Output JSON: { total, suspicious: [{ url, title?, reasons[] }] }
 * Exit code: sempre 0 (warn-only). O orchestrator surfaça `suspicious[]` no gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { isAggregator } from "./lib/aggregators.ts";
import { classifyAudienceClass, isOpinionOrStudy } from "./lib/use-melhor-curation.ts";
import { ROUNDUP_HOWTO_EXCEPTION_RE, urlSlugText } from "./lib/roundup-detect.ts"; // #2691 items 1+3+4

/**
 * #2663: sinal de newsletter/roundup em slug ou título — o artigo É uma
 * compilação/curadoria de links, não tutorial acionável.
 *
 * Abrangente (usa mais sinais que o ROUNDUP_SLUG_RE do categorize.ts, que é
 * conservador por operar no path de classificação). Aqui o guard é warn-only,
 * então podemos incluir sinais mais fracos:
 *   - slug/título: newsletter, roundup, digest, this week in
 *   - título: "weekly [digest|recap|newsletter]", "monthly [digest|...]"
 *   - título: "and more" SÓ quando TERMINAL (fim do título — enumeração de roundup
 *     "X, Y, and More"). Mid-título ("and more efficient architectures") NÃO conta,
 *     pra não flagar notícia/análise legítima (#2666 follow-up).
 *
 * PRECEDÊNCIA: newsletter/roundup > how-to (#2663 + #2666 coexistência).
 * Se um roundup contém "veja como" no título, o sinal de roundup VENCE e o
 * artigo é flagado mesmo assim — não usamos `&& !hasTutorial` aqui.
 * Isso é intencional: um roundup sobre tutoriais ainda é um roundup, não um
 * tutorial em si. O editor decide no gate.
 *
 * Limite deliberado: "Como construir uma newsletter" / "how-to-build-a-newsletter"
 * NÃO dispara (#2691 item 3 — `ROUNDUP_HOWTO_EXCEPTION_RE` compartilhada de
 * lib/roundup-detect.ts). Antes desse fix este comentário era ASPIRACIONAL —
 * a exceção não existia de fato e o caso era um FP aceito e documentado em
 * teste (ver test/review-use-melhor.test.ts). Mas como a function é chamada
 * com precedência absoluta em reviewUseMelhor, o editor verá o alerta e pode
 * descartar se ainda for FP em algum caso não coberto pela exceção.
 */
const NEWSLETTER_ROUNDUP_RE =
  /\b(?:newsletter|roundup|this\s+week\s+in|weekly\s+(?:digest|recap|roundup|newsletter)|monthly\s+(?:digest|recap|roundup|newsletter))\b|\band\s+more\b\s*[.!]?\s*$/i;

/**
 * Detecta sinal de newsletter/roundup no slug ou título.
 * Exportada para testes (#2663).
 *
 * #2691 item 3: aplica `ROUNDUP_HOWTO_EXCEPTION_RE` (lib/roundup-detect.ts)
 * antes de confirmar o match — desativa o guard pra how-to genuíno sobre
 * criar/montar uma newsletter (mesma exceção usada por `ROUNDUP_GUARD_RE`
 * em categorize.ts/use-melhor-curation.ts, aplicada aqui ao regex mais amplo).
 */
export function isNewsletterRoundup(url: string, title: string): boolean {
  const slug = urlSlugText(url);
  const matched = NEWSLETTER_ROUNDUP_RE.test(title) || NEWSLETTER_ROUNDUP_RE.test(slug);
  if (!matched) return false;
  if (ROUNDUP_HOWTO_EXCEPTION_RE.test(title) || ROUNDUP_HOWTO_EXCEPTION_RE.test(slug)) return false;
  return true;
}

/**
 * Domínios primariamente newsletter/podcast/análise — só PARTE do conteúdo é
 * tutorial, então no bucket use_melhor merecem revisão. `latent.space` está aqui
 * (e NÃO globalmente como aggregator, pra não quebrar o categorize que aceita
 * tutoriais reais de lá). `*.substack.com`/`*.beehiiv.com` cobertos por sufixo.
 */
export const NEWSLETTER_LIKE_HOSTS = new Set<string>([
  "latent.space",
  "stratechery.com",
  "newsletter.pragmaticengineer.com",
  "oneusefulthing.org",
  "importai.net",
]);

/**
 * Hosts que são tutoriais de verdade — não flagar por "sem sinal de slug" (o
 * slug do cookbook/learn raramente tem verbo). Espelha (parcialmente) os
 * TUTORIAL_DOMAINS do categorize.ts.
 *
 * #2313: `langchain.com` removido. O /blog publica mix de tutoriais E case studies
 * corporativos ("How LangChain Made X Predictable" — cobertura de produto, não tutorial).
 * Sem whitelist aqui, o guard verifica o sinal de tutorial no título/slug — se não
 * tem how-to explícito, é flagado pra revisão do editor. Os tutoriais reais de
 * langchain.com têm verbo imperativo no slug e passam por `hasTutorialSignal`.
 */
export const TUTORIAL_HOSTS = new Set<string>([
  "cookbook.openai.com",
  "developers.openai.com", // #1862 — OpenAI Cookbook migrou pra cá
  "fast.ai",
  "huggingface.co",
  "kaggle.com",
  "pinecone.io",
  "realpython.com",
  "deeplearning.ai",
  "learn.microsoft.com",
  "developers.googleblog.com",
  // langchain.com removido em #2313 — mix de tutoriais e case studies corporativos.
  "wandb.ai", // #1862 — só /fully-connected chega em use_melhor
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Domínio newsletter/agregador (cobertura/análise, não tutorial). */
export function isNewsletterLike(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (NEWSLETTER_LIKE_HOSTS.has(host)) return true;
  if (/\.substack\.com$/.test(host) || /\.beehiiv\.com$/.test(host)) return true;
  return isAggregator(url);
}

/**
 * Verbo imperativo / padrão how-to no título ou no slug.
 *
 * #3027: `como` sozinho (sem verbo acionável) foi removido — casava QUALQUER
 * título contendo a palavra "como" (interrogativo/descritivo em português,
 * não necessariamente imperativo), incluindo análise de negócio ("Como a IA
 * transforma FP&A e Controladoria", caso real 260707/#3027 — handit.com.br).
 * Isso derrubava `hasTutorial` para true e, por causa do `&& !hasTutorial`
 * em TODOS os branches de `reviewUseMelhor`, mascarava os outros guards
 * (isNewsletterLike/isCorporateBlog/isOpinionOrStudy) — o item nunca era
 * flagado. Agora exige "como" + verbo acionável, alinhado com HOW_TO_GUARD_RE
 * (lib/use-melhor-curation.ts) e RADAR_HOWTO_PROMOTE_RE (mesma família de
 * verbos, mesma precaução).
 */
const TUTORIAL_SIGNAL_RE =
  /\b(como\s+(?:usar|fazer|criar|configurar|implementar|construir|desenvolver|instalar|montar|rodar|executar)|guia|passo[- ]?a[- ]?passo|tutorial|cookbook|how[- ]?to|walkthrough|hands[- ]?on|step[- ]?by[- ]?step|build(?:ing)? (?:your|a|an)|deploy(?:ing) (?:your|a|an|\w+)|creat(?:e|ing) (?:your|a|an|\w+)|crash course|getting started|comece|aprenda|construa|criando|fa[çc]a)\b/i;

export function hasTutorialSignal(url: string, title: string): boolean {
  const host = hostOf(url);
  if (host && TUTORIAL_HOSTS.has(host)) return true;
  // #2691 item 4: reusa urlSlugText (lib/roundup-detect.ts) em vez de
  // reimplementar o mesmo decode+replace localmente — mesma normalização
  // usada por isNewsletterRoundup logo acima.
  const slug = urlSlugText(url);
  return TUTORIAL_SIGNAL_RE.test(title) || TUTORIAL_SIGNAL_RE.test(slug);
}

/**
 * #2313: domínios de blog corporativo que publicam mix de tutoriais E case studies/
 * anúncios — não têm sinal de tutorial suficientemente forte no URL path por si só.
 * Sem sinal de tutorial no título, itens desses domínios são suspeitos.
 */
export const CORPORATE_BLOG_HOSTS = new Set<string>([
  "langchain.com", // /blog publica mix de tutoriais e case studies corporativos
  "blog.langchain.dev", // #2313 — host real do LangChain blog (per categorize.ts:971)
  "aws.amazon.com", // ML blog publica tutoriais E anúncios de serviço/release notes
  "cloud.google.com", // blog publica tutoriais E case studies de cliente
]);

/** Detecta se a URL pertence a um blog corporativo (não dedicado a tutoriais). */
export function isCorporateBlog(url: string): boolean {
  const host = hostOf(url);
  return host !== null && CORPORATE_BLOG_HOSTS.has(host);
}

export interface UseMelhorItem {
  url?: string;
  title?: string;
  summary?: string;
  audience_affinity?: { matched?: string[] } | null;
  [k: string]: unknown;
}

export interface SuspiciousItem {
  url: string;
  title?: string;
  reasons: string[];
}

export interface ReviewResult {
  total: number;
  suspicious: SuspiciousItem[];
}

/**
 * Resultado do guard de composição casual/iniciante (#2339).
 *
 * - `casualCount`    — número de itens classificados como "casual".
 * - `beginnerCount`  — número de itens classificados como "dev-iniciante".
 * - `advancedCount`  — número de itens classificados como "dev-avancado".
 * - `missingCasual`  — true quando casualCount === 0 (warn: sem tutorial para leigo).
 * - `missingBeginner`— true quando beginnerCount === 0 (warn: sem tutorial para dev iniciante).
 * - `severity`       — #3027: força do sinal, pra diferenciar gap parcial de gap total:
 *     - `"ok"`       — casual e dev-iniciante presentes, nada a avisar.
 *     - `"partial"`  — falta UMA das duas classes (o warn de sempre, #2339).
 *     - `"critical"` — faltam AMBAS (bucket 100% dev-avançado, ex: caso real 260707
 *       — 5/5 itens dev-avançado, #3027). Sinal de enviesamento total, não parcial —
 *       merece destaque mais forte no gate (ainda warn-only, nunca bloqueia).
 * - `breakdown`      — lista de itens com a classificação atribuída (para surfaçar no gate).
 */
export interface CompositionResult {
  casualCount: number;
  beginnerCount: number;
  advancedCount: number;
  missingCasual: boolean;
  missingBeginner: boolean;
  severity: "ok" | "partial" | "critical";
  breakdown: Array<{ url: string; title?: string; class: string }>;
}

/**
 * #2339: Guard determinístico de composição casual/iniciante no bucket use_melhor.
 *
 * WARN-ONLY (nunca bloqueia). Sinaliza para o editor no gate quando o bucket
 * final de USE MELHOR não tem nenhum item casual (para leigos) ou nenhum item
 * para dev iniciante — indicando que a curadoria automática ficou enviesada
 * para conteúdo dev avançado.
 *
 * Analogia com `reviewUseMelhor` (#1798): aquele detecta itens mal-bucketados
 * (newsletter no lugar de tutorial); este detecta desequilíbrio de público-alvo
 * dentro dos tutoriais corretos.
 *
 * #3027: `severity` endurece o sinal sem bloquear o pipeline (P2, não P0/P1 —
 * ver framing da issue). Caso real 260707 teve 5/5 itens dev-avançado (gap
 * TOTAL, as duas cotas faltando ao mesmo tempo) — distinto de um gap parcial
 * (ex: 1 casual + 0 dev-iniciante, ainda há alguma diversidade). O gate deve
 * tratar esses dois casos com urgência diferente; `severity` torna essa
 * diferença explícita e testável, em vez de depender só de missingCasual/
 * missingBeginner booleanos lidos separadamente.
 */
export function reviewUseMelhorComposition(items: UseMelhorItem[]): CompositionResult {
  let casualCount = 0;
  let beginnerCount = 0;
  let advancedCount = 0;
  const breakdown: CompositionResult["breakdown"] = [];

  for (const item of items) {
    const url = typeof item.url === "string" ? item.url : "";
    const title = typeof item.title === "string" ? item.title : undefined;
    const cls = classifyAudienceClass(item);
    if (cls === "casual") casualCount++;
    else if (cls === "dev-iniciante") beginnerCount++;
    else advancedCount++;
    breakdown.push({ url, title, class: cls });
  }

  const missingCasual = casualCount === 0;
  const missingBeginner = beginnerCount === 0;
  const severity: CompositionResult["severity"] =
    missingCasual && missingBeginner ? "critical" : missingCasual || missingBeginner ? "partial" : "ok";

  return {
    casualCount,
    beginnerCount,
    advancedCount,
    missingCasual,
    missingBeginner,
    severity,
    breakdown,
  };
}

/**
 * #3059: mensagem de severidade "critical" pro banner do gate. `severity`
 * é 'critical' em DOIS cenários bem diferentes:
 *   1. bucket ENVIESADO — há itens (advancedCount > 0), mas nenhum casual/
 *      iniciante (100% dev-avançado, caso real 260707, #3027).
 *   2. bucket VAZIO — não há NENHUM item (advancedCount === casualCount ===
 *      beginnerCount === 0), ou seja não há sequer o que enviesar.
 * Antes deste fix os dois casos imprimiam a MESMA mensagem ("ENVIESAMENTO
 * TOTAL... 100% dev-avançado"), o que é uma alegação falsa no cenário 2 (não
 * há "100% de nada" quando o total é zero) e leva o editor a um diagnóstico
 * errado no gate. `severity` continua 'critical' nos dois — só o TEXTO muda.
 * Exportada para teste de regressão (#3059).
 */
export function formatCriticalCompositionMessage(
  composition: CompositionResult,
): { header: string; detail: string } {
  const isEmpty =
    composition.advancedCount === 0 && composition.casualCount === 0 && composition.beginnerCount === 0;
  if (isEmpty) {
    return {
      header: "🚨 USE MELHOR VAZIO — nenhum item qualificado hoje.",
      detail: "A curadoria automática não encontrou NENHUM item para o bucket USE MELHOR nesta edição.",
    };
  }
  return {
    header: "🚨 USE MELHOR: ENVIESAMENTO TOTAL — 0 casual E 0 dev-iniciante (100% dev-avançado, #3027).",
    detail: "A curadoria automática não encontrou NENHUM item acessível a leigos ou iniciantes.",
  };
}

/**
 * Flag suspeito = domínio newsletter/agregador **E** sem sinal de tutorial
 * (#1798). O vetor real de mis-bucket é exatamente esse: domínios que o
 * categorize trata como tutorial-pattern mas são primariamente newsletter
 * (latent.space, *.substack), com título de cobertura/análise.
 *
 * AND (não OR como a proposta inicial sugeria — review do PR #1816): OR flagava
 * 6/7 itens legítimos (todo tutorial de blog pessoal com título não-imperativo
 * caía), treinando o editor a ignorar o aviso. AND é preciso:
 *  - latent.space "State of AI Engineering" → newsletter + sem-sinal → FLAGA ✓
 *  - latent.space "How to build an agent"   → newsletter + sinal    → não flaga ✓
 *  - eugeneyan.com "LLM Patterns"           → não-newsletter        → não flaga ✓
 *
 * #2313: guarda adicional — blog corporativo (langchain.com, aws ML blog) SEM
 * sinal de tutorial no título também é flagado. Esses domínios publicam mix de
 * tutoriais reais E case studies de produto. Sem sinal how-to explícito no título,
 * é provável que seja cobertura/case study, não tutorial acionável.
 */
export function reviewUseMelhor(items: UseMelhorItem[]): ReviewResult {
  const suspicious: SuspiciousItem[] = [];
  for (const item of items) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    const title = typeof item.title === "string" ? item.title : "";
    const hasTutorial = hasTutorialSignal(url, title);
    // #2663: newsletter/roundup detectado no slug ou título — flag com PRIORIDADE
    // sobre todos os outros checks. NÃO usa `&& !hasTutorial` de propósito:
    // roundup > how-to é a precedência definida (ver NEWSLETTER_ROUNDUP_RE acima).
    // Um roundup sobre tutoriais ("Newsletter: veja como usar X") ainda é roundup.
    if (isNewsletterRoundup(url, title)) {
      suspicious.push({
        url,
        title: title || undefined,
        reasons: [
          "newsletter/roundup detectado (newsletter|roundup|weekly|digest|and more) — é uma compilação de links, não tutorial acionável (#2663)",
        ],
      });
    } else if (isNewsletterLike(url) && !hasTutorial) {
      suspicious.push({
        url,
        title: title || undefined,
        reasons: [
          "domínio newsletter/agregador SEM sinal de tutorial no título/slug — provável cobertura/análise, não tutorial",
        ],
      });
    } else if (isCorporateBlog(url) && !hasTutorial) {
      // #2313: blog corporativo sem verbo how-to → suspeito de case study / anúncio.
      suspicious.push({
        url,
        title: title || undefined,
        reasons: [
          "blog corporativo SEM verbo how-to/tutorial no título/slug — verificar se é case study ou anúncio de produto (#2313)",
        ],
      });
    } else if (isOpinionOrStudy(url, title, typeof item.summary === "string" ? item.summary : "") && !hasTutorial) {
      // #2368 item 2: ensaio de opinião ou estudo de pesquisa sem sinal how-to.
      // Casos reais: hamel.dev opinion essay, langchain research study.
      suspicious.push({
        url,
        title: title || undefined,
        reasons: [
          "ensaio de opinião ou estudo de pesquisa SEM sinal how-to — não é tutorial hands-on (#2368)",
        ],
      });
    }
  }
  return { total: items.length, suspicious };
}

interface ApprovedShape {
  use_melhor?: UseMelhorItem[];
  [k: string]: unknown;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const approvedArg = values["approved"];
  if (!approvedArg) {
    console.error("Uso: review-use-melhor.ts --approved <01-approved.json>");
    process.exit(2);
  }
  const approvedPath = resolve(ROOT, approvedArg);
  if (!existsSync(approvedPath)) {
    console.error(`Arquivo não existe: ${approvedPath}`);
    process.exit(2);
  }
  let approved: ApprovedShape;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedShape;
  } catch (err) {
    console.error(`Falha ao parsear ${approvedPath}: ${(err as Error).message}`);
    process.exit(2);
  }

  const items = Array.isArray(approved.use_melhor) ? approved.use_melhor : [];
  const result = reviewUseMelhor(items);
  const composition = reviewUseMelhorComposition(items);
  console.log(JSON.stringify({ ...result, composition }, null, 2));

  if (result.suspicious.length > 0) {
    console.error(
      `\n⚠️ ${result.suspicious.length} de ${result.total} item(ns) de USE MELHOR suspeito(s) de não-tutorial:`,
    );
    for (const s of result.suspicious) {
      const titleHint = s.title ? ` ("${s.title.slice(0, 60)}")` : "";
      console.error(`  ${s.url}${titleHint}`);
      for (const r of s.reasons) console.error(`     → ${r}`);
    }
    console.error(
      "Revise no gate: USE MELHOR é tutorial de verdade, não cobertura/análise (#1798).",
    );
  }

  // #2339: guard de composição casual/iniciante (warn-only).
  // #3027: severidade "critical" (gap TOTAL — nenhuma cota preenchida, ex: caso
  // real 260707 com 5/5 dev-avançado) ganha banner mais visível que "partial"
  // (falta só uma cota) — ainda warn-only, nunca bloqueia (exit 0 sempre).
  if (composition.severity !== "ok") {
    const missing: string[] = [];
    if (composition.missingCasual) missing.push("casual (para leigos)");
    if (composition.missingBeginner) missing.push("dev-iniciante");

    if (composition.severity === "critical") {
      // #3059: header/detail distinguem bucket VAZIO (0 itens) de bucket
      // ENVIESADO (itens existem, mas 0 casual/iniciante) — ver
      // formatCriticalCompositionMessage acima.
      const { header, detail } = formatCriticalCompositionMessage(composition);
      console.error(`\n${header}`);
      console.error(`   ${detail}`);
    } else {
      console.error(
        `\n⚠️ USE MELHOR sem representação de: ${missing.join(", ")} (padrão: 2 casual + 2 dev-iniciante, #2339).`,
      );
    }
    console.error(
      `   Distribuição atual: ${composition.casualCount} casual / ${composition.beginnerCount} dev-iniciante / ${composition.advancedCount} dev-avançado.`,
    );
    console.error(
      composition.severity === "critical"
        ? "   Revise no gate ANTES de aprovar: adicione ao menos 1 item casual e 1 dev-iniciante (#3027)."
        : "   Revise no gate: adicione tutoriais para o público faltante antes de publicar.",
    );
  }
  // Warn-only: nunca bloqueia (exit 0).
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
