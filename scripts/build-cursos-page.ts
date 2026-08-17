/**
 * build-cursos-page.ts (#1745)
 *
 * Gera a página "Cursos sobre IA" da diar.ia.br a partir de
 * `seed/courses/cursos-ia.json` (curadoria do editor, derivada do doc de
 * pesquisa "Busca Cursos Gratuitos IA"). Emite um HTML self-contained (dados +
 * filtros client-side inline) servido pelo Worker `cursos`.
 *
 * Espelha `build-livros-page.ts` (#1744) — mesmo design editorial diar.ia.br
 * (#1936/#1935: DS canônico — Georgia serif, accent teal #00A0A0, papel #FBFAF6,
 * molduras bege #EBE5D0, texto ink), cards text-focused — mas com o
 * conjunto completo de filtros: idioma, nível, custo, formato, duração,
 * plataforma, certificado e tema. Cada dropdown só aparece se houver ≥2 valores
 * distintos (ex: se todos os cursos forem gratuitos, o filtro de custo some).
 *
 * Uso:
 *   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html
 *   npx tsx scripts/build-cursos-page.ts --check       # só valida
 *
 * #4641: a prosa GEO (H1/H2 + FAQ, em `renderGeoIntro`/`buildCursosFaq`) passou
 * por Humanizador + `mcp__clarice__correct_text` em 260807 — mesmo padrão do
 * Stage 2 da diária (Skill("humanizador", ...) seguido de correct_text,
 * aplicando sugestões exceto o que quebra marca/identificador ou hardcoda um
 * valor hoje dinâmico). Não roda automaticamente a cada build (o seed muda por
 * curadoria manual, não diariamente) — ao reescrever essa prosa de forma
 * substancial no futuro, repetir os dois passes antes de commitar, e bump
 * `GEO_CONTENT_DATE` abaixo. As PERGUNTAS do FAQ (e o H2, que espelha a
 * pergunta principal) ficam fora do escopo do Humanizador de propósito — são
 * fraseado GEO calibrado para bater com busca real do leitor (#4558 Parte B).
 */

import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { slugify } from "./lib/slug.ts"; // #1989: single source
import { escHtml as esc } from "./lib/html-escape.ts"; // #3118 item 13: era uma 3ª cópia idêntica local
import { FONTS } from "./lib/shared/design-tokens.ts"; // #1936/#1935: DS canônico
import { renderSeoMeta, renderAnalyticsHead } from "./lib/shared/seo-meta.ts"; // #3106: meta description/OG/Twitter/canonical/favicon; #5498: container GTM
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFiltersBaseStyles,
  renderCuradoriaGridCardStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "./lib/shared/curadoria-page.ts"; // #3113: CSS/footer comuns com build-livros-page.ts
import {
  isSafeUrl,
  availableThemes,
  distinctThemes,
  loadSeedItems,
  type ValidationResult,
} from "./lib/shared/curadoria-data.ts"; // #3118 item 13: layer de dados comum com build-livros-page.ts
import { CURSOS_FOOTER_NAV_UTM } from "./lib/shared/utm-registry.ts"; // #4295 — link de rodapé sem UTM (assimetria com Livros/#4051)
import {
  formatMonthYear,
  renderGeoByline,
  renderGeoFaqSection,
  renderGeoFaqStyles,
  renderGeoJsonLd,
  type GeoFaqItem,
} from "./lib/shared/geo-faq.ts"; // #4558 Parte B: estrutura GEO (FAQ + JSON-LD FAQPage/Article + autoria)
export { esc, isSafeUrl, availableThemes, distinctThemes, type ValidationResult };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "seed/courses/cursos-ia.json");
const DEFAULT_OUT = resolve(ROOT, "data/cursos/index.html");
// #3106: URL pública canônica — Worker de assets estáticos servido em
// cursos.diar.ia.br (domínio de marca, Workers Custom Domain, #3698;
// cursos.diaria.workers.dev segue ativo só por compat de links já enviados
// em edições passadas — ver FOOTER_DOMAINS em scripts/lib/canonical-urls.ts).
// Exportado (não só usado localmente) pra permitir o teste de acoplamento
// contra CURADORIA_NAV_LINKS em scripts/lib/shared/curadoria-page.ts (#3113)
// — sem isso, mudar este domínio no futuro e esquecer o footer causaria
// exatamente o tipo de drift silencioso que essa issue existe pra eliminar.
export const PAGE_URL = "https://cursos.diar.ia.br/";
const PAGE_TITLE = "Cursos sobre IA · diar.ia.br";
const PAGE_DESCRIPTION =
  "Cursos gratuitos e pagos sobre inteligência artificial, com filtros por idioma, nível, formato, duração e plataforma — curadoria da diar.ia.br.";

/** #4558 Parte B: data ESTÁTICA (não `new Date()`) do Article JSON-LD — um
 * valor dinâmico quebraria `test/cursos-asset-drift.test.ts`/
 * `test/cursos-full-drift.test.ts` (comparam o HTML committed contra um
 * render fresco; "hoje" nunca bate com o commit de ontem). Bump manual
 * quando o conteúdo GEO (intro/FAQ) for reescrito de forma substancial —
 * não a cada atualização rotineira do seed de cursos. */
