/**
 * validate-lancamentos.ts (#160, #876)
 *
 * Garante que a seção LANÇAMENTOS de um `02-reviewed.md` só contém
 * URLs de domínio oficial (whitelist em `categorize.ts`). Cobertura
 * de imprensa, blogs pessoais, agregadores e análise de terceiros vão
 * pra NOTÍCIAS — não pra LANÇAMENTOS, mesmo quando o tema é o
 * lançamento.
 *
 * Modo MD (#160, #902):
 *   npx tsx scripts/validate-lancamentos.ts <md-path>
 *   npx tsx scripts/validate-lancamentos.ts --in <md-path>
 *
 *   Output JSON: { lancamento_count, invalid_urls[], status }
 *
 * Modo approved-json (#876, usado em §2a do orchestrator-stage-2):
 *   npx tsx scripts/validate-lancamentos.ts \
 *     --approved <01-approved.json> \
 *     [--write-removed <_internal/02-lancamentos-removed.json>]
 *
 *   Valida cada URL em `approved.lancamento[]`. Quando `--write-removed`
 *   é passado, grava o resumo `{ removed[], original_count, final_count }`
 *   no path indicado para que `sync-intro-count.ts` ajuste menções
 *   narrativas a "X lançamentos" no intro pós-Clarice.
 *
 * #1968: verificação POSITIVA de ferramenta. Além do filtro de domínio oficial
 * (#160) e do filtro NEGATIVO de governança (#1799), cada item precisa de um
 * sinal POSITIVO de produto (software/hardware) no slug/título. Item oficial sem
 * sinal → `not_a_tool` → hard-block (exit 1), surfaçado no gate (pega parceria/
 * evento/programa/relatório que passariam só no filtro negativo). Override pra
 * slug atípico legítimo: `seed/lancamentos-tool-allowlist.txt`.
 *
 * Exit codes:
 *   0  Todas as URLs em LANÇAMENTOS são oficiais E ferramentas (ou seção vazia)
 *   1  Pelo menos 1 URL não-oficial (#160) OU 1 item sem sinal de produto (#1968)
 *   2  Erro de leitura/uso
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOfficialLancamentoUrl } from "./categorize.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

/**
 * #1968: allowlist de override pra a verificação positiva de ferramenta. Arquivo
 * `seed/lancamentos-tool-allowlist.txt` — 1 substring de URL por linha (`#` =
 * comentário). Um item de LANÇAMENTOS cuja URL contém qualquer entrada é tratado
 * como ferramenta verificada mesmo sem sinal positivo de produto no slug/título
 * (slug atípico legítimo). Ausente / vazio → allowlist vazia (sem override).
 */
