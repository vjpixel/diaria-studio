/**
 * check-stage2-invariants.ts (#1072 / #1073)
 *
 * Validator pós-Stage 2 — confirma que os polidores (Humanizador + Clarice)
 * e o renderizador do bloco ERRO INTENCIONAL rodaram de fato. Sem essas
 * etapas, edições saem com prosa polida-vazia (gerúndios em cascata,
 * vocabulário inflado) ou com placeholder literal contaminando o paste manual.
 *
 * Strategy: comparar arquivos intermediários. Se outputs forem idênticos aos
 * inputs, a skill foi pulada e o passo deve ser refeito.
 *
 * Uso:
 *   npx tsx scripts/check-stage2-invariants.ts --edition-dir data/editions/AAMMDD/
 *
 * Output:
 *   stdout: JSON com { ok, checks: { humanizador, clarice, erro_intencional } }
 *   exit 0 quando todos passaram; exit 1 com mensagem clara quando algum falhou.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { extractUrlsFromMd, FOOTER_DOMAINS } from "./lib/canonical-urls.ts"; // #1456 / #2695
import { intentionalErrorJsonPath } from "./lib/intentional-errors.ts"; // #3222
import { isVideoUrl } from "./lib/video-youtube-resolve.ts"; // #4263
import { verify as verifyUrl } from "./verify-accessibility.ts"; // #4730

interface VerifyCacheEntry {
  verdict: "accessible" | "paywall" | "blocked" | "aggregator" | "uncertain" | "anti_bot";
  checked_at?: string;
  finalUrl?: string;
}
// Production cache schema (#1456 review): `{ version, entries: Record<url, entry> }`.
// Pre-fix lia `cache[url]` direto, falhava todo URL.
interface VerifyCacheShape {
  version?: number;
  entries: Record<string, VerifyCacheEntry>;
}

interface CheckResult {
  ok: boolean;
  label?: string;
}

/**
 * Pure (#1072): humanizador roda no `02-normalized.md` → `02-humanized.md`.
 * Se a skill pulou ou foi no-op, os 2 arquivos são byte-idênticos (ou
 * `02-humanized.md` nem existe). Ambos os casos sinalizam pulo.
 *
 * Edge legítimo: texto perfeitamente humano. Mas writer-agent SEMPRE produz
 * tics LLM detectáveis pelo humanizador (gerúndio, "É importante", etc.)
 * — então byte-idêntico é proxy confiável.
 */
export function checkHumanizadorRan(internalDir: string): CheckResult {
  const normalized = join(internalDir, "02-normalized.md");
  const humanized = join(internalDir, "02-humanized.md");
  if (!existsSync(humanized)) {
    return { ok: false, label: "humanized_missing: 02-humanized.md não existe — humanizador foi pulado" };
  }
  // Se normalized não existe, o passo anterior falhou — não é problema do humanizador
  if (!existsSync(normalized)) {
    return { ok: true, label: "normalized_missing: passo anterior falhou, skip" };
  }
  const a = readFileSync(normalized, "utf8");
  const b = readFileSync(humanized, "utf8");
  if (a === b) {
    return { ok: false, label: "humanized_unchanged: 02-humanized.md byte-idêntico a 02-normalized.md — humanizador foi no-op" };
  }
  return { ok: true };
}

/**
 * Pure (#1072, refined #1402): valida que Clarice foi chamada checando
 * artefatos de execução, não diff de output.
 *
 * O check anterior comparava `02-pre-clarice.md` byte-a-byte com
 * `02-reviewed.md` e abortava se idênticos. Caso real 260520: humanizador
 * removeu marcas IA suficiente pra Clarice retornar 0 sugestões legítimas
 * (HTTP 200, array vazio em 59 parágrafos processados). Output idêntico
 * NÃO é skip — é confirmação de que texto já está limpo. Check antigo
 * abortava Stage 2 em comportamento esperado.
 *
 * Novo: comprova execução via 3 sinais:
 *  1. `02-pre-clarice.md` existe (snapshot pré-Clarice gravado)
 *  2. `02-reviewed.md` existe (output do apply)
 *  3. `_internal/02-clarice-suggestions.json` existe E é array (pode ser `[]`)
 *
 * Esses 3 juntos provam que Clarice foi chamada. Output bytes-idênticos
 * passa a ser legítimo quando suggestions é `[]`.
 */
