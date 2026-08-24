/**
 * scripts/lib/linkedin-paste-audit.ts (#5988)
 *
 * Auditoria pós-paste do artigo semanal do LinkedIn (`/diaria-linkedin-semanal`
 * Passo 8) — verifica se o corpo colado via `ClipboardEvent` no editor do
 * LinkedIn (`context/publishers/linkedin.md` §"Newsletter LinkedIn" §"Nota
 * técnica: colagem programática") preservou as âncoras e o texto do artefato
 * fonte (`ln-{cycle}.html`).
 *
 * PURO de propósito: recebe strings/objetos já extraídos pela sessão que
 * controla o browser (só o TOP-LEVEL do Claude Code tem `mcp__claude-in-
 * chrome__*` — subagentes comuns não têm) e devolve um veredito estruturado.
 * Nenhuma chamada de rede/disco/DOM aqui — quem lê o DOM ao vivo (via
 * `javascript_tool`) e decide o que fazer com o veredito é o Passo 8 da
 * skill, não este módulo.
 *
 * Contexto do bug que motivou a auditoria (achado ao vivo 260823, PR #5987,
 * ciclo `26w34` — 1ª execução real do paste assistido): colar uma âncora
 * cujo TEXTO COMEÇA com o wordmark "diar.ia.br" (a menção pré-linkada da
 * abertura, ver `linkifyWordmark` em `weekly-linkedin-render.ts`) faz o
 * auto-linkificador do LinkedIn reconhecer a substring "diar.ia.br" DENTRO
 * do texto colado e dividir a âncora em duas: uma só com "diar.ia.br"
 * apontando pra home CRUA (sem UTM), e o resto do texto ficando com a UTM
 * original. Resultado: nenhuma âncora colada tem mais o texto completo da
 * âncora fonte, e o pedaço mais clicável (a marca em si) perdeu tracking.
 * `looksLikeBareDomainAnchorText` + o hint em `auditLinkedinPaste` existem
 * especificamente pra sinalizar esse padrão quando ele acontece de novo.
 *
 * Um perigo colateral relacionado (mesmo PR #5987): corrigir a âncora
 * dividida via clique direto sobre o link colado pode deslocar a seleção e
 * apagar OUTRO parágrafo em silêncio (na rodada real, sumiu o `<p><a>Quero
 * receber a edição diária →</a></p>` inteiro do bloco Use Melhor) — foi a
 * contagem de âncoras + `textContent.length` que pegou essa perda, dando
 * origem às checagens 1 e 4 abaixo.
 */

import { WORDMARK } from "./weekly-linkedin-render.ts";

/** Uma âncora lida de volta do editor do LinkedIn após o paste (extração ao vivo, via `javascript_tool`). */
export interface LinkedinPasteAuditPastedAnchor {
  href: string;
  /** Texto visível da âncora (`textContent`), como leu do DOM. */
  text: string;
}

export interface LinkedinPasteAuditInput {
  /**
   * Conteúdo de `ln-{cycle}.html` (a fonte de verdade — o mesmo payload que
   * foi montado pro `ClipboardEvent`, ANTES do parágrafo sentinela `<p>&nbsp;</p>`
   * que o Passo 8 acrescenta na hora do paste, ver armadilha (b) do playbook).
   */
  sourceHtml: string;
  /** Âncoras lidas de volta do corpo do editor após o paste (`document.querySelectorAll('a')` dentro do contenteditable). */
  pastedAnchors: LinkedinPasteAuditPastedAnchor[];
  /** `editor.textContent.length` lido do DOM do editor (ProseMirror) após o paste, depois de esperar estabilizar (ver "Cuidado ao inspecionar" no playbook — ler cedo demais engana). */
  pastedTextLength: number;
}

export interface LinkedinPasteAuditResult {
  ok: boolean;
  /** Mensagens em pt-BR, uma por achado — vazio quando `ok === true`. */
  issues: string[];
}

/**
 * Tolerância relativa pra divergência de `textContent.length` (checagem 4).
 * Fonte (`ln-{cycle}.html`) e colado (ProseMirror) nunca batem byte-a-byte —
 * a marcação fonte usa `parts.join("\n")` entre blocos (cada `\n` vira nó de
 * texto real), o editor normaliza espaçamento entre blocos de forma própria,
 * e entidades HTML são re-codificadas. Pra um artigo semanal típico (~3-6 mil
 * caracteres), essa diferença estrutural fica bem abaixo de 5% do total —
 * 5% dá margem confortável acima desse ruído sem ficar cego a perda real de
 * um trecho substancial (uma seção inteira, um bloco Use Melhor).
 *
 * Deliberadamente NÃO é o detector primário de perda pontual: o parágrafo de
 * CTA perdido no incidente real do PR #5987 (~35 caracteres) é uma fração
 * ínfima do total do artigo — não teria cruzado nem uma tolerância bem mais
 * apertada. Perda de link/texto pontual é pega pelas checagens 1-3 (contagem
 * e texto de âncora); esta é um sinal secundário e grosso, útil pra pegar
 * corrupção maior (seção inteira sumida, paste duplicado).
 */
