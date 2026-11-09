/**
 * workers/onboarding-form/src/render.ts (#10605) — HTML do formulário, puro.
 *
 * Separado do `index.ts` para ser testável sem runtime de Worker
 * (`test/onboarding-form-questions-10605.test.ts`). Mobile primeiro: coluna
 * única de no máximo 560px com 16px de margem lateral, alvos de toque
 * grandes. Toda pergunta de escolha vira botões de rádio (`select`) ou caixas
 * (`checkbox`), nunca menu suspenso (v3, decisão do editor de 09/11/2026: a
 * área tem 13 opções e aparece inteira). `text`/`textarea` são campos livres
 * limitados a `FORM_ANSWER_MAX_LEN`.
 *
 * Perguntas numeradas (sem `subOf`) levam o número no `<legend>`; as
 * subperguntas não têm número: o relato de falha (texto) fica DENTRO do
 * fieldset da pergunta-mãe, e as de escolha (escolha única, gasto mensal)
 * vêm num fieldset próprio logo depois. Só as opcionais levam "opcional".
 *
 * Progressive enhancement: sem JavaScript tudo aparece e o servidor valida
 * (`parseFormSubmission`). Com JavaScript, `FORM_SCRIPT`:
 *  - esconde e DESABILITA as perguntas condicionais (`data-hide-q`/`data-hide-opt`
 *    para `hiddenWhen`, `data-show-q` + `data-show-any`/`data-show-min` para
 *    `shownWhen`): campo desabilitado não vai no POST;
 *  - na escolha única (`data-pick-from`), só mostra as opções marcadas na
 *    pergunta de origem;
 *  - aplica a opção exclusiva (`data-exclusive`) e o limite de caixas
 *    (`data-max`) em tempo real;
 *  - mostra e habilita o campo do "Outro/Outra" (`{id}_outro`, `maxlength`
 *    `FORM_OTHER_TEXT_MAX_LEN`) só com a opção marcada.
 * A ordem importa: condicionais primeiro, "Outro" depois (reabrir uma
 * pergunta reabilita os campos dela).
 */

import {
  FORM_ANSWER_MAX_LEN,
  FORM_MULTI_SEPARATOR,
  FORM_OTHER_TEXT_MAX_LEN,
  FORM_QUESTIONS,
  isChoiceQuestion,
  numberedQuestions,
  otherTextFieldId,
  type ChoiceQuestion,
  type FormQuestion,
} from "../../../scripts/lib/onboarding-form-contract.ts";
import { FORM_PAGE_MARKER, FORM_RENDERED_FIELD } from "../../../scripts/lib/onboarding-form-link-sig.ts";

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
  "fieldset{border:0;border-top:1px solid var(--line);margin:0;padding:20px 0;min-width:0}",
  "fieldset.sub{border-top:0;padding-top:4px}",
  "legend,.q{font-weight:bold;padding:0;margin-bottom:6px;display:block}",
  ".n{color:var(--muted);font-weight:normal;margin-right:6px}",
  ".req{color:var(--muted);font-weight:normal;font-size:.85rem;margin-left:6px}",
  ".help{color:var(--muted);font-size:.9rem;margin:0 0 8px}",
  ".opt{display:flex;gap:10px;align-items:flex-start;padding:8px 0;cursor:pointer}.opt[hidden]{display:none}",
  ".opt input{width:20px;height:20px;margin:3px 0 0;flex:none;accent-color:var(--accent)}",
  ".q.sub{margin-top:12px}",
  // `[hidden]` explícito: o `display:block` da classe venceria o atributo `hidden` do script.
  ".other{display:block;margin:2px 0 8px 30px}.other[hidden]{display:none}",
  "input[type=email],input[type=text],textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--fg)}",
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