const GEO_CONTENT_DATE = "2026-08-07"; // #4641: prosa GEO (intro + FAQ) revisada por Humanizador + Clarice

// #1936/#1935: DS canônico (vjpixel/diaria-design via lib/shared/design-tokens.ts).
// Era ad-hoc (Newsreader + paleta #F5F1E8/#FFFDF8/#1A1A1A divergente do canvas
// antigo) — agora os MESMOS tokens da diária/mensal/É IA?: teal #00A0A0,
// Georgia, papel #FBFAF6, tinta #171411, molduras bege #EBE5D0.
// #3113: a maior parte do CSS (root/header/filtros-base/grid/card/footer) foi
// extraída pra scripts/lib/shared/curadoria-page.ts — só SANS segue local,
// usado no bloco de filtros mobile (#3107) e em `.platform`, que continuam
// inline aqui por serem específicos de cursos.
const SANS = FONTS.sans; // Geist → cai pra system sans

export type Language = "pt-br" | "en";
export type Level = "iniciante" | "intermediario" | "avancado";
export type Cost = "free" | "paid" | "subscription";
export type Format = "video" | "texto" | "hands-on";

export interface Course {
  id: string;
  title: string;
  platform: string;
  url: string;
  language: Language;
  level: Level;
  format: Format;
  duration_hours: number;
  duration_estimated?: boolean;
  cost: Cost;
  certificate: boolean;
  themes: string[];
  summary: string;
  /** #4052: PREFERÊNCIA de curadoria pra vaga de curso aberto — não a
   * decisão final. Quantos ficam abertos é `openCourseCount()` (20% do
   * total, decisão do editor em #4052); os marcados `true` ocupam as vagas
   * primeiro, na ordem do seed, e o restante das vagas é preenchido pelos
   * demais cursos, também na ordem do seed. Marcar mais que o teto não abre
   * mais cursos; marcar menos não deixa vaga vazia. */
  teaser?: boolean;
}

/** #4052: modo de render — `"teaser"` é o HTML PÚBLICO/estático (asset), só
 * com os cursos abertos (`selectOpenCourses`); os gated NÃO são renderizados
 * de forma alguma — nem título, nem plataforma, nem tema/contagem nos
 * filtros, só a chamada agregada "mais N cursos" (decisão do editor em
 * #4052: "o título É o produto da curadoria" — título visível já basta pra
 * pessoa googlar e achar o curso). `"full"` é o HTML servido pelo Worker SÓ
 * depois do gate passar (nunca committed como asset estático) — todos os
 * cursos completos, igual ao comportamento pré-#4052. */
export type CursosRenderMode = "teaser" | "full";

/** #4052 (decisão do editor, 260727): fração do catálogo que fica aberta sem
 * e-mail. Calculada dinamicamente sobre o total — pra o número de abertos
 * acompanhar o catálogo em vez de ficar fixo no código/seed. */
export const TEASER_OPEN_RATIO = 0.2;

/** Quantos cursos ficam abertos no HTML público, dado o tamanho do catálogo. */
export function openCourseCount(total: number): number {
  return Math.floor(total * TEASER_OPEN_RATIO);
}

/**
 * Subconjunto que fica ABERTO no modo teaser: os marcados `teaser: true`
 * primeiro, depois os demais na ordem do seed, cortando em
 * `openCourseCount(total)`. Pure.
 *
 * Nota pra quem cura o seed: ao marcar `teaser: true`, prefira cobrir pt-br/en
 * e plataformas distintas — é o que os marcados de hoje fazem, mas o código
 * não impõe nada disso.
 */
export function selectOpenCourses(courses: Course[]): Course[] {
  const limit = openCourseCount(courses.length);
  const marked = courses.filter((c) => c.teaser);
  const rest = courses.filter((c) => !c.teaser);
  return [...marked, ...rest].slice(0, limit);
}

const LEVEL_LABEL: Record<Level, string> = {
  iniciante: "Iniciante",
  intermediario: "Intermediário",
  avancado: "Avançado",
};
const LANG_LABEL: Record<Language, string> = { "pt-br": "Português", en: "Inglês" };
const COST_LABEL: Record<Cost, string> = { free: "Gratuito", paid: "Pago", subscription: "Assinatura" };
const FORMAT_LABEL: Record<Format, string> = { video: "Vídeo", texto: "Texto", "hands-on": "Hands-on" };

/** Bin de duração (#1745): curto <5h, médio 5–20h, longo >20h. */
export type DurationBin = "curto" | "medio" | "longo";
export function durationBin(hours: number): DurationBin {
  if (hours < 5) return "curto";
  if (hours <= 20) return "medio";
  return "longo";
}
const DURATION_LABEL: Record<DurationBin, string> = {
  curto: "Curto (<5h)",
  medio: "Médio (5–20h)",
  longo: "Longo (>20h)",
};