export function loadToolAllowlist(root: string): string[] {
  const p = resolve(root, "seed", "lancamentos-tool-allowlist.txt");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

export interface ValidationResult {
  lancamento_count: number;
  invalid_urls: Array<{ url: string; line: number }>;
  /** #1799: itens que não são software/hardware (governança/política/análise). */
  non_product: Array<{ url: string; line: number }>;
  /** #1968: itens com sinal POSITIVO de ferramenta (software/hardware). */
  verified_product: Array<{ url: string; line: number }>;
  /** #1968: itens SEM sinal positivo de produto (verificação positiva falhou) —
   * mesmo que não batam em keyword de governança. Hard-block (exit 1). */
  not_a_tool: Array<{ url: string; line: number }>;
  status: "ok" | "error";
}

// #1799: casa os 3 formatos de header: `LANÇAMENTOS` solo (Stage 2 antigo),
// `## Lançamentos` (Stage 1 categorized), e `**🚀 LANÇAMENTOS**` (Stage 2
// reviewed.md — antes não casava, então o validador era no-op ali).
const SECTION_LANCAMENTOS_RE =
  /^(?:\*\*)?\s*(?:##\s+)?(?:🚀\s*)?lan[çc]amentos\s*(?:\*\*)?\s*$/im;
const SECTION_BREAK_RE = /^---\s*$/m;
const URL_RE = /https?:\/\/\S+/g;

/**
 * #1799: LANÇAMENTOS só lista software/hardware (modelo, app, API, ferramenta,
 * chip, dispositivo). Documento de governança/política/manifesto/essay/relatório
 * de segurança NÃO é lançamento de produto. Sinais (no slug ou título): termos
 * de governança/política. Slug é mais confiável que o título (que pode estar
 * traduzido). Caso 260604: openai.com/index/public-policy-agenda.
 */
// Só termos de ALTA precisão de governança — `framework`/`agenda`/`blueprint`/
// `guidelines` foram removidos (review #1817): são comuns em produto real
// (LangGraph framework, app de agenda, ...). Single-words porque o slug é
// normalizado (`[-_/]→ espaço`): "public-policy-agenda" → "public policy
// agenda" casa via `policy`. O título (testado as-is) casa via `política`.
const NON_PRODUCT_RE =
  /\b(policy|policies|governance|manifesto|principles|white\s?paper|commitment|charter|testimony|pol[íi]tica|governan[çc]a|diretrizes)\b/i;

/**
 * #2277: sinais de PROGRAMA / PARCERIA / BOLSA no slug ou título.
 * Programas filantrópicos, redes de parceiros e bolsas de pesquisa NÃO são
 * lançamentos de produto — passavam no #1968 quando o slug tinha "introducing"
 * (ex: openai.com/index/introducing-openai-partner-network → "partner network"
 * vence "introducing") ou nome de empresa de IA (ex: anthropic.com/news/
 * claude-corps → "claude" casava PRODUCT_SIGNAL_RE).
 *
 * HARD-BLOCK (alta precisão — via isNonProductLancamento → isVerifiedTool):
 *   - "partner[ -]network" (programa de parceiros, não "partner API")
 *   - "corps" (programa filantrópico — sem ambiguidade com produto)
 *   - "fellowships?" (bolsa — alta precisão, cobre plural)
 *
 * Excluídos do hard-block (movidos para PROGRAM_WARN_RE abaixo):
 *   - "grants?" — aparece em "compute-grants" que pode ser produto/acesso;
 *     "Army Corps" → coberto por \bcorps\b se for programa, mas "compute grant"
 *     slug é warn-only para evitar over-block.
 *   - "partnership" — aparece em API/product slugs ("openai-google-partnership-api");
 *     warn-only até haver co-ocorrência de contexto mais forte.
 *
 * Excluídos de propósito (ambíguos):
 *   - "partner" standalone: aparece em "partner API", "partner integrations"
 *   - "program" standalone: aparece em "program synthesis", "AI program"
 *   - "initiative" standalone: muito genérico
 *   - "academy": já coberto por `isCoursePage` em categorize.ts
 */
const PROGRAM_SIGNAL_RE =
  /\bpartner[\s-]?network\b|\bcorps\b|\bfellowships?\b/i;

/**
 * #2277 (warn-only): termos de programa de MÉDIA precisão que NÃO hard-blockam
 * mas surfaçam como aviso no gate. Aplicados ao slug E título, mas NÃO entram
 * em isNonProductLancamento (não afetam isVerifiedTool → sem hard-block).
 *   - "grants?" — bolsa/grant de pesquisa; também aparece em "compute grants"
 *     legítimos → warn para o editor decidir.
 *   - "partnership" — acordo bilateral; comum em slugs de produto de parceria
 *     ("openai-google-partnership-api") → warn, não hard-block.
 */
const PROGRAM_WARN_RE = /\bgrants?\b|\bpartnership\b/i;

/**
 * #2493 (warn-only): roundup de software de conferência — post oficial que anuncia
 * vários softwares/produtos novos num mesmo artigo, em vez de página oficial de 1
 * produto específico. Warn informativo (não bloqueia o gate), pra o editor decidir
 * se é lançamento ou notícia. Aplicado SOMENTE no título (o slug raramente expõe
 * "conference roundup" de forma legível).
 *
 * Padrão detectado: "[New|Latest] … Software[s] …" com complemento vago
 * (Unlocks/Powers/Advances/Drives/Enables/Fuels + substantivo científico/plural).
 * Exemplo real 260623: "New NVIDIA AI Software Unlocks Scientific Discoveries" (ISC).
 *
 * NÃO bloqueia e NÃO entra em isNonProductLancamento — é warn-only (análogo a
 * PROGRAM_WARN_RE). Itens com sinal positivo de produto (versão/família) passam
 * mesmo que o título seja amplo.
 */
// Gaps são `[^.]{0,40}` (não `.{0,80}`) — limitados e parando no primeiro ponto
// final pra não atravessar 2 frases. Verbos são prefixos intencionais (sem `\b`
// final): `power`→powers/powering, `advanc`→advances/advancing, `driv`→drives.
// `transform` foi REMOVIDO (review #2512): casava "Transformers" (linha de modelo
// real), rebaixando hard-block legítimo a warn.
const CONFERENCE_ROUNDUP_TITLE_RE =
  /\b(?:new|latest|all\s+(?:the\s+)?news\s+from|everything\s+(?:announced|from))\b[^.]{0,40}\bsoftware(?:s)?\b[^.]{0,40}\b(?:unlock|power|advanc|driv|enabl|fuel|revolutioniz|accelerat)\w*/i;

/**
 * #2493: `true` quando o título tem sinal de roundup de software de conferência
 * (warn-only — não alimenta isNonProductLancamento nem isVerifiedTool).
 */
export function isConferenceRoundupWarn(title?: string): boolean {
  return !!title && CONFERENCE_ROUNDUP_TITLE_RE.test(title);
}

/**
 * #1852: defesa-em-profundidade pra LANÇAMENTOS que escaparam o categorize via
 * `type_hint=lancamento` (agent vence as heurísticas). Sinais no SLUG de que a
 * URL é pesquisa/case-study, não a página oficial do produto:
 *   - conferência/pesquisa (cvpr/neurips/.../arxiv/preprint)
 *   - case study / customer story
 * Match SÓ no slug (não no título): o título de um lançamento real pode citar
 * "research" sem que a URL seja um paper. Warn-only no gate, não bloqueia.
 *
 * `cli`/`sdk` ficaram de FORA (review #1875): um CLI/SDK É software/produto, e
 * flagá-los com a mensagem "não software/hardware" seria errado + ruidoso (todo
 * lançamento de CLI/SDK cairia). O caso HF CLI já é tratado no categorize
 * (`isFirstPartyToolingBlog`, host-scoped a huggingface.co/blog/).
 */
const NON_PRODUCT_SLUG_RE =
  /\b(cvpr|neurips|iclr|icml|iccv|eccv|aaai|emnlp|naacl|siggraph|arxiv|preprint|case stud(y|ies)|customer stor(y|ies))\b/i;

/** Slug normalizado (`[-_/]→ espaço`) pra match de palavras; url crua no catch. */
function normalizedSlug(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    return url;
  }
}

/** Slug cru (path decodificado, dashes preservados) pra match de versão (`gpt-4`, `4.5`). */
function rawSlug(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

export function isNonProductLancamento(url: string, title?: string): boolean {
  const slug = normalizedSlug(url);
  return (
    NON_PRODUCT_RE.test(slug) ||
    NON_PRODUCT_SLUG_RE.test(slug) ||
    PROGRAM_SIGNAL_RE.test(slug) ||
    // #2277: para o título, só os termos de ALTA precisão (PROGRAM_SIGNAL_RE);
    // grants?/partnership ficam em PROGRAM_WARN_RE (warn-only) e NÃO hard-blockam
    // via título — evita over-block de títulos editoriais com essas palavras.
    (!!title && (NON_PRODUCT_RE.test(title) || PROGRAM_SIGNAL_RE.test(title)))
  );
}

/**
 * #2277: verifica se a URL/título tem sinal de programa de MÉDIA precisão
 * (grants?/partnership). Warn-only — NÃO alimenta isNonProductLancamento nem
 * isVerifiedTool; surfaça no gate para decisão editorial.
 */
export function isProgramWarn(url: string, title?: string): boolean {
  const slug = normalizedSlug(url);
  return (
    PROGRAM_WARN_RE.test(slug) ||
    (!!title && PROGRAM_WARN_RE.test(title))
  );
}

/**
 * #1968: verificação POSITIVA de que o item é uma FERRAMENTA (software/hardware).
 * Inverte o ônus do #1799: em vez de só flagar governança (filtro negativo),
 * exige um sinal positivo de produto. Sem sinal → `not_a_tool` (hard-block),
 * mesmo que não bata em keyword de governança — pega parceria/evento/programa/
 * relatório que passariam no filtro negativo (ex: nvidia-and-lg-group-ai-factory,
 * openai.com/index/economic-research-exchange).
 *
 * Sinais (slug normalizado + título):
 *  - verbos de lançamento (introducing/launch/announcing/released/ships/…, PT lança/disponível/…);
 *  - substantivos de produto (model/app/api/sdk/cli/chip/gpu/device/tool/platform/agent/…);
 *  - famílias de produto de IA de alta frequência (gpt/claude/gemini/llama/… —
 *    pragmático: esta é uma newsletter de IA; o allowlist cobre o resto).
 *  - número de versão no slug CRU (`gpt-4`, `4.5`, `v2`, `claude-opus-4-5`).
 */
// Nota (#1968 code-review): `update`/`feature` foram REMOVIDOS — genéricos demais
// (`company-update`, `policy-update` furavam o gate como "produto"). Lançamentos
// reais de update/feature quase sempre co-ocorrem com model/launch/família.
const PRODUCT_SIGNAL_RE =
  /\b(introduc(?:e|es|ing|ed)|launch(?:es|ing|ed)?|announc(?:e|es|ing|ed)|unveil(?:s|ing|ed)?|releas(?:e|es|ed|ing)|ship(?:s|ping|ped)?|debut(?:s|ing|ed)?|now\s?available|available\s?now|general\s?availability|early\s?access|preview|beta|model|models|app|apps|api|apis|sdk|cli|chip|chips|gpu|gpus|tpu|device|devices|hardware|wearable|robot|robots|tool|tools|toolkit|framework|library|runtime|platform|plugin|extension|agent|agents|assistant|copilot|version|product|products|lan[çc]a(?:mos|mento|r|ou)?|dispon[íi]vel|apresenta(?:ndo|m)?|estreia|atualiza[çc][ãa]o|gpt|claude|gemini|llama|mistral|grok|sora|dall\s?e|whisper|qwen|phi|flux|imagen|veo|copilot)\b/iu;

// Versão de produto no slug CRU (dashes preservados): `gpt-4`, `claude-opus-4-5`,
// `4.5`, `v2`, `7b`, `o3`. Sinal forte de modelo/produto versionado.
// #1968 code-review: o major é restrito a 1-2 dígitos pra NÃO casar ANOS — um
// `-2025` / `2026-01` / `2023-2024` (slug datado de parceria/evento/relatório)
// NÃO é versão. `gpt-4`/`gpt-4o` caem na família `gpt` do PRODUCT_SIGNAL, não
// aqui. `\d{1,3}b` = contagem de parâmetros (`7b`, `70b`, `405b`); `o[1-9]` =
// série o1-o9 da OpenAI; `[a-z]{2,}-\d{1,2}o?` = nome-de-modelo + versão de 1-2
// dígitos (`cosmos-3`, `olmo-2`, `nemotron-4`) — exige nome (≥2 letras) ANTES,
// então `lg-2025`/`build-2026` (ano, 4 díg) NÃO casam (sem boundary após 2 díg).
const VERSION_SIGNAL_RE =
  /\bv?\d{1,2}(?:[.\-]\d+)+\b|\bv\d+\b|\b\d{1,3}b\b|\bo[1-9]\b|\b[a-z]{2,}-\d{1,2}o?\b/i;

// Path segment `/product(s)/` — página oficial de produto (ex: blog.google/.../
// products/notebooklm/...). Sinal estrutural, mais forte que keyword no slug.
const PRODUCT_PATH_RE = /\/products?\//i;

/**
 * #2493: `true` para `huggingface.co/blog/{org}/{model-slug}` — post de org
 * publicado no blog da HuggingFace com 3+ segmentos de path após o host
 * (blog + org + slug). Sinal estrutural de model release / lançamento de produto
 * publicado na plataforma da HF por uma org terceira.
 *
 * Distingue de `huggingface.co/blog/{slug}` (post HF próprio — 2 segmentos)
 * e de `huggingface.co/{model-card}` (model card — sem "blog"). Não coincide
 * com `isFirstPartyToolingBlog` (CLI/SDK post em huggingface.co/blog/ com
 * 2 segmentos — ferramenta da própria HF, → noticias).
 */
function isHuggingFaceOrgBlogPost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== "huggingface.co") return false;
    const segs = u.pathname.split("/").filter(Boolean);
    // /blog/{org}/{slug} → exatamente 3 segmentos; /blog/{slug} → 2 (HF próprio).
    // Exato (não `>= 3`, review #2512): paths mais fundos (/blog/org/slug/about,
    // releases/notes) não são páginas de release de modelo.
    return segs.length === 3 && segs[0].toLowerCase() === "blog";
  } catch {
    return false;
  }
}

