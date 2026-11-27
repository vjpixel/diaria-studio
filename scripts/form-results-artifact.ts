/**
 * #12926 — foto estática dos resultados, sem contatos ou envio de e-mail.
 * #13979 — gera o layout PUBLICADO do artefato "Formulário da base: parcial":
 * resumo (respostas, quem topou a conversa, relatos de falha, tempo mediano),
 * perguntas numeradas com as notas de subpergunta, relatos, seção "Outro",
 * data em horário de Brasília e o design system (Georgia/Geist, teal só na
 * `.rule` e no número da pergunta). Atualizar o artefato = rodar este script e
 * publicar o HTML gerado; nenhuma data ou contagem fica fixa no código.
 *
 * Uso: npx tsx scripts/form-results-artifact.ts [--root /repo] [--output parcial.html]
 * Repita --exclude-open-text "trecho com nome de terceiro" para omitir relatos
 * identificáveis após revisão humana. Não tenta adivinhar nomes próprios.
 * Respostas triviais ("x", ".", "ok"), com até 2 caracteres ou sem letra nem
 * número, ficam fora dos relatos, da seção "Outro" e da contagem de relatos.
 * Saída padrão: data/reports/form-results-artifact.html (local, gitignored).
 * Lê .env de --root e o Worker ao vivo via buildFormResultsView.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { FORM_QUESTIONS, isChoiceQuestion, otherTextFieldId, type FormQuestion } from "./lib/onboarding-form-contract.ts";
import type { FormChoiceTally } from "./lib/onboarding-form-partial-results.ts";
import { buildFormResultsView, type FormResultsView, type FormResultsDeps } from "./studio-ui/studio-onboarding-form.ts";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Respostas livres também podem conter e-mails; nunca os publicar no artefato.
const text = (s: string) => escape(s.replace(/[^\s<>"'@]+@[^\s<>"'@]+/gu, "[e-mail omitido]"));

/** Id da pergunta aberta de relato (contada no resumo e listada à parte). */
export const RELATO_FALHA_ID = "relato_falha";

/**
 * Perguntas cujas opções são uma escala e ficam na ordem do formulário, como
 * no artefato publicado; as demais vão da mais marcada para a menos marcada.
 */
export const KEEP_OPTION_ORDER: ReadonlySet<string> = new Set(["uso_ia"]);

/** @pure — resposta livre sem conteúdo: até 2 caracteres ou sem letra nem número ("x", "ok", "..."). */
export function isTrivialOpenAnswer(texto: string): boolean {
  const t = texto.trim();
  return Array.from(t).length <= 2 || !/[\p{L}\p{N}]/u.test(t);
}

const BRT = "America/Sao_Paulo";

function brtParts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** @pure — "25/11" no horário de Brasília. */
export function formatBrtDay(iso: string): string {
  const p = brtParts(iso);
  return p ? `${p.day}/${p.month}` : iso;
}

/** @pure — "25/11, 14:58" no horário de Brasília. */
export function formatBrtDateTime(iso: string): string {
  const p = brtParts(iso);
  return p ? `${p.day}/${p.month}, ${p.hour}:${p.minute}` : iso;
}

/** @pure — tempo mediano para o resumo ("4 min", "45 s"); `null` = sem dado. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * @pure — rótulo de cada pergunta de escolha no artefato: perguntas
 * principais numeradas em sequência ("1", "2", …), subpergunta (`subOf`) com o
 * número da principal ("8 · sub"). Toda pergunta principal avança a contagem,
 * inclusive a aberta (`apoio_decisao`, a 13 da v4, #14330), para o número
 * bater com o do formulário; a aberta só não entra no mapa. A subpergunta
 * aberta não avança a contagem.
 */
export function questionNumbers(questions: readonly FormQuestion[] = FORM_QUESTIONS): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const q of questions) {
    if (q.subOf) {
      const parent = out.get(q.subOf);
      if (parent && isChoiceQuestion(q)) out.set(q.id, `${parent.split(" ")[0]} · sub`);
      continue;
    }
    n++;
    if (isChoiceQuestion(q)) out.set(q.id, String(n));
  }
  return out;
}

