/**
 * workers/onboarding-form/src/render.ts (#10605) — HTML do formulário, puro.
 *
 * Separado do `index.ts` para ser testável sem runtime de Worker
 * (`test/onboarding-form-questions-10605.test.ts`). Mobile primeiro: coluna
 * única de no máximo 560px com 16px de margem lateral, alvos de toque
 * grandes. Regra de layout por tipo: `checkbox` vira caixas sempre; `select`
 * com até `RADIO_MAX_OPTIONS` opções vira botões de rádio (tudo visível de
 * uma vez, um toque) e acima disso vira menu suspenso (uma lista de 16 rádios
 * empurraria o resto do formulário para fora da tela); `text`/`textarea`
 * são campos livres limitados a `FORM_ANSWER_MAX_LEN`.
 */

import { FORM_ANSWER_MAX_LEN, FORM_QUESTIONS, isChoiceQuestion, type FormQuestion } from "../../../scripts/lib/onboarding-form-contract.ts";
import { FORM_PAGE_MARKER } from "../../../scripts/lib/onboarding-form-link-sig.ts";

/** Acima disso uma pergunta de escolha única vira menu suspenso. */
export const RADIO_MAX_OPTIONS = 8;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = [
  ":root{--bg:#fff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#d9d9d9;--accent:#00a0a0;--field:#fff}",
  "@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#ececec;--muted:#a3a3a3;--line:#3a3a3a;--field:#1c1c1c}}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--fg);font-family:Georgia,serif;font-size:17px;line-height:1.5}",
  "main{max-width:560px;margin:0 auto;padding:24px 16px 48px}",
  "h1{font-size:1.6rem;line-height:1.25;margin:0 0 8px}",
  ".intro{color:var(--muted);margin:0 0 24px}",
  "fieldset{border:0;border-top:1px solid var(--line);margin:0;padding:20px 0}",
  "legend,.q{font-weight:bold;padding:0;margin-bottom:6px;display:block}",
  ".help{color:var(--muted);font-size:.9rem;margin:0 0 8px}",
  ".opt{display:flex;gap:10px;align-items:flex-start;padding:8px 0;cursor:pointer}",
  ".opt input{width:20px;height:20px;margin:3px 0 0;flex:none;accent-color:var(--accent)}",
  "input[type=email],select,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--fg)}",
  "textarea{min-height:110px}",
  "button{width:100%;font:inherit;font-weight:bold;padding:14px;border:0;border-radius:999px;background:var(--accent);color:#fff;cursor:pointer;margin-top:8px}",
].join("");

export function renderPage(body: string): string {
  return (
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>diar.ia.br</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  );
}

function renderQuestion(q: FormQuestion): string {
  const id = escapeHtml(q.id);
  const help = q.help ? `<p class="help">${escapeHtml(q.help)}</p>` : "";
  const req = q.required ? " required" : "";
  if (!isChoiceQuestion(q)) {
    const label = `<label class="q" for="${id}">${escapeHtml(q.label)}</label>`;
    const max = ` maxlength="${FORM_ANSWER_MAX_LEN}"`;
    if (q.kind === "textarea") return `<fieldset>${label}${help}<textarea id="${id}" name="${id}"${max}${req}></textarea></fieldset>`;
    return `<fieldset>${label}${help}<input id="${id}" name="${id}" type="text"${max}${req}></fieldset>`;
  }
  const opts = q.options;
  if (q.kind === "checkbox" || opts.length <= RADIO_MAX_OPTIONS) {
    const type = q.kind === "checkbox" ? "checkbox" : "radio";
    const items = opts
      .map((o, i) => {
        const oid = `${id}-${i}`;
        // `required` em rádio vale para o grupo; em caixa exigiria todas, então não vai.
        const r = type === "radio" ? req : "";
        return `<label class="opt" for="${oid}"><input type="${type}" id="${oid}" name="${id}" value="${escapeHtml(o)}"${r}><span>${escapeHtml(o)}</span></label>`;
      })
      .join("");
    return `<fieldset><legend>${escapeHtml(q.label)}</legend>${help}${items}</fieldset>`;
  }
  const label = `<label class="q" for="${id}">${escapeHtml(q.label)}</label>`;
  const options = opts.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  return `<fieldset>${label}${help}<select id="${id}" name="${id}"${req}><option value="">Escolha uma opção</option>${options}</select></fieldset>`;
}

/** Página do formulário para o e-mail do link assinado (#10657): o e-mail e a
 *  assinatura vão em campos OCULTOS — a pessoa vê para quem está respondendo,
 *  mas não troca o e-mail (trocar invalidaria a assinatura e o Worker recusaria). */
export function renderFormHtml(email: string, sig: string, questions: readonly FormQuestion[] = FORM_QUESTIONS): string {
  return renderPage(
    `<h1>Conte pra gente sobre você</h1>` +
      `<p class="intro">São ${questions.length} perguntas rápidas, leva uns dois minutos. ` +
      `As respostas ajudam a escolher o que entra na diar.ia.br e o que mais podemos oferecer além dela.</p>` +
      `<form method="post" action="/enviar">` +
      `<input type="hidden" name="email" value="${escapeHtml(email)}">` +
      // FORM_PAGE_MARKER: a sonda do executor reconhece a página real por este campo.
      `${FORM_PAGE_MARKER} value="${escapeHtml(sig)}">` +
      `<p class="intro">Respondendo como <strong>${escapeHtml(email)}</strong>.</p>` +
      questions.map(renderQuestion).join("") +
      `<button type="submit">Enviar respostas</button></form>`,
  );
}

export function renderThanksHtml(): string {
  return renderPage(
    `<h1>Obrigado!</h1><p>Suas respostas chegaram. Em breve você para de receber lembretes sobre este formulário.</p>` +
      `<p>Se quiser mudar alguma resposta, é só preencher de novo: vale a mais recente.</p>`,
  );
}

/** Link sem assinatura válida (#10657): nada de formulário. */
export function renderInvalidLinkHtml(): string {
  return renderPage(
    `<h1>Link inválido</h1><p>Este link do formulário não é válido ou está incompleto.</p>` +
      `<p>Abra o formulário pelo botão do e-mail que você recebeu da diar.ia.br, sem editar o endereço.</p>`,
  );
}

export function renderErrorHtml(error: string): string {
  return renderPage(`<h1>Faltou alguma coisa</h1><p>Não deu para registrar: ${escapeHtml(error)}.</p><p>Volte e confira as respostas.</p>`);
}

/**
 * Lê o corpo do formulário preservando campos repetidos (caixas de seleção
 * mandam um valor por opção marcada). Campo único fica string; repetido vira
 * lista.
 */
export function collectFormFields(entries: Iterable<[string, unknown]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string") continue;
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}