/** Script do formulário (ES5, inline). Ver o cabeçalho do módulo. */
export const FORM_SCRIPT =
  "(function(){var f=document.querySelector('form');if(!f)return;var SEP=" + JSON.stringify(FORM_MULTI_SEPARATOR) + ";" +
  "function vals(n){var r=[],c=f.querySelectorAll('[name=\"'+n+'\"]');for(var i=0;i<c.length;i++){var x=c[i];if(x.disabled)continue;if((x.type==='checkbox'||x.type==='radio')?x.checked:x.value!=='')r.push(x.value);}return r;}" +
  "function dis(fs,on){var x=fs.querySelectorAll('input,textarea');for(var k=0;k<x.length;k++)x[k].disabled=on;}" +
  "function u(){var l=f.querySelectorAll('fieldset');for(var i=0;i<l.length;i++){var fs=l[i],off=false;" +
  "var hq=fs.getAttribute('data-hide-q');if(hq&&vals(hq).indexOf(fs.getAttribute('data-hide-opt'))>=0)off=true;" +
  "var sq=fs.getAttribute('data-show-q');if(sq){var v=vals(sq),any=fs.getAttribute('data-show-any'),min=fs.getAttribute('data-show-min');" +
  "if(any){var ok=false,a=any.split(SEP);for(var j=0;j<a.length;j++)if(v.indexOf(a[j])>=0)ok=true;if(!ok)off=true;}" +
  "if(min&&v.length<Number(min))off=true;}" +
  "fs.hidden=off;dis(fs,off);" +
  "var pf=fs.getAttribute('data-pick-from');if(pf&&!off){var src=vals(pf),o=fs.querySelectorAll('.opt[data-pick]');" +
  "for(var p=0;p<o.length;p++){var on=src.indexOf(o[p].getAttribute('data-pick'))>=0,inp=o[p].querySelector('input');o[p].hidden=!on;inp.disabled=!on;if(!on)inp.checked=false;}}}" +
  "var w=f.querySelectorAll('.other[data-other-for]');for(var m=0;m<w.length;m++){var e=w[m],s=vals(e.getAttribute('data-other-for')).indexOf(e.getAttribute('data-other-opt'))>=0;" +
  "e.hidden=!s;var t=e.querySelectorAll('input');for(var q=0;q<t.length;q++)t[q].disabled=!s;}}" +
  "f.addEventListener('change',function(ev){var t=ev.target;if(t&&t.type==='checkbox'&&t.checked){var fs=t.closest('fieldset');" +
  "var ex=fs&&fs.getAttribute('data-exclusive'),mx=fs&&fs.getAttribute('data-max'),g=f.querySelectorAll('input[type=checkbox][name=\"'+t.name+'\"]');" +
  "if(ex){for(var i=0;i<g.length;i++){if(g[i]===t)continue;if(t.value===ex||g[i].value===ex)g[i].checked=false;}}" +
  "if(mx){var n=0;for(var k=0;k<g.length;k++)if(g[k].checked)n++;if(n>Number(mx))t.checked=false;}}u();});u();})();";

/** Alias antigo (v2): o script cresceu, o nome ficou. */
export const HIDE_SCRIPT = FORM_SCRIPT;

/** Campo de texto curto do "Outro/Outra" (sempre visível sem JavaScript). */
function otherTextField(q: ChoiceQuestion): string {
  if (!q.otherOption) return "";
  const tid = escapeHtml(otherTextFieldId(q));
  return (
    `<span class="other" data-other-for="${escapeHtml(q.id)}" data-other-opt="${escapeHtml(q.otherOption)}">` +
    `<input type="text" id="${tid}" name="${tid}" maxlength="${FORM_OTHER_TEXT_MAX_LEN}" ` +
    `placeholder="Qual? (opcional)" aria-label="${escapeHtml(q.otherOption)}: qual? (opcional)"></span>`
  );
}

function fieldsetOpen(q: FormQuestion): string {
  const attrs: string[] = [];
  if (q.subOf) attrs.push(`class="sub"`);
  if (q.hiddenWhen) attrs.push(`data-hide-q="${escapeHtml(q.hiddenWhen.questionId)}" data-hide-opt="${escapeHtml(q.hiddenWhen.option)}"`);
  if (q.shownWhen) {
    attrs.push(`data-show-q="${escapeHtml(q.shownWhen.questionId)}"`);
    if (q.shownWhen.anyOf) attrs.push(`data-show-any="${escapeHtml(q.shownWhen.anyOf.join(FORM_MULTI_SEPARATOR))}"`);
    if (q.shownWhen.minChecked != null) attrs.push(`data-show-min="${q.shownWhen.minChecked}"`);
  }
  if (isChoiceQuestion(q)) {
    if (q.optionsFrom) attrs.push(`data-pick-from="${escapeHtml(q.optionsFrom)}"`);
    if (q.exclusiveOption) attrs.push(`data-exclusive="${escapeHtml(q.exclusiveOption)}"`);
    if (q.maxChoices != null) attrs.push(`data-max="${q.maxChoices}"`);
  }
  return attrs.length === 0 ? "<fieldset>" : `<fieldset ${attrs.join(" ")}>`;
}

const OPTIONAL = `<span class="req">opcional</span>`;

/** Pergunta condicional: sem `required` no HTML (sem JavaScript ela aparece
 *  sempre e não pode travar o envio de quem não precisa respondê-la). */
function isConditional(q: FormQuestion): boolean {
  return q.hiddenWhen != null || q.shownWhen != null;
}