export function hasProductSignal(url: string, title?: string): boolean {
  const norm = normalizedSlug(url);
  const raw = rawSlug(url);
  const t = title ?? "";
  return (
    PRODUCT_PATH_RE.test(raw) ||
    // #2493: huggingface.co/blog/{org}/{slug} = org released model/tool on HF
    isHuggingFaceOrgBlogPost(url) ||
    PRODUCT_SIGNAL_RE.test(norm) ||
    PRODUCT_SIGNAL_RE.test(t) ||
    VERSION_SIGNAL_RE.test(raw) ||
    VERSION_SIGNAL_RE.test(t)
  );
}

/**
 * #1968: `true` se o item é uma ferramenta verificada. Allowlist (override pro
 * editor, slug atípico legítimo) vence tudo. Senão: governança/pesquisa/programa
 * (termos de alta precisão) → não é ferramenta (reforço #1799/#2277);
 * senão exige sinal positivo.
 *
 * Nota: grants?/partnership ficam em PROGRAM_WARN_RE (warn-only) e NÃO entram
 * em isNonProductLancamento — portanto não afetam isVerifiedTool. Isso evita
 * hard-block de lançamentos de produto que mencionem parceria no slug/título.
 */
export function isVerifiedTool(url: string, title?: string, allowlist: string[] = []): boolean {
  if (allowlist.some((a) => a && url.includes(a))) return true;
  if (isNonProductLancamento(url, title)) return false;
  return hasProductSignal(url, title);
}