export function checkClariceRan(editionDir: string): CheckResult {
  const preClarice = join(editionDir, "_internal", "02-pre-clarice.md");
  const reviewed = join(editionDir, "02-reviewed.md");
  const suggestionsPath = join(editionDir, "_internal", "02-clarice-suggestions.json");

  if (!existsSync(reviewed)) {
    return { ok: false, label: "reviewed_missing: 02-reviewed.md não existe — Clarice foi pulada" };
  }
  if (!existsSync(preClarice)) {
    return { ok: false, label: "pre_clarice_missing: snapshot _internal/02-pre-clarice.md ausente — assertion #889 falhou" };
  }
  if (!existsSync(suggestionsPath)) {
    return {
      ok: false,
      label: "suggestions_missing: _internal/02-clarice-suggestions.json ausente — Clarice não foi chamada",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(suggestionsPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      label: `suggestions_invalid: 02-clarice-suggestions.json não é JSON válido: ${(e as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      label: "suggestions_invalid: 02-clarice-suggestions.json não é array",
    };
  }
  // Array vazio (#1402) é legítimo — Clarice foi chamada e não tinha o
  // que sugerir (texto pós-humanizador estava limpo). Não aborta.
  return { ok: true };
}

/**
 * Pure (#1073): `render-erro-intencional.ts` substitui placeholder no
 * `02-reviewed.md` pós-Clarice. Se foi pulado, o placeholder literal continua
 * no MD e vaza pro Beehiiv como texto.
 */
export function checkErroIntencionalRendered(editionDir: string): CheckResult {
  const reviewed = join(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    return { ok: true, label: "reviewed_missing: outro check captura isso" };
  }
  const md = readFileSync(reviewed, "utf8");
  // Placeholder literal do writer (variantes conhecidas)
  if (/\{placeholder,?\s*script\s*render-erro-intencional/i.test(md)) {
    return { ok: false, label: "erro_intencional_placeholder: 02-reviewed.md ainda tem o placeholder literal — script render-erro-intencional.ts foi pulado" };
  }
  // Verifica se a seção ERRO INTENCIONAL existe e parece preenchida.
  // Não é um check forte (pode-se publicar sem essa seção em casos edge),
  // mas warning se o header existe mas sem conteúdo abaixo.
  return { ok: true };
}

/**
 * Pure (#2284, #3222 migrado pra JSON): verifica que
 * `_internal/intentional-error.json` existe — mesmo que com valores
 * placeholder. `render-erro-intencional.ts` escreve o placeholder
 * automaticamente no final do Stage 2; se ausente, o script foi pulado ou
 * houve regressão.
 *
 * Não valida os valores dos campos (essa responsabilidade fica com o lint do
 * Stage 5 `--check intentional-error-flagged` que exige valores reais). Aqui
 * basta confirmar que o arquivo existe, sinalizando que o placeholder foi
 * inserido e o editor pode fornecer os campos antes da publicação.
 *
 * (#3222) O nome da função/label é preservado por compat com callers e docs
 * existentes — o mecanismo migrou de frontmatter YAML pra JSON, mas o
 * propósito do check (confirmar que o bloco foi inserido) é o mesmo.
 */
export function checkIntentionalErrorFrontmatter(editionDir: string): CheckResult {
  const reviewed = join(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    return { ok: true, label: "reviewed_missing: outro check captura isso" };
  }
  const jsonPath = intentionalErrorJsonPath(editionDir);
  if (!existsSync(jsonPath)) {
    return {
      ok: false,
      label: "intentional_error_frontmatter_missing: _internal/intentional-error.json ausente — render-erro-intencional.ts não inseriu o placeholder (#2284/#3222)",
    };
  }
  return { ok: true };
}

/**
 * #4730: entry do output per-edição de `verify-accessibility.ts`
 * (`_internal/link-verify-all.json`, ver invocação em
 * `orchestrator-stage-1-research.md` step 1i). Diferente do cache
 * cross-edição (`VerifyCacheShape`), este arquivo é escrito POR ESTA edição
 * — inclui verdicts não-cacheáveis como `needs_reverify`/`uncertain`, que o
 * cache cross-edição nunca persiste (`isCacheableVerdict`).
 */
interface EditionVerifyEntry {
  url?: string;
  finalUrl?: string;
  verdict?: string;
}

/**
 * #4730: lê `_internal/link-verify-all.json` (se existir) e retorna o
 * conjunto de URLs marcadas `needs_reverify` nesta edição — timeout/erro de
 * conexão esgotado nas duas tentativas do Stage 1 (fetch + browser
 * fallback), sinal específico que não é ambiguidade de conteúdo (ver
 * `reclassifyExhaustedTimeout` em `verify-accessibility.ts`).
 *
 * Best-effort: arquivo ausente/inválido → Set vazio, sem bloquear o resto do
 * check (mesmo padrão fail-soft do cache cross-edição abaixo).
 */
function loadNeedsReverifyUrls(editionDir: string): Set<string> {
  const path = join(editionDir, "_internal", "link-verify-all.json");
  if (!existsSync(path)) return new Set();
  try {
    const raw: EditionVerifyEntry[] = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return new Set();
    const urls = new Set<string>();
    for (const entry of raw) {
      if (entry?.verdict !== "needs_reverify") continue;
      if (entry.url) urls.add(entry.url);
      if (entry.finalUrl) urls.add(entry.finalUrl);
    }
    return urls;
  } catch {
    return new Set();
  }
}

/**
 * (#1456, async desde #4730): valida que todas as URLs editoriais no
 * `02-reviewed.md` estão marcadas como `accessible` no cache cross-edition
 * de verify-accessibility.
 *
 * Pega edições manuais de top-level Claude/editor que introduziram URLs
 * hallucinadas (caso 260522 — Hassabis Guardian URL 404, Canaltech com sufixo
 * `-em-sp/` inventado). URLs sem entry no cache OU com verdict != accessible
 * são flagged.
 *
 * Footer/affiliate URLs (diaria.beehiiv.com, wisprflow, etc.) já são puladas
 * em `extractUrlsFromMd` via filter explícito do `extractUrlsFromMd` helper
 * (#1456). Pelo design conservador, URLs ausentes do cache são tratadas como
 * suspeitas — caller pode re-rodar `verify-accessibility` pra popular.
 *
 * #4263: URLs de vídeo (YouTube/Vimeo, `isVideoUrl`) são puladas também, por
 * design — `url-verify-cache.ts` documenta explicitamente que o verdict
 * `video` NUNCA é persistido no cache cross-edição ("barato detectar, sem
 * fetch, sem benefício de cache"). Sem este skip, toda URL da seção VÍDEOS
 * caía em `not_in_cache` e reprovava o check — falso-positivo estrutural
 * (confirmado 260729: `verify-accessibility.ts` rodou explicitamente sobre a
 * URL e persistiu 0 novos entries, por design, não por falha).
 *
 * #4730: URLs marcadas `needs_reverify` pelo Stage 1 (timeout esgotado nas
 * duas tentativas) recebem uma re-verificação determinística AQUI, no gate,
 * em vez de confiar no cache cross-edição — que pode ter uma entry STALE
 * `accessible` de uma edição anterior (o `needs_reverify` desta run nunca
 * sobrescreve o cache, por ser não-cacheável) mascarando o timeout de hoje.
 * Caso real (#4730, edição 260807): D2 tinha `uncertain` fresco por timeout
 * mas sobreviveu ao pool sem re-checagem automática; só uma re-verificação
 * manual no gate achou o paywall real. `opts.reverify` é injetável pra
 * permitir teste determinístico sem rede (default: `verify()` real).
 *
 * @param cachePath path pro link-verify-cache.json (default
 *   `data/link-verify-cache.json`). Quando ausente/inválido, skip silencioso
 *   (não bloqueia stage 2 mas perde a defesa).
 */
export async function checkUrlsAccessible(
  editionDir: string,
  cachePath: string,
  opts: { reverify?: (url: string) => Promise<{ verdict: string }> } = {},
): Promise<CheckResult> {
  const reviewed = join(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    return { ok: true, label: "reviewed_missing: outro check captura isso" };
  }
  if (!existsSync(cachePath)) {
    // Sem cache, não há defesa — não bloqueia mas avisa.
    return {
      ok: true,
      label: `verify_cache_missing: ${cachePath} não existe — rode \`verify-accessibility\` pra ativar safety net`,
    };
  }
  let cache: VerifyCacheShape;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    // Suporta ambas as formas: schema canonical `{entries: {...}}` E shape
    // legado `{[url]: entry}` (test fixtures + edge edições antigas).
    if (parsed && typeof parsed === "object" && "entries" in parsed) {
      cache = parsed as VerifyCacheShape;
    } else if (parsed && typeof parsed === "object") {
      cache = { entries: parsed as Record<string, VerifyCacheEntry> };
    } else {
      return { ok: true, label: "verify_cache_invalid: skip" };
    }
  } catch {
    return { ok: true, label: "verify_cache_invalid: skip" };
  }
  const md = readFileSync(reviewed, "utf8");
  const urls = extractUrlsFromMd(md);
  // #2695: FOOTER_DOMAINS importado de canonical-urls.ts (fonte única — antes
  // cópia local que já havia divergido: wikipedia.org/wikimedia.org
  // ("todas as variantes") vs pt.wikipedia.org/commons.wikimedia.org
  // nas cópias paralelas em newsletter-count.ts e canonical-urls.ts).
  // #1456 review fix: build reverse index por finalUrl + normalized form tb.
  // verify-accessibility.ts strips trailing slash; nosso checker precisa
  // tentar ambas formas pra evitar false-positive (caso: URL no MD termina
  // em `/`, cache key não).
  const finalUrlIndex = new Map<string, VerifyCacheEntry>();
  const normalizedIndex = new Map<string, VerifyCacheEntry>();
  const stripTrailingSlash = (u: string) => u.endsWith("/") ? u.slice(0, -1) : u;
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (entry.finalUrl && entry.finalUrl !== key) {
      finalUrlIndex.set(entry.finalUrl, entry);
      normalizedIndex.set(stripTrailingSlash(entry.finalUrl), entry);
    }
    normalizedIndex.set(stripTrailingSlash(key), entry);
  }
  const lookupCacheEntry = (url: string): VerifyCacheEntry | undefined => {
    return (
      cache.entries[url] ??
      finalUrlIndex.get(url) ??
      normalizedIndex.get(stripTrailingSlash(url))
    );
  };
  // #4730: URLs desta edição marcadas needs_reverify pelo Stage 1 recebem
  // re-verificação determinística AQUI, ao invés de consultar o cache
  // cross-edição (que pode ter entry stale de outra edição mascarando o
  // timeout fresco de hoje).
  const needsReverifyUrls = loadNeedsReverifyUrls(editionDir);
  const reverify = opts.reverify ?? ((url: string) => verifyUrl(url));
  const suspicious: { url: string; reason: string }[] = [];
  for (const url of urls) {
    if (FOOTER_DOMAINS.some((d) => url.includes(d))) continue;
    if (isVideoUrl(url)) continue; // #4263: video verdict nunca é cacheado, por design — não é not_in_cache
    if (needsReverifyUrls.has(url)) {
      const fresh = await reverify(url);
      if (fresh.verdict !== "accessible" && fresh.verdict !== "video") {
        suspicious.push({ url, reason: `needs_reverify_failed: verdict=${fresh.verdict}` });
      }
      continue;
    }
    const entry = lookupCacheEntry(url);
    if (!entry) {
      suspicious.push({ url, reason: "not_in_cache (URL nova pós-edit manual)" });
      continue;
    }
    if (entry.verdict !== "accessible") {
      suspicious.push({ url, reason: `verdict=${entry.verdict}` });
    }
  }
  if (suspicious.length > 0) {
    // Persist lista completa pra inspeção (#1456 review).
    try {
      const internalDir = join(editionDir, "_internal");
      if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(internalDir, "02-urls-suspicious.json"),
        JSON.stringify({ suspicious, generated_at: new Date().toISOString() }, null, 2),
      );
    } catch {
      // Best-effort — não bloqueia o check se write falhar.
    }
    // #4263: URL completa (não truncada) sempre vai pro JSON persistido acima.
    // Aqui, na mensagem de console, `.slice(0, 80)` é só pra caber na linha —
    // mas sem indicador, um corte no meio do slug parece URL corrompida (foi
    // lido como "extração truncou a URL" no caso real 260729, quando na
    // verdade a extração sempre retornou a URL completa e correta — só o
    // display cortava). Reticências deixam explícito que é truncamento de
    // exibição, não o valor usado na checagem.
    const list = suspicious
      .slice(0, 5)
      .map((s) => {
        const shown = s.url.length > 80 ? `${s.url.slice(0, 80)}…` : s.url;
        return `${shown} (${s.reason})`;
      })
      .join("; ");
    const more = suspicious.length > 5 ? ` +${suspicious.length - 5} mais em _internal/02-urls-suspicious.json` : "";
    return {
      ok: false,
      label: `urls_suspicious: ${suspicious.length} URL(s) não-accessible/desconhecidas no cache — ${list}${more}. Re-rode verify-accessibility ou corrija as URLs editadas manualmente.`,
    };
  }
  return { ok: true };
}