const quoteOpt = (o: string) => `"${o}"`;

/** @pure — notas da linha de meta da pergunta (condição de exibição, várias opções). */
export function questionNotes(q: FormQuestion, numbers: ReadonlyMap<string, string>, tally?: Pick<FormChoiceTally, "fora_da_lista">): string[] {
  const notes: string[] = [];
  const num = (id: string) => (numbers.get(id) ?? "").split(" ")[0] || id;
  if (q.shownWhen) {
    const s = q.shownWhen;
    if (s.minChecked != null) notes.push(`só aparece para quem marcou ${s.minChecked} ou mais opções na ${num(s.questionId)}`);
    else notes.push(`só aparece para quem marcou ${(s.anyOf ?? []).map(quoteOpt).join(" ou ")} na ${num(s.questionId)}`);
  }
  if (q.hiddenWhen) notes.push(`não aparece para quem marcou ${quoteOpt(q.hiddenWhen.option)} na ${num(q.hiddenWhen.questionId)}`);
  if (q.kind === "checkbox") notes.push("várias opções por pessoa, a soma passa de 100%");
  if (tally && tally.fora_da_lista > 0) notes.push(`${tally.fora_da_lista} fora da lista de opções`);
  return notes;
}

function renderQuestion(t: FormChoiceTally, q: FormQuestion | undefined, numbers: ReadonlyMap<string, string>, base: number): string {
  const opts = KEEP_OPTION_ORDER.has(t.id) ? [...t.opcoes] : [...t.opcoes].sort((a, b) => b.n - a.n);
  const max = Math.max(0, ...opts.map((o) => o.n));
  const rows = opts.map((o) => {
    const pct = t.responderam ? Math.round((o.n / t.responderam) * 100) : 0;
    const width = max ? ((o.n / max) * 100).toFixed(1) : "0.0";
    return `<div class="row${o.n === 0 ? " zero" : ""}"><div class="opt">${text(o.opcao)}</div><div class="bar"><span style="width:${width}%"></span></div><div class="num">${o.n}<small>${pct}%</small></div></div>`;
  }).join("");
  const meta = [`${t.responderam} de ${base} responderam`, ...(q ? questionNotes(q, numbers, t) : [])].join(" · ");
  const label = numbers.get(t.id) ?? "";
  return `<section class="q"><div class="qh">${label ? `<span class="qn">${escape(label)}</span>` : ""}<h3>${text(t.pergunta)}</h3></div><p class="meta">${escape(meta)}</p><div class="rows">${rows}</div></section>`;
}

const plural = (n: number, um: string, varios: string) => (n === 1 ? um : varios);

function lede(view: Extract<FormResultsView, { available: true }>): string {
  const parts: string[] = [];
  const de = view.primeira_em ? formatBrtDay(view.primeira_em) : null;
  const ate = view.ultima_em ? formatBrtDay(view.ultima_em) : null;
  const periodo = de && ate ? (de === ate ? `em ${de}` : `de ${de} a ${ate}`) : "";
  let abertura = `${view.total} ${plural(view.total, "resposta recebida", "respostas recebidas")}${periodo ? ` ${periodo}` : ""}, sem as de teste`;
  if (!view.storeLido) {
    abertura += ". A origem do convite não pôde ser lida (store do onboarding indisponível)";
  } else {
    const o = view.por_origem;
    const origens = [
      o.base ? `${o.base} ${plural(o.base, "veio", "vieram")} do convite da base` : "",
      o.onboarding ? `${o.onboarding} do convite do onboarding` : "",
      o.sem_convite ? `${o.sem_convite} sem convite registrado` : "",
    ].filter(Boolean);
    if (origens.length) abertura += `: ${origens.length > 1 ? `${origens.slice(0, -1).join(", ")} e ${origens[origens.length - 1]}` : origens[0]}`;
  }
  parts.push(`${abertura}.`);
  if (view.versao_anterior > 0) parts.push(`${view.versao_anterior} ${plural(view.versao_anterior, "resposta de uma versão anterior das perguntas fica", "respostas de versões anteriores das perguntas ficam")} fora das contagens por opção.`);
  parts.push(`Foto tirada em ${formatBrtDateTime(view.geradoEm)} (horário de Brasília): os números não se atualizam sozinhos. Nenhum e-mail aparece nesta página.`);
  return parts.join(" ");
}