export const TEXT_LENGTH_TOLERANCE_RATIO = 0.05;

/** Regex de tag HTML — usado só pra strip determinístico, não é um parser de HTML de propósito geral. */
const TAG_RE = /<[^>]+>/g;

/** Decodifica o pequeno conjunto de entidades que `escapeHtml`/marcação deste projeto produzem (ver `weekly-linkedin-render.ts`). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&"); // por último — não pode decodificar antes das outras (evita dupla-decodificação de "&amp;lt;" etc.)
}

/** Pure: remove tags HTML e decodifica entidades — aproximação de `textContent` sobre a marcação fonte. */
export function stripHtmlToText(html: string): string {
  return decodeEntities(html.replace(TAG_RE, ""));
}

/** Uma âncora extraída de HTML fonte (`sourceHtml`). */
export interface ExtractedAnchor {
  href: string;
  text: string;
}

const ANCHOR_RE = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Pure: extrai todas as âncoras `<a href="...">texto</a>` de um HTML fonte.
 * Suficiente pro que `renderLinkedinWeeklyHtml` produz (rótulos sempre texto
 * plano, sem tag aninhada dentro de `<a>`) — não é um parser de HTML geral.
 */
export function extractAnchorsFromHtml(html: string): ExtractedAnchor[] {
  const out: ExtractedAnchor[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    // `href` também precisa de decodeEntities: `escapeHtml()` (weekly-linkedin-render.ts)
    // escapa TODO `&` do href pra `&amp;`, então uma URL com 2+ query params
    // sai como `?utm_source=x&amp;utm_campaign=y` no HTML fonte. Sem decodificar
    // aqui, `new URL()` (em `getUtm`, abaixo) vê o `&amp;` literal como separador
    // de query string, e o param seguinte vira `amp;utm_campaign` — nunca bate
    // com `utm_campaign`, derrubando silenciosamente as checagens 2-3 pra TODA
    // âncora real do artefato (achado no review desta PR — sem isso o módulo
    // nunca detectava o próprio bug que existe pra pegar).
    out.push({ href: decodeEntities(m[1]), text: decodeEntities(m[2].replace(TAG_RE, "")).trim() });
  }
  return out;
}

/** Normaliza espaçamento pra comparar texto de âncora (colapsa espaços internos, apara bordas). */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface Utm {
  campaign: string | null;
  content: string | null;
  /**
   * `false` quando `href` não é uma URL parseável — distinto de "URL válida
   * sem esses params". Sem essa distinção, uma âncora com href quebrado
   * (fonte com regressão de render, ou LinkedIn corrompendo o href no paste)
   * ficaria indistinguível de "link legítimo sem UTM" e seria silenciosamente
   * pulada em vez de reportada (achado do review desta PR).
   */
  valid: boolean;
}

/** Extrai `utm_campaign`/`utm_content` de uma URL. `valid: false` (campos `null`) se `href` não for parseável como URL. */
function getUtm(href: string): Utm {
  try {
    const u = new URL(href);
    return { campaign: u.searchParams.get("utm_campaign"), content: u.searchParams.get("utm_content"), valid: true };
  } catch {
    return { campaign: null, content: null, valid: false };
  }
}

/**
 * Compara dois hrefs JÁ VALIDADOS como URL parseável (chamar só depois de
 * `getUtm(...).valid === true` nos dois lados) — usado pra âncoras da fonte
 * SEM UTM (achado do review desta PR, #5988: o link do bloco Use Melhor,
 * `um.url` em `weekly-linkedin-render.ts`, nunca carrega UTM — é a única URL
 * de conteúdo editorial externo real do artefato, e por isso a mais exposta
 * ao mesmo auto-linkificador do LinkedIn que causou o bug do PR #5987; sem
 * comparação alguma pro caso sem-UTM, um href corrompido nessa âncora
 * específica passava batido por TODAS as checagens 2-3). `new URL().toString()`
 * normaliza (scheme lowercase, encoding canônico) então diferenças puramente
 * de forma não disparam falso positivo.
 */
function hrefsEquivalent(a: string, b: string): boolean {
  return new URL(a).toString() === new URL(b).toString();
}