interface AggregateResult {
  ok: boolean;
  checks: {
    humanizador: CheckResult;
    clarice: CheckResult;
    erro_intencional: CheckResult;
    intentional_error_frontmatter: CheckResult;
    urls_accessible: CheckResult;
  };
}

// #4730: async — checkUrlsAccessible pode re-verificar URLs needs_reverify
// via rede (verify-accessibility.ts real, ou opts.reverify injetado em teste).
export async function checkStage2Invariants(
  editionDir: string,
  opts: { cachePath?: string; reverify?: (url: string) => Promise<{ verdict: string }> } = {},
): Promise<AggregateResult> {
  const internalDir = join(editionDir, "_internal");
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cachePath = opts.cachePath ?? resolve(ROOT, "data/link-verify-cache.json");
  const humanizador = checkHumanizadorRan(internalDir);
  const clarice = checkClariceRan(editionDir);
  const erro_intencional = checkErroIntencionalRendered(editionDir);
  const intentional_error_frontmatter = checkIntentionalErrorFrontmatter(editionDir);
  const urls_accessible = await checkUrlsAccessible(editionDir, cachePath, { reverify: opts.reverify });
  return {
    ok: humanizador.ok && clarice.ok && erro_intencional.ok && intentional_error_frontmatter.ok && urls_accessible.ok,
    checks: { humanizador, clarice, erro_intencional, intentional_error_frontmatter, urls_accessible },
  };
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: check-stage2-invariants.ts --edition-dir data/editions/AAMMDD/");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`[check-stage2-invariants] dir não existe: ${editionDir}`);
    process.exit(1);
  }
  const result = await checkStage2Invariants(editionDir);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const failed: string[] = [];
    if (!result.checks.humanizador.ok) failed.push(`humanizador: ${result.checks.humanizador.label}`);
    if (!result.checks.clarice.ok) failed.push(`clarice: ${result.checks.clarice.label}`);
    if (!result.checks.erro_intencional.ok) failed.push(`erro_intencional: ${result.checks.erro_intencional.label}`);
    if (!result.checks.intentional_error_frontmatter.ok) failed.push(`intentional_error_frontmatter: ${result.checks.intentional_error_frontmatter.label}`);
    if (!result.checks.urls_accessible.ok) failed.push(`urls_accessible: ${result.checks.urls_accessible.label}`);
    console.error(`\n[check-stage2-invariants] FAIL — ${failed.length} check(s) falharam:`);
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
