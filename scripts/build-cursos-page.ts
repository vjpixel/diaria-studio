/**
 * build-cursos-page.ts (#1745)
 *
 * Gera a página "Cursos sobre IA" da Diar.ia a partir de
 * `seed/courses/cursos-ia.json` (curadoria do editor, derivada do doc de
 * pesquisa "Busca Cursos Gratuitos IA"). Emite um HTML self-contained (dados +
 * filtros client-side inline) servido pelo Worker `cursos`.
 *
 * Espelha `build-livros-page.ts` (#1744) — mesmo design editorial Diar.ia
 * (#1936/#1935: DS canônico — Georgia serif, accent teal #00A0A0, papel #FBFAF6,
 * molduras bege #EBE5D0, texto ink), cards text-focused — mas com o
 * conjunto completo de filtros: idioma, nível, custo, formato, duração,
 * plataforma, certificado e tema. Cada dropdown só aparece se houver ≥2 valores
 * distintos (ex: se todos os cursos forem gratuitos, o filtro de custo some).
 *
 * Uso:
 *   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html
 *   npx tsx scripts/build-cursos-page.ts --check       # só valida
 */

import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { slugify } from "./lib/slug.ts"; // #1989: single source
import { escHtml as esc } from "./lib/html-escape.ts"; // #3118 item 13: era uma 3ª cópia idêntica local
import { FONTS } from "./lib/shared/design-tokens.ts"; // #1936/#1935: DS canônico
import { renderSeoMeta } from "./lib/shared/seo-meta.ts"; // #3106: meta description/OG/Twitter/canonical/favicon
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
const PAGE_TITLE = "Cursos sobre IA · Diar.ia";
const PAGE_DESCRIPTION =
  "Cursos gratuitos e pagos sobre inteligência artificial, com filtros por idioma, nível, formato, duração e plataforma — curadoria da Diar.ia.";

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
 * Renderiza a página completa no design editorial Diar.ia. Pure — recebe os
 * cursos, devolve HTML 100% self-contained (Georgia é system font — sem fonte externa).
 */
export function renderCursosPage(courses: Course[]): string {
  const cards = courses.map(renderCard).join("\n");

  // Dropdowns dinâmicos: só renderiza os que têm ≥2 valores distintos.
  const distinct = <T extends string>(vals: T[]) => [...new Set(vals)];
  const langOpts = distinct(courses.map((c) => c.language)).map((v) => ({ value: v, label: LANG_LABEL[v] }));
  const levelOpts = (["iniciante", "intermediario", "avancado"] as Level[])
    .filter((l) => courses.some((c) => c.level === l))
    .map((v) => ({ value: v, label: LEVEL_LABEL[v] }));
  const costOpts = (["free", "paid", "subscription"] as Cost[])
    .filter((x) => courses.some((c) => c.cost === x))
    .map((v) => ({ value: v, label: COST_LABEL[v] }));
  const formatOpts = (["video", "texto", "hands-on"] as Format[])
    .filter((f) => courses.some((c) => c.format === f))
    .map((v) => ({ value: v, label: FORMAT_LABEL[v] }));
  const durOpts = (["curto", "medio", "longo"] as DurationBin[])
    .filter((d) => courses.some((c) => durationBin(c.duration_hours) === d))
    .map((v) => ({ value: v, label: DURATION_LABEL[v] }));
  const platOpts = distinctPlatforms(courses).map((p) => ({ value: slugify(p), label: p }));
  const certOpts = [
    { value: "sim", label: "Com certificado" },
    { value: "nao", label: "Sem certificado" },
  ].filter((o) => courses.some((c) => (c.certificate ? "sim" : "nao") === o.value));
  const themeOpts = distinctThemes(courses).map((t) => ({ value: slugify(t), label: t }));
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

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">Diar.ia · Curadoria</p>
      <hr class="rule">
      <h1>Cursos sobre IA<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
      <p class="lede">Uma seleção de cursos sobre inteligência artificial com acesso gratuito ou auditoria livre — de fundamentos a especializações técnicas, em português e inglês. Filtre por idioma, nível, formato, duração e plataforma.</p>
      <p class="lede">Todos os links levam direto à plataforma. Auditoria gratuita dá acesso ao conteúdo; o certificado, quando pago, está marcado.</p>
    </div>
  </header>
  <div class="filters">
    <div class="wrap">
      <details class="filters-details" id="filters-details">
        <summary class="filters-summary"><span id="filters-summary-label">Filtrar (${courses.length}${
          courses.length === 1 ? " curso" : " cursos"
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
    </div>
  </main>
  ${renderCuradoriaFooter("diar.ia.br — curadoria de cursos sobre IA")}
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
</script>
</body>
</html>
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;

  let courses: Course[];
  try {
    courses = loadCourses();
  } catch (e) {
    console.error(`[build-cursos] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const v = validateCourses(courses);
  for (const w of v.warnings) process.stderr.write(`[build-cursos] ⚠ ${w}\n`);
  process.stderr.write(`[build-cursos] ${courses.length} cursos; ${distinctThemes(courses).length} temas; ${distinctPlatforms(courses).length} plataformas.\n`);

  if (check) {
    process.stderr.write("[build-cursos] --check: não escreve.\n");
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderCursosPage(courses));
  process.stderr.write(`[build-cursos] escrito: ${outPath}\n`);
  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main();
}