const CSS = `:root{color-scheme:light;--bg:#f6f8f8;--paper:#fff;--fg:#1b2424;--muted:#5d6b6b;--line:#d9e2e2;--track:#e9efef;--teal:#00a0a0;--bar:#3b8f8f;--serif:Georgia,"Times New Roman",serif;--sans:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121818;--paper:#1a2222;--fg:#e4ecec;--muted:#9aaaaa;--line:#2c3838;--track:#243030;--teal:#2cc4c4;--bar:#4fb3b3;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121818;--paper:#1a2222;--fg:#e4ecec;--muted:#9aaaaa;--line:#2c3838;--track:#243030;--teal:#2cc4c4;--bar:#4fb3b3;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.5}
.wrap{max-width:780px;margin:0 auto;padding-block:32px 64px;padding-inline:16px;display:flex;flex-direction:column;gap:26px}
h1{font-family:var(--serif);font-weight:normal;font-size:30px;margin:0;text-wrap:balance}
h2{font-family:var(--serif);font-weight:normal;font-size:22px;margin:0}
h3{font-family:var(--serif);font-weight:normal;font-size:18px;margin:0;text-wrap:balance}
.rule{height:2px;background:var(--teal);width:56px;border:0;margin:0}
.lede{color:var(--muted);margin:0;max-width:64ch}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.fact{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.fact b{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.fact span{font-size:13px;color:var(--muted)}
.q{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:16px 18px;display:grid;gap:8px}
.qh{display:flex;gap:10px;align-items:baseline}
.qn{font-size:12px;font-weight:600;color:var(--teal);font-variant-numeric:tabular-nums;letter-spacing:.04em;white-space:nowrap}
.meta{margin:0;font-size:13px;color:var(--muted)}
.rows{display:grid;gap:6px}
.row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(60px,1fr) 64px;gap:10px;align-items:center;font-size:14px}
.row.zero{color:var(--muted)}
.opt{min-width:0}
.bar{height:10px;background:var(--track);border-radius:5px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--bar);border-radius:5px}
.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.num small{display:block;font-weight:400;font-size:12px;color:var(--muted)}
blockquote{margin:0;padding:12px 16px;background:var(--paper);border:1px solid var(--line);border-radius:6px;font-family:var(--serif);font-size:16px;line-height:1.55;white-space:pre-line;overflow-wrap:anywhere}
.quotes{display:grid;gap:10px}
.outros{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.outros li{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:10px 14px;display:grid;gap:2px;overflow-wrap:anywhere}
.outros small{color:var(--muted);font-size:12.5px}
@media (max-width:520px){.row{grid-template-columns:minmax(0,1fr) 56px}.bar{grid-column:1 / -1;grid-row:2}}`;

