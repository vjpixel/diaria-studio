/**
 * brevo-template-lint.ts (#14357)
 *
 * Check determinístico da Brevo Template Language (BTL) ANTES de criar ou
 * agendar uma campanha. A Brevo só valida placeholders e filtros na hora do
 * DISPARO: a campanha com filtro inválido é aceita no `POST`/`PUT`
 * `/emailCampaigns`, fica `queued` e é suspensa no horário agendado com "The
 * placeholders you used to personalize the email are incorrect", sem enviar
 * nada (campanha Clarice #438, 27/11/2026: `{{ contact.NOME | lower |
 * capitalize }}`; `capitalize` não existe na BTL, o equivalente é `capfirst`).
 *
 * Fonte das regras: o guia oficial `email-template-check` /
 * `email-template-write` da Brevo (conector MCP, `get_brevo_guide`, lido em
 * 27/11/2026). A BTL é a pongo2 (Django-style) mais filtros próprios da
 * Brevo. O check é uma ALLOWLIST: filtro fora da lista é erro, porque é
 * exatamente o caso que só falha no disparo.
 *
 * Ponto de invocação (item 27 das regras de dispatch): `brevoPost`/`brevoPut`
 * de `brevo-client.ts` chamam `assertBrevoCampaignPayloadTemplateValid` antes
 * do `fetch` para toda escrita em `/emailCampaigns[/{id}]` e
 * `/smtp/templates[/{id}]`. Todos os caminhos que agendam campanha Brevo
 * (`clarice-schedule-group.ts`, `clarice-schedule-sends.ts`,
 * `clarice-schedule-ramp.ts`, `publish-daily-brevo.ts`, `publish-monthly.ts`,
 * `onboarding-welcome-run.ts`, `clarice-cta-ab-setup.ts`,
 * `clarice-reapply-scheduled-html.ts`) passam por esses dois wrappers. Para
 * envio avulso (HTML colado no painel), o CLI `scripts/brevo-template-lint.ts`.
 *
 * Módulo puro: sem I/O, sem deps.
 */

/** Filtros pongo2 embutidos (Django-style), aceitos pela Brevo. */
const PONGO2_FILTERS = [
  "add", "addslashes", "capfirst", "center", "cut", "date", "default",
  "default_if_none", "divisibleby", "escape", "escapejs", "first", "float",
  "floatformat", "get_digit", "integer", "iriencode", "join", "last", "length",
  "length_is", "linebreaks", "linebreaksbr", "linenumbers", "ljust", "lower",
  "make_list", "phone2numeric", "pluralize", "random", "removetags", "rjust",
  "safe", "slice", "split", "stringformat", "striptags", "time", "title",
  "truncatechars", "truncatechars_html", "truncatewords", "truncatewords_html",
  "upper", "urlencode", "urlize", "urlizetrunc", "wordcount", "wordwrap", "yesno",
] as const;

/** Filtros próprios da Brevo (guia `email-template-write`, seção "Useful filters"). */
const BREVO_FILTERS = [
  "base64_encode", "batch_slice", "contains_any", "date_i18n", "hash_sha256",
  "json_encode", "lang_format", "time_add_date", "time_add_duration",
  "time_in_location", "time_parse", "time_parse_rfc3339",
] as const;

export const BREVO_ALLOWED_FILTERS: ReadonlySet<string> = new Set<string>([
  ...PONGO2_FILTERS,
  ...BREVO_FILTERS,
]);

/** Dica de troca para filtros inválidos conhecidos (vêm de Liquid/Twig/Jinja). */
const FILTER_HINTS: Readonly<Record<string, string>> = {
  capitalize: 'use "capfirst" (ou {% if contact.X %}…{% endif %} sem filtro)',
  downcase: 'use "lower"',
  upcase: 'use "upper"',
  raw: 'não existe na Brevo; para HTML de param use "safe"',
  number_format: 'não existe na Brevo; use "floatformat:2"',
  trim: 'não existe na Brevo',
  strip: 'não existe na Brevo',
  e: 'não existe na Brevo (valores já são escapados)',
};

/** Tags de bloco aceitas (`{% tag ... %}`). */
export const BREVO_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "if", "elif", "else", "endif",
  "for", "empty", "endfor",
  "set",
  "with", "endwith",
  "autoescape", "endautoescape",
  "spaceless", "endspaceless",
  "filter", "endfilter",
  "firstof", "cycle", "now",
]);