/**
 * Extrai todas as URLs da seção LANÇAMENTOS do MD. Retorna array
 * de { url, line } onde line é 1-indexed.
 */
export function extractLancamentoUrls(
  text: string,
): Array<{ url: string; line: number; title?: string }> {
  const lines = text.split("\n");
  let inSection = false;
  const out: Array<{ url: string; line: number; title?: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_LANCAMENTOS_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && SECTION_BREAK_RE.test(line)) {
      // --- termina a seção
      inSection = false;
      continue;
    }
    if (inSection) {
      // Outro header de seção (ex: PESQUISAS, ## Pesquisas) também encerra.
      // #587: aceita formato Stage 1 (`## Header`) além de Stage 2 (`HEADER` solo).
      const trimmed = line.trim();
      const isPlainCaps = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed) && trimmed.length > 5;
      const isMdHeader = /^##\s+\S/.test(trimmed);
      // #1799: header bold do reviewed.md (ex `**📡 RADAR**`) também encerra —
      // senão a seção bold de LANÇAMENTOS vazaria pros próximos blocos. Exige:
      // (a) bold sem url/link (não confundir com item `**[Título](url)**`), e
      // (b) conteúdo UPPERCASE — section headers são caixa-alta (`RADAR`,
      // `USE MELHOR`), itens não (`**Produto v2**` tem minúscula → não encerra,
      // não trunca a seção). Review #1817.
      const boldInner = trimmed.replace(/^\*\*|\*\*$/g, "").trim();
      const isBoldHeader =
        /^\*\*[^*]+\*\*$/.test(trimmed) &&
        !/https?:\/\//.test(trimmed) &&
        !trimmed.includes("[") &&
        /\p{L}/u.test(boldInner) &&
        !/[a-zà-ÿ]/.test(boldInner);
      if (isPlainCaps || isMdHeader || isBoldHeader) {
        inSection = false;
        continue;
      }
      // #1978: captura o TÍTULO do formato canônico `**[Título](url)**` (ou
      // `[Título](url)`) — pra o MD-mode passar o título a isVerifiedTool igual
      // ao approved-mode (simetria: sinal de produto que vive no título não é
      // mais perdido no gate do §2).
      const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
      let md: RegExpExecArray | null;
      while ((md = mdLinkRe.exec(line)) !== null) {
        const title = md[1].trim();
        const url = md[2].replace(/[).,;]+$/, "");
        out.push({ url, line: i + 1, title });
      }
      // URLs nuas (sem título): remove primeiro os links markdown da linha pra
      // não recapturar a URL do `[t](url)` (nem a URL-âncora `[url](url)` com `]`
      // sobrando — caso contrived de teste). Linhas legacy (URL solta) seguem
      // capturadas sem título.
      const lineNoMdLinks = line.replace(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g, "");
      for (const m of lineNoMdLinks.matchAll(URL_RE)) {
        const url = m[0].replace(/[).,;]+$/, "");
        out.push({ url, line: i + 1 });
      }
    }
  }

  return out;
}