/**
 * Pure: detecta o padrão de texto que dispara o bug de split de âncora
 * (achado 260823, PR #5987) — texto de âncora que COMEÇA com o wordmark
 * "diar.ia.br" (com ou sem continuação, ex: "diar.ia.br, newsletter de IA").
 * Não é o mesmo guard de `endsInBareDomainLabel` (`weekly-linkedin-render.ts`),
 * que cobre o caso construído-em-render de rótulo TERMINANDO no domínio nu —
 * este cobre o caso descoberto no PASTE, de rótulo COMEÇANDO no domínio.
 *
 * Regex (não enumeração de pontuação): `WORDMARK` seguido de fim-de-string ou
 * de qualquer caractere que não seja letra/dígito — cobre vírgula, ponto,
 * dois-pontos, travessão, exclamação etc. sem precisar listar cada um (a
 * abertura semanal é reescrita a cada ciclo, a pontuação logo após a menção
 * não é previsível).
 */
const BARE_DOMAIN_ANCHOR_TEXT_RE = new RegExp(`^${WORDMARK.replace(/\./g, "\\.")}(?![a-z0-9])`, "i");
export function looksLikeBareDomainAnchorText(text: string): boolean {
  return BARE_DOMAIN_ANCHOR_TEXT_RE.test(text.trim());
}

/**
 * Audita o resultado do paste do corpo do artigo semanal do LinkedIn contra
 * o HTML fonte (`ln-{cycle}.html`). Veredito estruturado — `ok: false` é o
 * sinal pro Passo 8 da skill PARAR antes de agendar (nunca agendar um artigo
 * com link perdido/sem UTM ou conteúdo faltando).
 *
 * Checagens, na ordem:
 *   0. `sourceHtml` produziu ao menos 1 âncora? Se não, o input provavelmente
 *      está errado (ver docstring do guard) — falha alto em vez de validar
 *      um conjunto vazio como "tudo ok".
 *   1. Contagem de âncoras — fonte vs colado.
 *   2. Pra CADA âncora da fonte (com ou sem UTM — #5988 review: o link do
 *      Use Melhor, `um.url`, nunca carrega UTM e por isso ficava INTEIRAMENTE
 *      fora das checagens 2-3 antes desta correção): existe uma âncora colada
 *      com o MESMO TEXTO (normalizado)? Se não — perdida/dividida (chave é o
 *      TEXTO, não a URL base: várias âncoras deste artefato — os 3 CTAs de
 *      assinatura, a menção da abertura — compartilham a mesma base
 *      `https://diar.ia.br`, então casar por URL base seria ambíguo; o texto
 *      de cada uma é único). Href (fonte ou colado) que não parseia como URL
 *      vira issue própria, distinta de "sem UTM" — ver `Utm.valid`.
 *   3. Se encontrada por texto: âncora da fonte carrega `utm_campaign`/
 *      `utm_content`? Se sim, comparar com os da âncora colada. Se NÃO (ex:
 *      link Use Melhor) — não há UTM pra comparar, então compara o `href`
 *      bruto (normalizado, `hrefsEquivalent`) como único sinal disponível de
 *      que o link não foi trocado/corrompido no paste.
 *   4. `pastedTextLength` vs tamanho do texto da fonte, com tolerância (ver
 *      `TEXT_LENGTH_TOLERANCE_RATIO`) — sinal secundário e grosso. Um
 *      `pastedTextLength` não-finito (`NaN`/negativo) vira issue própria em
 *      vez de silenciosamente não disparar a comparação.
 */