// #1989: slugify movido pra scripts/lib/slug.ts (single source — cursos page +
// slug SEO de post). Import local (usado abaixo) + re-export back-compat.
export { slugify };

/** Duração "1h 15m" / "4h 45m" / "30h". Pure. */
export function fmtDuration(h: number, estimated?: boolean): string {
  // #3118 (item 5, relacionado): duration_hours ausente/inválida (NaN, undefined
  // via JSON solto sem checagem de tipo em runtime) renderizava "NaNh" — vazio é
  // um fallback mais honesto que um número quebrado visível ao leitor. A ausência
  // já é só warning (não bloqueia o build), então o card renderiza sem a duração.
  if (!Number.isFinite(h)) return "";
  let whole = Math.floor(h);
  let mins = Math.round((h - whole) * 60);
  // #3118 (item 5): rounding sem carry — h=5.995 dava whole=5, mins=Math.round(0.995*60)=60,
  // emitindo "5h 60m" (60 minutos não é uma duração válida). Carrega pra hora
  // seguinte quando o arredondamento de mins bate exatamente 60.
  if (mins === 60) {
    whole += 1;
    mins = 0;
  }
  const base = mins > 0 ? `${whole}h ${mins}m` : `${whole}h`;
  return estimated ? `~${base}` : base;
}

/**
 * Valida a lista de cursos. Pure — testável sem IO.
 * Erros (bloqueiam): campos obrigatórios, id duplicado, enums inválidos.
 * Warnings: url com esquema inválido, duração ausente/≤0.
 */