export function validateLancamentos(text: string, allowlist: string[] = []): ValidationResult {
  const urls = extractLancamentoUrls(text);
  // Markdown links [url](url) duplicate the URL — dedup by url string.
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  const invalid = unique.filter((u) => !isOfficialLancamentoUrl(u.url));
  // #1968: verificação POSITIVA — só URLs oficiais entram na conta (não-oficial
  // já é error por #160; não dupla-flagar). Sem sinal de produto → not_a_tool.
  // #1978: passa o título (capturado de `[Título](url)`) — simetria com approved-mode.
  const official = unique.filter((u) => isOfficialLancamentoUrl(u.url));
  const verified_product = official.filter((u) => isVerifiedTool(u.url, u.title, allowlist));
  // #2493: roundup de conferência → rebaixar de hard-block (not_a_tool) para
  // warn informativo (non_product). Item sem sinal de produto E com sinal de
  // roundup não bloqueia o gate — editor decide no resumo.
  const not_a_tool = official.filter(
    (u) => !isVerifiedTool(u.url, u.title, allowlist) && !isConferenceRoundupWarn(u.title),
  );
  // #1799/#2277/#2493: itens de governança/política/análise/roundup — warn (não muda
  // o status, que segue regido pela regra de domínio oficial #160 + not_a_tool #1968).
  // Inclui: (a) isNonProductLancamento (hard-block terms), (b) isProgramWarn
  // (grants?/partnership), (c) #2493 isConferenceRoundupWarn (roundup de software de
  // conferência — warn, não erro). Exclui itens já em not_a_tool para evitar
  // double-reporting do mesmo item com mensagens conflitantes (#2277).
  const not_a_tool_urls = new Set(not_a_tool.map((u) => u.url));
  // #2512: roundup-warn só se aplica a item NÃO verificado como produto. Um
  // produto real com título "roundup-like" (ex: "New PyTorch Software Powers...")
  // já está em verified_product — não duplicar como warn de non_product.
  const verified_urls = new Set(verified_product.map((u) => u.url));
  const non_product = unique.filter(
    (u) =>
      !not_a_tool_urls.has(u.url) &&
      (isNonProductLancamento(u.url, u.title) ||
        isProgramWarn(u.url, u.title) ||
        (isConferenceRoundupWarn(u.title) && !verified_urls.has(u.url))),
  );
  return {
    lancamento_count: unique.length,
    invalid_urls: invalid,
    non_product,
    verified_product,
    not_a_tool,
    // #1968: status error se URL não-oficial (#160) OU item sem sinal de produto.
    status: invalid.length === 0 && not_a_tool.length === 0 ? "ok" : "error",
  };
}