export function auditLinkedinPaste(input: LinkedinPasteAuditInput): LinkedinPasteAuditResult {
  const issues: string[] = [];
  const sourceAnchors = extractAnchorsFromHtml(input.sourceHtml);
  const pasted = input.pastedAnchors;

  // 0. Fonte sem NENHUMA âncora é sinal de input errado, não de artigo sem
  // links: `ln-{cycle}.html` sempre tem pelo menos os 3 CTAs de assinatura
  // (ver `renderLinkedinWeeklyHtml`). Sem este guard, `sourceHtml` vazio/
  // errado por engano do caller produziria `ok: true` sem verificar nada —
  // as checagens 1-3 não têm o que iterar, e a 4 quase sempre cai dentro da
  // tolerância por coincidência de tamanhos pequenos.
  if (sourceAnchors.length === 0) {
    issues.push(
      "Nenhuma âncora encontrada em sourceHtml — confira se o conteúdo de ln-{cycle}.html foi passado " +
        "corretamente (o artefato sempre tem ao menos os 3 CTAs de assinatura). Sem âncoras de referência, " +
        "esta auditoria não valida nada.",
    );
  }

  // 1. Contagem de âncoras.
  if (sourceAnchors.length !== pasted.length) {
    issues.push(
      `Contagem de âncoras diverge: fonte tem ${sourceAnchors.length}, colado tem ${pasted.length}. ` +
        `Diferença sugere link perdido, duplicado ou dividido no paste.`,
    );
  }

  // 2-3. Por âncora da FONTE (com ou sem UTM): achar por TEXTO no colado,
  // comparar UTM (se a fonte carrega) ou href bruto (se não carrega — #5988).
  const usedPastedIdx = new Set<number>();
  for (const sa of sourceAnchors) {
    const saUtm = getUtm(sa.href);
    if (!saUtm.valid) {
      issues.push(`Âncora "${sa.text}": href da FONTE não é uma URL válida ("${sa.href}") — não foi possível auditar esta âncora.`);
      continue;
    }

    const saTextNorm = normalizeText(sa.text);
    let matchIdx = -1;
    for (let i = 0; i < pasted.length; i++) {
      if (usedPastedIdx.has(i)) continue;
      if (normalizeText(pasted[i].text) === saTextNorm) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) {
      const bugHint = looksLikeBareDomainAnchorText(sa.text)
        ? ` Texto começa com "${WORDMARK}" — padrão conhecido do bug de split de âncora (PR #5987, ver ` +
          `context/publishers/linkedin.md §"Newsletter LinkedIn"): corrigir via seleção por teclado + popup ` +
          `"Edit link" da toolbar, NUNCA clicar direto sobre o link colado (risco de deslocar a seleção e ` +
          `apagar outro parágrafo em silêncio).`
        : "";
      issues.push(`Âncora "${sa.text}" (${sa.href}) não foi encontrada no colado com o texto completo — UTM perdida ou âncora dividida.${bugHint}`);
      continue;
    }

    usedPastedIdx.add(matchIdx);
    const pastedUtm = getUtm(pasted[matchIdx].href);
    if (!pastedUtm.valid) {
      issues.push(`Âncora "${sa.text}": href COLADO não é uma URL válida ("${pasted[matchIdx].href}") — não foi possível confirmar o link.`);
      continue;
    }

    if (saUtm.campaign || saUtm.content) {
      if (saUtm.campaign && saUtm.campaign !== pastedUtm.campaign) {
        issues.push(`Âncora "${sa.text}": utm_campaign divergente — esperado "${saUtm.campaign}", colado "${pastedUtm.campaign ?? "(ausente)"}".`);
      }
      if (saUtm.content && saUtm.content !== pastedUtm.content) {
        issues.push(`Âncora "${sa.text}": utm_content divergente — esperado "${saUtm.content}", colado "${pastedUtm.content ?? "(ausente)"}".`);
      }
    } else {
      // #5988 review: âncora da fonte SEM UTM (ex: link Use Melhor, `um.url`
      // em weekly-linkedin-render.ts) — nada de UTM pra comparar, então o
      // href bruto é o único sinal disponível de que o link não foi
      // trocado/corrompido no paste (sem isso, esta âncora ficava totalmente
      // fora da auditoria — achado do review desta PR).
      if (!hrefsEquivalent(sa.href, pasted[matchIdx].href)) {
        issues.push(
          `Âncora "${sa.text}": href colado diverge do esperado — esperado "${sa.href}", colado ` +
            `"${pasted[matchIdx].href}" (esta âncora não carrega UTM, o href bruto é o único sinal disponível).`,
        );
      }
    }
  }

  // 4. Tamanho do texto — sinal secundário, tolerância relativa (ver docstring da constante).
  // Valida finitude/não-negatividade primeiro: um `pastedTextLength` quebrado
  // (extração ao vivo falhou, DOM não achado, leitura antes do editor montar)
  // produziria `NaN`, e `NaN > tolerância` é `false` em JS — a checagem
  // passaria em silêncio em vez de sinalizar que não pôde rodar.
  if (!Number.isFinite(input.pastedTextLength) || input.pastedTextLength < 0) {
    issues.push(
      `pastedTextLength inválido (${JSON.stringify(input.pastedTextLength)}) — a extração de ` +
        `editor.textContent.length falhou ou não devolveu um número; não foi possível auditar o tamanho do texto colado.`,
    );
  } else {
    const sourceTextLength = stripHtmlToText(input.sourceHtml).length;
    if (sourceTextLength > 0) {
      const diffRatio = Math.abs(input.pastedTextLength - sourceTextLength) / sourceTextLength;
      if (diffRatio > TEXT_LENGTH_TOLERANCE_RATIO) {
        const direction = input.pastedTextLength < sourceTextLength ? "menor" : "maior";
        issues.push(
          `Tamanho do texto colado diverge do esperado: fonte tem ${sourceTextLength} caracteres, colado tem ` +
            `${input.pastedTextLength} (${direction}, ${(diffRatio * 100).toFixed(1)}% de diferença — tolerância ` +
            `${(TEXT_LENGTH_TOLERANCE_RATIO * 100).toFixed(0)}%). Sinal secundário e grosso — as checagens de âncora ` +
            `acima são o detector primário de perda pontual de conteúdo.`,
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