export interface BrevoTemplateIssue {
  /** Campo do payload (`htmlContent`, `subject`, `previewText`) ou `text` no CLI. */
  field: string;
  /** Trecho do template que falhou (a tag inteira, truncada). */
  snippet: string;
  message: string;
}

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Remove `<style>…</style>`: CSS minificado tem `}}` que não é tag. */
function stripStyleBlocks(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => " ".repeat(m.length));
}

/**
 * Separa a expressão por `|` fora de aspas. Devolve [valor, ...filtros].
 */
function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of expr) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "|") {
      // `||` não é operador na BTL; trata como dois pipes (filtro vazio acusa).
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function checkFilters(field: string, tag: string, expr: string, out: BrevoTemplateIssue[]): void {
  const parts = splitPipes(expr);
  for (const raw of parts.slice(1)) {
    const f = raw.trim();
    if (f === "") {
      out.push({ field, snippet: clip(tag), message: "filtro vazio (`|` sem nome de filtro)" });
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/s.exec(f);
    if (!m) {
      out.push({ field, snippet: clip(tag), message: `filtro ilegível: "${clip(f, 40)}"` });
      continue;
    }
    const name = m[1];
    const rest = m[2].trim();
    if (rest.startsWith("(")) {
      out.push({
        field,
        snippet: clip(tag),
        message: `filtro "${name}" com argumento entre parênteses; a Brevo só aceita a forma com dois-pontos (| ${name}:"x")`,
      });
      continue;
    }
    if (rest !== "" && !rest.startsWith(":")) {
      out.push({ field, snippet: clip(tag), message: `filtro "${name}" com sobra inesperada: "${clip(rest, 40)}"` });
      continue;
    }
    if (!BREVO_ALLOWED_FILTERS.has(name)) {
      const hint = FILTER_HINTS[name.toLowerCase()];
      out.push({
        field,
        snippet: clip(tag),
        message: `filtro "${name}" não existe na Brevo Template Language; a campanha seria suspensa no disparo${hint ? ` (${hint})` : ""}`,
      });
    }
  }
}

const CURLY_QUOTES = /[‘’“”]/;

/**
 * Lint de UM texto (HTML, assunto ou preview). Devolve a lista de problemas;
 * lista vazia = passa.
 */
export function lintBrevoTemplate(text: string, field = "text"): BrevoTemplateIssue[] {
  const out: BrevoTemplateIssue[] = [];
  if (typeof text !== "string" || text === "") return out;

  // `{#` abre comentário de template até `#}`; numa campanha costuma ser
  // acidente (CSS, texto) e esconde o resto do e-mail. Vale também no <style>.
  const commentIdx = text.indexOf("{#");
  if (commentIdx >= 0) {
    out.push({
      field,
      snippet: clip(text.slice(commentIdx, commentIdx + 40)),
      message: "\"{#\" abre comentário de template na Brevo; remova ou separe os caracteres",
    });
  }

  const body = stripStyleBlocks(text);
  const stack: { tag: "if" | "for" | "with" | "autoescape" | "spaceless" | "filter"; snippet: string }[] = [];
  const re = /\{\{|\{%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = m[0];
    const close = open === "{{" ? "}}" : "%}";
    const end = body.indexOf(close, m.index + 2);
    if (end < 0) {
      out.push({ field, snippet: clip(body.slice(m.index, m.index + 60)), message: `"${open}" sem "${close}" correspondente` });
      break;
    }
    const tag = body.slice(m.index, end + 2);
    let inner = body.slice(m.index + 2, end);
    re.lastIndex = end + 2;

    // Trim markers `{{-`/`-}}`, `{%-`/`-%}`.
    inner = inner.replace(/^-/, "").replace(/-$/, "");

    if (inner.includes("{{") || inner.includes("{%")) {
      out.push({ field, snippet: clip(tag), message: "tag aberta dentro de outra tag" });
      continue;
    }
    if (/<[a-zA-Z/]/.test(inner)) {
      out.push({ field, snippet: clip(tag), message: "HTML dentro da tag de template" });
      continue;
    }
    if (/&(quot|#34|#39|apos|amp|lt|gt);/.test(inner)) {
      out.push({ field, snippet: clip(tag), message: "entidade HTML dentro da tag de template (use aspas retas)" });
      continue;
    }
    if (CURLY_QUOTES.test(inner)) {
      out.push({ field, snippet: clip(tag), message: "aspas curvas dentro da tag de template (use aspas retas)" });
      continue;
    }

    if (open === "{{") {
      if (inner.trim() === "") {
        out.push({ field, snippet: clip(tag), message: "variável vazia \"{{ }}\"" });
        continue;
      }
      checkFilters(field, tag, inner, out);
      continue;
    }

    // Bloco `{% name args %}`.
    const tm = /^\s*([A-Za-z_]+)\b\s*([\s\S]*)$/.exec(inner);
    if (!tm) {
      out.push({ field, snippet: clip(tag), message: "tag de bloco sem nome" });
      continue;
    }
    const name = tm[1];
    const args = tm[2];
    if (!BREVO_ALLOWED_TAGS.has(name)) {
      out.push({ field, snippet: clip(tag), message: `tag "{% ${name} %}" não é aceita pela Brevo Template Language` });
      continue;
    }
    if (args.includes("|")) checkFilters(field, tag, args, out);

    const top = stack[stack.length - 1];
    switch (name) {
      case "if":
      case "for":
      case "with":
      case "autoescape":
      case "spaceless":
      case "filter":
        stack.push({ tag: name, snippet: clip(tag) });
        break;
      case "elif":
        if (top?.tag !== "if") out.push({ field, snippet: clip(tag), message: "\"elif\" fora de um {% if %}" });
        break;
      case "else":
        if (top?.tag === "for") {
          out.push({ field, snippet: clip(tag), message: "\"{% else %}\" dentro de {% for %}; na Brevo use {% empty %}" });
        } else if (top?.tag !== "if") {
          out.push({ field, snippet: clip(tag), message: "\"else\" fora de um {% if %}" });
        }
        break;
      case "empty":
        if (top?.tag !== "for") out.push({ field, snippet: clip(tag), message: "\"empty\" fora de um {% for %}" });
        break;
      default:
        if (name.startsWith("end")) {
          const want = name.slice(3);
          if (top?.tag === want) stack.pop();
          else out.push({ field, snippet: clip(tag), message: `"${name}" sem {% ${want} %} aberto` });
        }
    }
  }
  for (const open of stack) {
    out.push({ field, snippet: open.snippet, message: `{% ${open.tag} %} sem {% end${open.tag} %}` });
  }
  return out;
}

/** Campos do payload de campanha/template que a Brevo renderiza com a BTL. */
export const BREVO_TEMPLATED_FIELDS = ["htmlContent", "subject", "previewText"] as const;

/**
 * Paths cuja escrita leva conteúdo renderizado pela BTL: criar/atualizar
 * campanha e template transacional. `/emailCampaigns/{id}/sendNow`,
 * `/sendTest` etc. ficam de fora (não levam conteúdo).
 */
const TEMPLATED_PATH_RE = /^\/(emailCampaigns|smtp\/templates)(\/\d+)?\/?(\?.*)?$/;

export function isBrevoTemplatedWritePath(path: string): boolean {
  return TEMPLATED_PATH_RE.test(path);
}

export function lintBrevoCampaignPayload(body: unknown): BrevoTemplateIssue[] {
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  const out: BrevoTemplateIssue[] = [];
  for (const field of BREVO_TEMPLATED_FIELDS) {
    const v = rec[field];
    if (typeof v === "string") out.push(...lintBrevoTemplate(v, field));
  }
  return out;
}

export function formatBrevoTemplateIssues(issues: readonly BrevoTemplateIssue[]): string {
  return issues.map((i) => `  - [${i.field}] ${i.message}: ${i.snippet}`).join("\n");
}

export class BrevoTemplateLintError extends Error {
  readonly issues: readonly BrevoTemplateIssue[];
  constructor(path: string, issues: readonly BrevoTemplateIssue[]) {
    super(
      `[#14357] Brevo Template Language inválida em ${path} — a Brevo aceitaria a escrita e ` +
        `suspenderia a campanha no disparo. Nada foi enviado à API.\n${formatBrevoTemplateIssues(issues)}`,
    );
    this.name = "BrevoTemplateLintError";
    this.issues = issues;
  }
}

/**
 * Guard chamado por `brevoPost`/`brevoPut` antes do `fetch`. Lança
 * `BrevoTemplateLintError` se o payload de uma escrita de campanha/template
 * tiver BTL inválida; no-op para qualquer outro path.
 */
export function assertBrevoCampaignPayloadTemplateValid(path: string, body: unknown): void {
  if (!isBrevoTemplatedWritePath(path)) return;
  const issues = lintBrevoCampaignPayload(body);
  if (issues.length > 0) throw new BrevoTemplateLintError(path, issues);
}