// ---------------------------------------------------------------------------
// Modo approved-json (#876) — valida `lancamento[]` no 01-approved.json
// e devolve a lista de URLs removidas para que `sync-intro-count.ts` ajuste
// menções narrativas a "X lançamentos" no intro.
// ---------------------------------------------------------------------------

export interface LancamentoRemoved {
  url: string;
  title?: string;
  reason: string;
}

export interface LancamentosRemovedSummary {
  removed: LancamentoRemoved[];
  /** #1799: itens que parecem governança/política/análise (warn, não removidos
   * automaticamente — decisão editorial no gate). */
  flagged_non_product: Array<{ url: string; title?: string }>;
  /** #1968: itens oficiais SEM sinal positivo de produto (verificação positiva
   * falhou) — hard-block (exit 1). NÃO são auto-removidos: editor decide no gate
   * (false-positive de slug atípico vai pro allowlist). */
  not_a_tool: Array<{ url: string; title?: string }>;
  original_count: number;
  final_count: number;
}

interface ApprovedShape {
  lancamento?: Array<{ url?: string; title?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Valida o array `lancamento[]` do 01-approved.json. URLs não-oficiais
 * vão para `removed` com a razão `non_official_domain`. URLs vazias são
 * ignoradas (não contam como original nem como removido).
 */
export function validateLancamentosFromApproved(
  approved: ApprovedShape,
  allowlist: string[] = [],
): LancamentosRemovedSummary {
  const list = Array.isArray(approved.lancamento) ? approved.lancamento : [];
  const removed: LancamentoRemoved[] = [];
  const flagged_non_product: Array<{ url: string; title?: string }> = [];
  const not_a_tool: Array<{ url: string; title?: string }> = [];
  let kept = 0;

  for (const item of list) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    const title = typeof item.title === "string" ? item.title : undefined;
    const official = isOfficialLancamentoUrl(url);
    if (official) {
      kept++;
    } else {
      removed.push({ url, title, reason: "non_official_domain" });
    }
    // #1968/#2493: verificação positiva só nos itens oficiais (não-oficial já é
    // removido por #160; não dupla-flagar). Sem sinal de produto → not_a_tool
    // (hard-block), EXCETO roundup de conferência (#2493) → flagged_non_product
    // (warn-only, não bloqueia o gate).
    const isNatool =
      official &&
      !isVerifiedTool(url, title, allowlist) &&
      !isConferenceRoundupWarn(title);
    if (isNatool) {
      not_a_tool.push({ url, title });
    }
    // #1799/#2277/#2493: classificação produto-vs-governança é independente do domínio —
    // openai.com/index/public-policy-agenda é oficial mas NÃO é produto. Inclui
    // também isProgramWarn (grants?/partnership) e isConferenceRoundupWarn (#2493)
    // — warn-only. Exclui itens já em not_a_tool para evitar double-reporting (#2277).
    // #2512: roundup-warn só pra item NÃO verificado como produto — um produto real
    // com título "roundup-like" não deve gerar warn espúrio de non-product.
    const roundupWarn =
      official && isConferenceRoundupWarn(title) && !isVerifiedTool(url, title, allowlist);
    if (!isNatool && (isNonProductLancamento(url, title) || isProgramWarn(url, title) || roundupWarn)) {
      flagged_non_product.push({ url, title });
    }
  }

  const original_count = kept + removed.length;
  return { removed, flagged_non_product, not_a_tool, original_count, final_count: kept };
}

function mainApproved(args: Record<string, string>, ROOT: string): void {
  const approvedPath = resolve(ROOT, args.approved);
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
  const allowlist = loadToolAllowlist(ROOT);
  const summary = validateLancamentosFromApproved(approved, allowlist);
  console.log(JSON.stringify(summary, null, 2));

  if (args["write-removed"]) {
    const outPath = resolve(ROOT, args["write-removed"]);
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  // #1799/#2277: warn de não-produto (governança/política/programa/parceria) —
  // surfaça no gate, não bloqueia (decisão editorial; pode ser oficial mas
  // não-produto, ou parceria ambígua com grants?/partnership).
  if (summary.flagged_non_product.length > 0) {
    console.error(
      `\n⚠️ ${summary.flagged_non_product.length} item(ns) de LANÇAMENTOS parece(m) governança/política/pesquisa/programa/parceria, não página oficial de produto (#1799/#1852/#2277):`,
    );
    for (const f of summary.flagged_non_product) {
      const titleHint = f.title ? ` ("${f.title.slice(0, 60)}")` : "";
      console.error(`  ${f.url}${titleHint}`);
    }
    console.error(
      "Revise no gate: LANÇAMENTOS só lista produto (modelo/app/API/ferramenta/chip/dispositivo).",
    );
  }

  if (summary.removed.length > 0) {
    console.error(
      `\n⚠️ ${summary.removed.length} de ${summary.original_count} lançamento(s) removido(s) (URL não-oficial):`,
    );
    for (const r of summary.removed) {
      const titleHint = r.title ? ` ("${r.title.slice(0, 60)}")` : "";
      console.error(`  ${r.url}${titleHint}`);
    }
  }

  // #1968: verificação POSITIVA — item oficial sem sinal de produto = not_a_tool.
  // Hard-block (exit 1) surfaçado no gate; NÃO auto-removido (editor decide /
  // allowlist em seed/lancamentos-tool-allowlist.txt pra slug atípico legítimo).
  if (summary.not_a_tool.length > 0) {
    console.error(
      `\n❌ ${summary.not_a_tool.length} item(ns) de LANÇAMENTOS sem sinal POSITIVO de produto (não parece ferramenta — parceria/evento/programa/relatório?) (#1968):`,
    );
    for (const n of summary.not_a_tool) {
      const titleHint = n.title ? ` ("${n.title.slice(0, 60)}")` : "";
      console.error(`  ${n.url}${titleHint}`);
    }
    console.error(
      "Mova pra NOTÍCIAS, ou — se for ferramenta legítima de slug atípico — adicione a URL a seed/lancamentos-tool-allowlist.txt.",
    );
  }

  if (summary.removed.length > 0 || summary.not_a_tool.length > 0) {
    process.exit(1);
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // #926: usar parser compartilhado. Adiciona suporte a --md/--in (#902) sem
  // quebrar compatibilidade com posicional `<md-path>`.
  const { values: flagArgs, positional } = parseCliArgs(process.argv.slice(2));

  // Modo approved-json (#876)
  if (flagArgs.approved) {
    mainApproved(flagArgs, ROOT);
    return;
  }

  // #902: aceita --md ou --in como alias para o posicional. Posicional ainda
  // funciona para retrocompatibilidade.
  const arg = flagArgs["md"] ?? flagArgs["in"] ?? positional[0];
  if (!arg) {
    console.error(
      "Uso: validate-lancamentos.ts <md-path>\n" +
        "  ou: validate-lancamentos.ts --md <md-path>\n" +
        "  ou: validate-lancamentos.ts --in <md-path>\n" +
        "  ou: validate-lancamentos.ts --approved <01-approved.json> [--write-removed <path>]",
    );
    process.exit(2);
  }
  const path = resolve(ROOT, arg);
  if (!existsSync(path)) {
    console.error(`Arquivo não existe: ${path}`);
    process.exit(2);
  }
  const text = readFileSync(path, "utf8");
  const allowlist = loadToolAllowlist(ROOT);
  const result = validateLancamentos(text, allowlist);
  console.log(JSON.stringify(result, null, 2));
  // #1799/#2277: warn de não-produto (governança/política/programa/parceria) —
  // informativo (o gate forte do #1968 é via not_a_tool; not_a_tool já excluído
  // de non_product para evitar double-reporting).
  if (result.non_product.length > 0) {
    console.error(
      `\n⚠️ ${result.non_product.length} item(ns) de LANÇAMENTOS parece(m) governança/política/pesquisa/programa/parceria, não página oficial de produto (#1799/#1852/#2277):`,
    );
    for (const u of result.non_product) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
  }
  if (result.invalid_urls.length > 0) {
    console.error(
      `\n❌ ${result.invalid_urls.length} URL(s) em LANÇAMENTOS não bate(m) com whitelist oficial:`,
    );
    for (const u of result.invalid_urls) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
    console.error(
      "\nReclassifique como NOTÍCIAS ou substitua por link de domínio oficial. Veja editorial-rules.md → 'Lançamentos só com link oficial'.",
    );
  }
  // #1968: verificação POSITIVA — item oficial sem sinal de produto = not_a_tool.
  if (result.not_a_tool.length > 0) {
    console.error(
      `\n❌ ${result.not_a_tool.length} item(ns) de LANÇAMENTOS sem sinal POSITIVO de produto (não parece ferramenta — parceria/evento/programa/relatório?) (#1968):`,
    );
    for (const u of result.not_a_tool) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
    console.error(
      "\nMova pra NOTÍCIAS, ou — se for ferramenta legítima de slug atípico — adicione a URL a seed/lancamentos-tool-allowlist.txt.",
    );
  }
  if (result.status === "error") {
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