export function renderFormResultsArtifact(view: FormResultsView, excludedTexts: readonly string[] = [], questions: readonly FormQuestion[] = FORM_QUESTIONS): string {
  if (!view.available) throw new Error(`Resultado indisponível: ${view.motivo}`);
  if (excludedTexts.some((s) => !s.trim())) throw new Error("Filtro de relato vazio");
  const byId = new Map(questions.map((q) => [q.id, q]));
  const numbers = questionNumbers(questions);
  // Denominador das perguntas: só a versão atual entra nas contagens por opção.
  const base = view.total - view.versao_anterior;

  let omitted = 0;
  const isExcluded = (texto: string) => {
    const lower = texto.toLocaleLowerCase("pt-BR");
    return excludedTexts.some((s) => lower.includes(s.toLocaleLowerCase("pt-BR")));
  };
  const keep = (texto: string) => {
    if (isTrivialOpenAnswer(texto)) return false;
    if (isExcluded(texto)) { omitted++; return false; }
    return true;
  };

  const relatosRaw = (view.abertas.find((b) => b.id === RELATO_FALHA_ID)?.respostas ?? []).filter((r) => !isTrivialOpenAnswer(r.texto));
  const relatos = relatosRaw.filter((r) => keep(r.texto));

  const outros: { texto: string; pergunta: string }[] = [];
  for (const q of questions) {
    if (!isChoiceQuestion(q) || !q.otherOption) continue;
    const block = view.abertas.find((b) => b.id === otherTextFieldId(q));
    for (const r of block?.respostas ?? []) if (keep(r.texto)) outros.push({ texto: r.texto, pergunta: q.label });
  }

  const duracao = formatDuration(view.duracao_mediana_s);
  const facts: [string, string][] = [
    [String(view.total), plural(view.total, "resposta", "respostas")],
    [String(view.conversa.toparam), "toparam a conversa de 20 minutos"],
    [String(relatosRaw.length), "contaram uma falha da IA"],
    [duracao ?? "—", duracao ? "tempo mediano para responder" : "tempo de resposta não registrado"],
  ];

  const perguntas = view.perguntas.map((t) => renderQuestion(t, byId.get(t.id), numbers, base)).join("");
  const relatoQ = byId.get(RELATO_FALHA_ID);
  const relatoNote = relatoQ?.required ? "Pergunta aberta." : "Pergunta aberta e opcional.";
  const omittedNote = omitted > 0 ? ` ${omitted} ${plural(omitted, "texto omitido", "textos omitidos")} na revisão.` : "";

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Formulário da base: parcial</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>${CSS}
</style></head><body>
<div class="wrap">
  <header style="display:grid;gap:10px">
    <h1>Formulário da base: parcial</h1>
    <hr class="rule">
    <p class="lede">${text(lede(view))}</p>
  </header>
  <section class="facts" aria-label="Resumo">
${facts.map(([b, s]) => `    <div class="fact"><b>${escape(b)}</b><span>${escape(s)}</span></div>`).join("\n")}
  </section>
${perguntas}
  <section style="display:grid;gap:12px">
    <h2>Quando a IA não deu certo</h2>
    <p class="meta">${relatoNote} Textos como foram enviados.${omittedNote}</p>
    ${relatos.length ? `<div class="quotes">${relatos.map((r) => `<blockquote>${text(r.texto)}</blockquote>`).join("")}</div>` : `<p class="meta">Nenhum relato para exibir.</p>`}
  </section>
${outros.length ? `  <section style="display:grid;gap:12px">
    <h2>Respostas em "Outro"</h2>
    <ul class="outros">${outros.map((o) => `<li><span>${text(o.texto)}</span><small>${text(o.pergunta)}</small></li>`).join("")}</ul>
  </section>
` : ""}</div>
</body></html>
`;
}

export async function writeFormResultsArtifact(root: string, output: string, excludedTexts: readonly string[] = [], deps: FormResultsDeps = {}): Promise<void> {
  const html = renderFormResultsArtifact(await buildFormResultsView(root, deps), excludedTexts);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, html, "utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const action = applyCliAction(argv, { script: "scripts/form-results-artifact.ts", values: ["root", "output", "exclude-open-text"], usage: "Uso: npx tsx scripts/form-results-artifact.ts [--root /repo] [--output parcial.html] [--exclude-open-text trecho] (repetível). Saída padrão: data/reports/form-results-artifact.html. Revise nomes de terceiros antes de publicar. Sem envio de e-mail." });
  if (action !== null) { process.exitCode = action; return; }
  const root = resolve(getStringArg(argv, "root") ?? fileURLToPath(new URL("../", import.meta.url)));
  const output = resolve(getStringArg(argv, "output") ?? resolve(root, "data/reports/form-results-artifact.html"));
  const excluded: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exclude-open-text") excluded.push(argv[++i]);
    else if (argv[i].startsWith("--exclude-open-text=")) excluded.push(argv[i].slice("--exclude-open-text=".length));
  }
  loadProjectEnv(root);
  await writeFormResultsArtifact(root, output, excluded);
  console.log(`Artefato gravado: ${output}. Revise os relatos antes de publicar.`);
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