function renderOpenSub(q: FormQuestion): string {
  const id = escapeHtml(q.id);
  const ph = "placeholder" in q && q.placeholder ? ` placeholder="${escapeHtml(q.placeholder)}"` : "";
  const label = `<label class="q sub" for="${id}">${escapeHtml(q.label)}${q.required ? "" : ` ${OPTIONAL}`}</label>`;
  const tag = q.kind === "textarea" ? "textarea" : "input";
  const field =
    tag === "textarea"
      ? `<textarea id="${id}" name="${id}" maxlength="${FORM_ANSWER_MAX_LEN}"${ph}></textarea>`
      : `<input id="${id}" name="${id}" type="text" maxlength="${FORM_ANSWER_MAX_LEN}"${ph}>`;
  return label + field;
}

function renderQuestion(q: FormQuestion, number: number | null, inner: readonly FormQuestion[]): string {
  const id = escapeHtml(q.id);
  const fs = fieldsetOpen(q);
  const help = q.help ? `<p class="help">${escapeHtml(q.help)}</p>` : "";
  const num = number != null ? `<span class="n">${number}</span>` : "";
  const legend = `<legend>${num}${escapeHtml(q.label)}${q.required ? "" : ` ${OPTIONAL}`}</legend>`;
  const innerHtml = inner.map(renderOpenSub).join("");
  if (!isChoiceQuestion(q)) {
    const req = q.required && !isConditional(q) ? " required" : "";
    const max = ` maxlength="${FORM_ANSWER_MAX_LEN}"`;
    const field = q.kind === "textarea" ? `<textarea id="${id}" name="${id}"${max}${req}></textarea>` : `<input id="${id}" name="${id}" type="text"${max}${req}>`;
    return `${fs}<label class="q" for="${id}">${num}${escapeHtml(q.label)}${q.required ? "" : ` ${OPTIONAL}`}</label>${help}${field}${innerHtml}</fieldset>`;
  }
  const type = q.kind === "checkbox" ? "checkbox" : "radio";
  // `required` em rádio vale para o grupo; em caixa exigiria todas, então não vai.
  const req = type === "radio" && q.required && !isConditional(q) ? " required" : "";
  const items = q.options
    .map((o, i) => {
      const oid = `${id}-${i}`;
      const pick = q.optionsFrom ? ` data-pick="${escapeHtml(o)}"` : "";
      const opt = `<label class="opt" for="${oid}"${pick}><input type="${type}" id="${oid}" name="${id}" value="${escapeHtml(o)}"${req}><span>${escapeHtml(o)}</span></label>`;
      return o === q.otherOption ? opt + otherTextField(q) : opt;
    })
    .join("");
  const before = q.helpAfter ? "" : help;
  const after = q.helpAfter ? help : "";
  return `${fs}${legend}${before}${items}${after}${innerHtml}</fieldset>`;
}

/** Página do formulário para o e-mail do link assinado (#10657): o e-mail e a
 *  assinatura vão em campos OCULTOS — a pessoa vê para quem está respondendo,
 *  mas não troca o e-mail (trocar invalidaria a assinatura e o Worker
 *  recusaria). `renderedToken` (`signFormRenderedAt`) vai no campo
 *  `FORM_RENDERED_FIELD`: com ele o envio grava o tempo de preenchimento. */
export function renderFormHtml(
  email: string,
  sig: string,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
  renderedToken: string | null = null,
): string {
  const parts: string[] = [];
  let n = 0;
  for (const q of questions) {
    // Texto livre de subpergunta vai dentro do fieldset da mãe.
    if (q.subOf && !isChoiceQuestion(q) && questions.some((x) => x.id === q.subOf)) continue;
    const inner = questions.filter((x) => x.subOf === q.id && !isChoiceQuestion(x));
    parts.push(renderQuestion(q, q.subOf ? null : ++n, inner));
  }
  const needsScript = questions.some((q) => isConditional(q) || (isChoiceQuestion(q) && (q.otherOption || q.exclusiveOption || q.maxChoices != null || q.optionsFrom)));
  return renderPage(
    `<h1>Pode me contar um pouco sobre você?</h1>` +
      `<form method="post" action="/enviar">` +
      `<input type="hidden" name="email" value="${escapeHtml(email)}">` +
      // FORM_PAGE_MARKER: a sonda do executor reconhece a página real por este campo.
      `${FORM_PAGE_MARKER} value="${escapeHtml(sig)}">` +
      (renderedToken ? `<input type="hidden" name="${FORM_RENDERED_FIELD}" value="${escapeHtml(renderedToken)}">` : "") +
      `<p class="intro">Respondendo como <strong>${escapeHtml(email)}</strong>. ` +
      `As respostas ficam comigo e servem só para planejar a newsletter e o que oferecer além dela. ` +
      `São até ${numberedQuestions(questions).length} perguntas. Só as marcadas como opcionais podem ficar em branco.</p>` +
      parts.join("") +
      `<button type="submit">Enviar respostas</button></form>` +
      (needsScript ? `<script>${FORM_SCRIPT}</script>` : ""),
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