export function validateCourses(courses: Course[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const c of courses) {
    const where = c.id || c.title || "(sem id)";
    if (!c.id) errors.push(`curso sem id: "${c.title ?? where}"`);
    else if (seen.has(c.id)) errors.push(`id duplicado: ${c.id}`);
    else seen.add(c.id);
    if (!c.title) errors.push(`${where}: title ausente`);
    if (!c.summary) errors.push(`${where}: summary ausente`);
    if (!c.platform) errors.push(`${where}: platform ausente`);
    if (!c.url) errors.push(`${where}: url ausente`);
    else if (!isSafeUrl(c.url)) warnings.push(`${where}: url com esquema inválido: ${c.url}`);
    if (c.language !== "pt-br" && c.language !== "en") errors.push(`${where}: language inválida (${c.language})`);
    if (!(c.level in LEVEL_LABEL)) errors.push(`${where}: level inválido (${c.level})`);
    if (!(c.cost in COST_LABEL)) errors.push(`${where}: cost inválido (${c.cost})`);
    if (!(c.format in FORMAT_LABEL)) errors.push(`${where}: format inválido (${c.format})`);
    if (typeof c.certificate !== "boolean") errors.push(`${where}: certificate deve ser boolean`);
    if (!Array.isArray(c.themes)) errors.push(`${where}: themes deve ser array`);
    if (typeof c.duration_hours !== "number" || c.duration_hours <= 0) {
      warnings.push(`${where}: duration_hours ausente/inválida`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Plataformas distintas (ordenadas). Pure. */
export function distinctPlatforms(courses: Course[]): string[] {
  return [...new Set(courses.map((c) => c.platform).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Lê e valida o seed. Lança em JSON inválido / erros de schema. */
export function loadCourses(seedPath = SEED_PATH): Course[] {
  return loadSeedItems<Course>(seedPath, "courses", validateCourses);
}

/**
 * Monta as perguntas/respostas do FAQ a partir do dataset REAL de cursos —
 * nunca números inventados (#4558 item 6). Usa o CATÁLOGO COMPLETO (não só
 * os abertos no teaser) pras CONTAGENS agregadas — o banner de gate já
 * expõe a contagem total de cursos fechados pro mesmo leitor, então uma
 * contagem a mais não vaza nada que a página já não diga. NUNCA nomeia
 * plataforma/tema/curso específico aqui (#4052/#4305, `test/cursos-teaser-leak.test.ts`):
 * um nome de plataforma pode ser EXCLUSIVO de um curso gated (ex:
 * "Fundação Bradesco (Escola Virtual)"), e a composição de quais cursos
 * ficam abertos no teaser muda conforme o seed — um número é seguro em
 * qualquer composição, um nome não é. Pure.
 */
export function buildCursosFaq(courses: Course[]): GeoFaqItem[] {
  const total = courses.length;
  const free = courses.filter((c) => c.cost === "free").length;
  const comCertificado = courses.filter((c) => c.certificate).length;
  const ptBr = courses.filter((c) => c.language === "pt-br").length;
  const en = total - ptBr;
  const iniciante = courses.filter((c) => c.level === "iniciante").length;
  const plataformas = distinctPlatforms(courses).length;
  const open = openCourseCount(total);

  // #4641: respostas revisadas por Humanizador + Clarice (mcp__clarice__correct_text) —
  // travessão de conector/definição removido (regra #20 do humanizador), gerúndio em
  // cascata evitado, contrações formalizadas conforme sugestão da Clarice. As
  // PERGUNTAS ficam intocadas de propósito: são fraseado GEO calibrado pra bater com
  // busca real do leitor (#4558 Parte B) — reescrevê-las é decisão editorial, não
  // higienização de prosa.
  return [
    {
      question: "Quais são os melhores cursos gratuitos de inteligência artificial?",
      answer: `Esta curadoria reúne ${total} cursos sobre inteligência artificial, dos quais ${free} têm acesso gratuito ou auditoria livre. ${comCertificado} deles emitem certificado sem custo ao concluir. ${open} ficam abertos diretamente na página, e o restante é desbloqueado para assinantes da diar.ia.br.`,
    },
    {
      question: "Tem curso de inteligência artificial em português?",
      answer: `Sim, ${ptBr} dos ${total} cursos da lista são em português, cobrindo desde fundamentos de IA até IA generativa e ética. Os outros ${en} estão em inglês, geralmente cursos mais técnicos.`,
    },
    {
      question: "Quantas plataformas de cursos de IA a diar.ia.br já curou?",
      answer: `A curadoria já cobre ${plataformas} plataformas diferentes, de universidades a empresas de tecnologia. Cada card de curso indica a plataforma de origem antes do link, sendo possível filtrar por ela na página.`,
    },
    {
      question: "Esses cursos de IA dão certificado?",
      answer: `${comCertificado} dos ${total} cursos da lista emitem certificado sem custo ao concluir. Procure o selo específico no card do curso, ou utilize o filtro de "Certificado" na página.`,
    },
    {
      question: "Tem curso de IA pra iniciante, sem experiência técnica?",
      answer: `Sim, ${iniciante} dos ${total} cursos são classificados como nível iniciante, sem pré-requisito de programação. Use o filtro de "Nível" para visualizar apenas esses títulos.`,
    },
    {
      question: "Como faço pra desbloquear todos os cursos da lista?",
      answer:
        "Uma parte do catálogo está disponível sem cadastro; o restante é liberado para assinantes ativos da diar.ia.br (verificação automática por e-mail) ou para quem se cadastra pelo banner no topo da página.",
    },
    {
      question: "Os links dos cursos levam direto pra plataforma de origem?",
      answer:
        "Sim, todos os links direcionam para o curso na plataforma original que oferece o conteúdo. A diar.ia.br não hospeda arquivos, apenas faz a curadoria e organização.",
    },
    {
      question: "Essa lista de cursos de IA é atualizada?",
      answer:
        "Sim, a curadoria é mantida manualmente pelo editor da diar.ia.br e cresce sem periodicidade fixa. A melhor forma de acompanhar as novidades é assinar a newsletter diária.",
    },
  ];
}

/** Parágrafo introdutório (issue #4558 item 1: responde a pergunta principal
 * por inteiro nos primeiros ~200 palavras, sem enrolação) + H2 em formato de
 * pergunta literal (item 2). Fica no header, antes dos filtros. Mesma
 * disciplina de `buildCursosFaq`: só contagens agregadas, nunca nome de
 * plataforma/tema específico (poderia ser exclusivo de um curso gated). */
function renderGeoIntro(courses: Course[]): string {
  const total = courses.length;
  const free = courses.filter((c) => c.cost === "free").length;
  const comCertificado = courses.filter((c) => c.certificate).length;
  const plataformas = distinctPlatforms(courses).length;
  return `    <div class="geo-intro-wrap">
      <h2 class="geo-h2">Quais são os melhores cursos gratuitos de inteligência artificial?</h2>
      <p class="geo-intro">Esta página reúne ${total} cursos sobre inteligência artificial de ${plataformas} plataformas diferentes: ${free} deles com acesso gratuito ou auditoria livre, e ${comCertificado} com certificado sem custo ao concluir. A curadoria abrange desde fundamentos de IA e IA generativa até especializações técnicas, em português e inglês. Filtre por idioma, nível, formato, duração e plataforma logo abaixo, ou role até o final para as perguntas frequentes com os números completos da curadoria.</p>
${renderGeoByline(undefined, `atualizado em ${formatMonthYear(GEO_CONTENT_DATE)}`)}
    </div>`;
}

function renderCard(c: Course): string {
  const dur = `<span class="note">${esc(fmtDuration(c.duration_hours, c.duration_estimated))}</span>`;
  const cta = isSafeUrl(c.url)
    ? `<a class="cta" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Ver curso <span aria-hidden="true">→</span></a>`
    : `<span class="cta cta--off" aria-disabled="true">Link em breve</span>`;
  const titleInner = isSafeUrl(c.url)
    ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>`
    : esc(c.title);
  const certBadge = c.certificate ? `<span class="badge badge--cert">Certificado grátis</span>` : "";
  const badges = [
    `<span class="badge badge--lang">${esc(LANG_LABEL[c.language])}</span>`,
    `<span class="badge">${esc(LEVEL_LABEL[c.level])}</span>`,
    `<span class="badge">${esc(COST_LABEL[c.cost])}</span>`,
    `<span class="badge">${esc(FORMAT_LABEL[c.format])}</span>`,
    certBadge,
    ...c.themes.map((t) => `<span class="badge">${esc(t)}</span>`),
  ].join("");
  return `      <article class="card"
        data-lang="${esc(c.language)}"
        data-level="${esc(c.level)}"
        data-cost="${esc(c.cost)}"
        data-format="${esc(c.format)}"
        data-duration="${esc(durationBin(c.duration_hours))}"
        data-platform="${esc(slugify(c.platform))}"
        data-cert="${c.certificate ? "sim" : "nao"}"
        data-themes="${esc(c.themes.map(slugify).join(" "))}">
        <div class="title-row">
          <h2>${titleInner}</h2>
          ${dur}
        </div>
        <p class="platform">${esc(c.platform)}</p>
        <p class="badges">${badges}</p>
        <p class="summary">${esc(c.summary)}</p>
        ${cta}
      </article>`;
}

/** Monta um <select> de filtro. Retorna "" se houver <2 opções (dropdown inútil). */
function renderFilter(id: string, label: string, opts: Array<{ value: string; label: string }>): string {
  if (opts.length < 2) return "";
  const options = opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  return `      <label>${esc(label)}
        <select id="${id}"><option value="">Todos</option>${options}</select>
      </label>`;
}

/**
 * Renderiza a página completa no design editorial diar.ia.br. Pure — recebe os
 * cursos, devolve HTML 100% self-contained (Georgia é system font — sem fonte externa).
 */
export function renderCursosPage(courses: Course[], mode: CursosRenderMode = "full"): string {
  // #4052/#4305: no teaser, os cursos gated NÃO entram no render de forma
  // alguma — nem título, nem plataforma, nem tema/contagem nos filtros. O
  // catálogo completo morre AQUI: `renderPageBody` recebe só os visíveis e a
  // contagem dos escondidos, então nenhuma derivação lá dentro consegue
  // alcançar um curso fechado nem por engano — `courses` não existe naquele
  // escopo. A primeira versão do gate errou exatamente assim (condicional
  // repetida em cada derivação, uma delas esquecida), e comentário não segura
  // isso; escopo segura.
  //
  // #4558 Parte B: intro/FAQ GEO são a ÚNICA exceção deliberada — contagens
  // AGREGADAS do catálogo completo (idioma, certificado, plataforma), nunca
  // título/link/tema de curso individual. Mesma categoria de informação que
  // o banner de gate já expõe ("Mais N cursos curados"), só que quebrada em
  // mais dimensões. Por isso são computadas AQUI (onde `courses` completo
  // ainda existe) e passadas como STRING/array já pronto pra
  // `renderPageBody` — o boundary de "curso individual nunca atravessa"
  // continua intacto, só o agregado atravessa.
  const geoIntroHtml = renderGeoIntro(courses);
  const geoFaq = buildCursosFaq(courses);
  const openIds = new Set((mode === "teaser" ? selectOpenCourses(courses) : courses).map((c) => c.id));
  const visible = courses.filter((c) => openIds.has(c.id));
  return renderPageBody(visible, courses.length - visible.length, mode, geoIntroHtml, geoFaq);
}

/**
 * Corpo do render. Recebe SÓ os cursos visíveis — nunca o catálogo completo
 * (ver `renderCursosPage`). `hiddenCount` é a única informação NUMÉRICA
 * sobre os fechados que atravessa a fronteira; `geoIntroHtml`/`geoFaq` são
 * agregados GEO já renderizados/computados no caller (ver nota acima) —
 * strings/estruturas prontas, nunca objetos `Course` individuais.
 */
function renderPageBody(
  visible: Course[],
  hiddenCount: number,
  mode: CursosRenderMode,
  geoIntroHtml: string,
  geoFaq: GeoFaqItem[],
): string {
  const cards = visible.map(renderCard).join("\n");
  // #4052: banner de gate — só no modo teaser, e só quando há pelo menos 1
  // curso fechado (se um dia o catálogo couber inteiro na cota aberta, o
  // banner não faz sentido e não aparece).
  const gateBanner =
    mode === "teaser" && hiddenCount > 0
      ? `  <div class="gate-banner">
    <div class="wrap gate-banner-wrap">
      <p>🔒 Mais ${hiddenCount} ${hiddenCount === 1 ? "curso curado" : "cursos curados"} para assinantes da diar.ia.br.</p>
      <form id="gate-banner-form" class="gate-banner-form" novalidate>
        <input type="email" id="gate-banner-email" name="email" placeholder="seu@email.com" aria-label="E-mail" autocomplete="email" required>
        <input type="text" name="website" class="gate-banner-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <button type="submit" id="gate-banner-submit">Desbloquear</button>
      </form>
      <p class="gate-banner-msg" id="gate-banner-msg" role="status"></p>
      <p class="gate-banner-alt"><a href="/gate">Ainda não assina a diar.ia.br? Cadastre-se aqui →</a></p>
    </div>
  </div>
`
      : "";

  // Dropdowns dinâmicos: só renderiza os que têm ≥2 valores distintos.
  const distinct = <T extends string>(vals: T[]) => [...new Set(vals)];
  const langOpts = distinct(visible.map((c) => c.language)).map((v) => ({ value: v, label: LANG_LABEL[v] }));
  const levelOpts = (["iniciante", "intermediario", "avancado"] as Level[])
    .filter((l) => visible.some((c) => c.level === l))
    .map((v) => ({ value: v, label: LEVEL_LABEL[v] }));
  const costOpts = (["free", "paid", "subscription"] as Cost[])
    .filter((x) => visible.some((c) => c.cost === x))
    .map((v) => ({ value: v, label: COST_LABEL[v] }));
  const formatOpts = (["video", "texto", "hands-on"] as Format[])
    .filter((f) => visible.some((c) => c.format === f))
    .map((v) => ({ value: v, label: FORMAT_LABEL[v] }));
  const durOpts = (["curto", "medio", "longo"] as DurationBin[])
    .filter((d) => visible.some((c) => durationBin(c.duration_hours) === d))
    .map((v) => ({ value: v, label: DURATION_LABEL[v] }));
  const platOpts = distinctPlatforms(visible).map((p) => ({ value: slugify(p), label: p }));
  const certOpts = [
    { value: "sim", label: "Com certificado" },
    { value: "nao", label: "Sem certificado" },
  ].filter((o) => visible.some((c) => (c.certificate ? "sim" : "nao") === o.value));
  const themeOpts = distinctThemes(visible).map((t) => ({ value: slugify(t), label: t }));
  // review #1891: mapa COMPLETO slug→label (todos os temas) embutido no script.
  // Sem ele, rebuildThemes lia o label das <option> ATUAIS — que encolhem a cada
  // rebuild — e um narrow-then-widen (ex: idioma EN→PT) mostrava o slug cru.
  const themeLabelJson = JSON.stringify(Object.fromEntries(themeOpts.map((o) => [o.value, o.label]))).replaceAll(
    "<",
    "\\u003c",
  ); // </script>-safe embed

  const filters = [
    renderFilter("f-lang", "Idioma", langOpts),
    renderFilter("f-level", "Nível", levelOpts),
    renderFilter("f-cost", "Custo", costOpts),
    renderFilter("f-format", "Formato", formatOpts),
    renderFilter("f-duration", "Duração", durOpts),
    renderFilter("f-platform", "Plataforma", platOpts),
    renderFilter("f-cert", "Certificado", certOpts),
    renderFilter("f-theme", "Tema", themeOpts),
  ]
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
${renderSeoMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, url: PAGE_URL })}
${renderAnalyticsHead()}
${renderGeoJsonLd({
  pageUrl: PAGE_URL,
  headline: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  datePublished: GEO_CONTENT_DATE,
  dateModified: GEO_CONTENT_DATE,
  faq: geoFaq,
})}
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderCuradoriaFiltersBaseStyles()}
  .filters .wrap { padding-top: 0; padding-bottom: 0; }
  .filters-summary { display: none; }
  .filters-body { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 22px; padding-top: 16px; padding-bottom: 16px; }

  /* #3107: abaixo de ~700px os 8 dropdowns empilhavam em 5-6 linhas (~330px)
     sticky permanentemente no topo — ~40% da tela do mobile durante todo o
     scroll da lista. Colapsa num <details>/botão "Filtrar (N cursos)" de 1
     linha, sticky, expandindo só ao toque. Acima de 700px (desktop),
     comportamento inalterado — .filters-body sempre visível via a regra base
     acima, a media query abaixo só se aplica no recorte mobile. */
  @media (max-width: 700px) {
    .filters-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      cursor: pointer; list-style: none; padding: 14px 0;
      font-family: ${SANS}; font-size: 13px; font-weight: 700; letter-spacing: 0.04em; color: var(--ink); }
    .filters-summary::-webkit-details-marker { display: none; }
    .filters-summary::after { content: '\\25BE'; color: var(--teal); font-size: 12px; }
    .filters-details[open] .filters-summary::after { content: '\\25B4'; }
    .filters-body { display: none; flex-direction: column; align-items: stretch; gap: 16px; padding: 4px 0 16px; }
    .filters-details[open] .filters-body { display: flex; }
    .filters-body .count { display: none; } /* contagem já aparece no botão "Filtrar (N cursos)" */
  }

${renderCuradoriaGridCardStyles()}
  .platform { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.04em; color: var(--ink); margin: 6px 0 0; }
  .badge--cert { border-color: var(--ink); color: var(--ink); }

  /* #4052: banner de gate (teaser). Não existe estilo de "card bloqueado" —
     curso gated não é renderizado, só contabilizado no banner. */
  .gate-banner { background: var(--teal); color: #FFFFFF; padding: 14px 0; }
  .gate-banner .wrap { max-width: 1120px; }
  .gate-banner p { margin: 0; font-family: ${SANS}; font-size: 13px; }
  .gate-banner a { color: #FFFFFF; text-decoration: underline; font-weight: 700; }
  .gate-banner-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .gate-banner-form { display: flex; gap: 8px; flex: none; }
  .gate-banner-form input[type="email"] { padding: 7px 10px; border: 0; border-radius: 4px; font-size: 13px; font-family: ${SANS}; width: 220px; max-width: 46vw; }
  .gate-banner-form button { padding: 7px 14px; border: 0; border-radius: 4px; background: var(--ink); color: #FFFFFF; font-weight: 700; font-size: 13px; font-family: ${SANS}; cursor: pointer; }
  .gate-banner-form button:disabled { opacity: 0.6; cursor: default; }
  .gate-banner-hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; overflow: hidden; }
  .gate-banner-msg { margin: 0; font-family: ${SANS}; font-size: 12px; min-height: 0; flex-basis: 100%; }
  .gate-banner-alt { margin: 0; font-family: ${SANS}; font-size: 12px; opacity: 0.9; }
  @media (max-width: 640px) { .gate-banner-wrap { flex-direction: column; align-items: flex-start; } .gate-banner-form { width: 100%; } .gate-banner-form input[type="email"] { width: auto; flex: 1; max-width: none; } }

${renderGeoFaqStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
${gateBanner}  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Curadoria</p>
      <hr class="rule">
      <h1>Cursos sobre IA<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
${geoIntroHtml}
      <p class="lede">Todos os links levam direto à plataforma. Auditoria gratuita dá acesso ao conteúdo; o certificado, quando pago, está marcado.</p>
    </div>
  </header>
  <div class="filters">
    <div class="wrap">
      <details class="filters-details" id="filters-details">
        <summary class="filters-summary"><span id="filters-summary-label">Filtrar (${visible.length}${
          visible.length === 1 ? " curso" : " cursos"
        })</span></summary>
        <div class="filters-body">
${filters}
          <span class="count" id="count"></span>
        </div>
      </details>
    </div>
  </div>
  <main>
    <div class="wrap">
      <div class="grid" id="grid">
${cards}
        <p class="empty" id="empty" style="display:none">Nenhum curso com esses filtros.</p>
      </div>
${renderGeoFaqSection(geoFaq, { sectionId: "faq-cursos" })}
    </div>
  </main>
  ${renderCuradoriaFooter(
    "diar.ia.br — curadoria de cursos sobre IA",
    `utm_source=${CURSOS_FOOTER_NAV_UTM.source}&utm_medium=${CURSOS_FOOTER_NAV_UTM.medium}`,
  )}
<script>
  (function () {
    var THEME_LABELS = ${themeLabelJson};
    var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
    var countEl = document.getElementById('count');
    var emptyEl = document.getElementById('empty');
    // #3107: label do botão mobile "Filtrar (N cursos)" — mesma contagem
    // filtrada de countEl, reusada abaixo em apply().
    var summaryLabelEl = document.getElementById('filters-summary-label');
    // Filtros simples (1 valor por card): id do select → dataset key.
    var SIMPLE = { 'f-lang': 'lang', 'f-level': 'level', 'f-cost': 'cost', 'f-format': 'format', 'f-duration': 'duration', 'f-platform': 'platform', 'f-cert': 'cert' };
    function el(id) { return document.getElementById(id); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
    var fTheme = el('f-theme');
    // #1745: dropdown de Tema dinâmico — só temas com >=1 curso no recorte dos
    // outros filtros ativos, pra nenhuma opção zerar a lista. Preserva seleção.
    function matchesExceptTheme(c) {
      for (var id in SIMPLE) {
        var sel = el(id);
        if (sel && sel.value && c.dataset[SIMPLE[id]] !== sel.value) return false;
      }
      return true;
    }
    function rebuildThemes() {
      if (!fTheme) return;
      var set = {};
      cards.forEach(function (c) {
        if (matchesExceptTheme(c)) (c.dataset.themes || '').split(' ').forEach(function (t) { if (t) set[t] = 1; });
      });
      // value→label vem do mapa COMPLETO embutido (THEME_LABELS), não das options
      // atuais — senão um rebuild anterior que encolheu as options apagaria o label.
      var themes = Object.keys(set).sort(function (a, b) { return (THEME_LABELS[a] || a).localeCompare(THEME_LABELS[b] || b, 'pt-BR'); });
      var cur = fTheme.value;
      var keep = themes.indexOf(cur) >= 0 ? cur : '';
      fTheme.innerHTML = '<option value="">Todos</option>' + themes.map(function (t) { return '<option value="' + esc(t) + '">' + esc(THEME_LABELS[t] || t) + '</option>'; }).join('');
      fTheme.value = keep;
    }
    function apply() {
      var theme = fTheme ? fTheme.value : '', visible = 0;
      cards.forEach(function (c) {
        var ok = matchesExceptTheme(c)
          && (!theme || (' ' + (c.dataset.themes || '') + ' ').indexOf(' ' + theme + ' ') !== -1);
        c.style.display = ok ? '' : 'none';
        if (ok) visible++;
      });
      countEl.textContent = visible + (visible === 1 ? ' curso' : ' cursos');
      emptyEl.style.display = visible === 0 ? '' : 'none';
      if (summaryLabelEl) summaryLabelEl.textContent = 'Filtrar (' + visible + (visible === 1 ? ' curso)' : ' cursos)');
    }
    Object.keys(SIMPLE).forEach(function (id) {
      var sel = el(id);
      if (sel) sel.addEventListener('change', function () { rebuildThemes(); apply(); });
    });
    if (fTheme) fTheme.addEventListener('change', apply);
    apply();
  })();
  // #4052 (banner de gate): tenta /gate/verify (assinante já ativo →
  // desbloqueia sem sair da página). Sem match, manda pro /gate completo
  // (que tem o form de cadastro com opt-in) em vez de tentar caber o
  // cadastro inteiro no banner.
  (function () {
    var form = document.getElementById('gate-banner-form');
    if (!form) return;
    var msg = document.getElementById('gate-banner-msg');
    var btn = document.getElementById('gate-banner-submit');
    function setMsg(text) { msg.textContent = text; }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      btn.disabled = true;
      var email = document.getElementById('gate-banner-email').value.trim();
      var website = form.website.value;
      setMsg('Verificando…');
      fetch('/gate/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, website: website }),
      }).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
        .then(function (r) {
          btn.disabled = false;
          if (r.data && r.data.ok) { setMsg('Verificado! Redirecionando…'); window.location.href = '/'; return; }
          if (r.status === 429) { setMsg('Muitas tentativas. Tente novamente em alguns minutos.'); return; }
          // #4305: 503 é erro NOSSO (gate mal configurado), não e-mail errado
          // da pessoa. Sem este ramo, uma falha de config manda o leitor
          // assinar de novo achando que o e-mail dele é que não presta.
          if (r.status === 503) { setMsg('O desbloqueio está temporariamente indisponível. Tente daqui a pouco.'); return; }
          setMsg('Não encontramos assinatura ativa com esse e-mail. Use o link abaixo pra assinar e desbloquear.');
        })
        .catch(function () { btn.disabled = false; setMsg('Erro de rede. Tente novamente.'); });
    });
  })();
</script>
</body>
</html>
`;
}

// #4052: módulo TS gerado (committed, mesmo padrão de
// workers/poll/src/ds-tokens.generated.ts) com o HTML FULL pré-renderizado —
// o Worker importa a constante em runtime, nunca re-renderiza a partir do
// seed (que não é lido em runtime Workers — sem fs). Regenerar junto do
// asset teaser sempre que o seed mudar; test/cursos-full-drift.test.ts
// trava o drift no CI.
const DEFAULT_GEN_FULL = resolve(ROOT, "workers/cursos/src/courses-full.generated.ts");

function renderGenFullModule(courses: Course[]): string {
  const html = renderCursosPage(courses, "full");
  return `/**
 * courses-full.generated.ts (#4052) — GERADO, NÃO EDITAR À MÃO.
 *
 * Fonte: seed/courses/cursos-ia.json → scripts/build-cursos-page.ts --gen-full.
 * HTML completo (todos os cursos, sem gate) servido pelo Worker cursos SÓ
 * depois que o gate passa (verificação de assinante ativo ou cookie de
 * sessão válido) — nunca exposto como asset estático fetchable. Regenerar:
 *
 *   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html --gen-full workers/cursos/src/courses-full.generated.ts
 *
 * test/cursos-full-drift.test.ts garante que este arquivo reflete o seed.
 */
export const CURSOS_FULL_HTML = ${JSON.stringify(html)};
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;
  const genFullIdx = argv.indexOf("--gen-full");
  const genFullPath = genFullIdx >= 0 ? resolve(argv[genFullIdx + 1]) : DEFAULT_GEN_FULL;

  let courses: Course[];
  try {
    courses = loadCourses();
  } catch (e) {
    console.error(`[build-cursos] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const v = validateCourses(courses);
  for (const w of v.warnings) process.stderr.write(`[build-cursos] ⚠ ${w}\n`);
  const open = selectOpenCourses(courses);
  process.stderr.write(
    `[build-cursos] ${courses.length} cursos (${open.length} abertos no teaser = floor(${TEASER_OPEN_RATIO}×${courses.length}); ${courses.length - open.length} só pra assinante); ${distinctThemes(courses).length} temas; ${distinctPlatforms(courses).length} plataformas.\n`,
  );

  if (check) {
    process.stderr.write("[build-cursos] --check: não escreve.\n");
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderCursosPage(courses, "teaser"));
  process.stderr.write(`[build-cursos] escrito (teaser): ${outPath}\n`);

  mkdirSync(dirname(genFullPath), { recursive: true });
  writeFileAtomic(genFullPath, renderGenFullModule(courses));
  process.stderr.write(`[build-cursos] escrito (full, gerado): ${genFullPath}\n`);

  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main();
}
