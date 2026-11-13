/**
 * #12926 — foto estática dos resultados, sem contatos ou envio de e-mail.
 * Uso: npx tsx scripts/form-results-artifact.ts [--root /repo] [--output parcial.html]
 * Repita --exclude-open-text "trecho com nome de terceiro" para omitir relatos
 * identificáveis após revisão humana. Não tenta adivinhar nomes próprios.
 * Saída padrão: data/reports/form-results-artifact.html (local, gitignored).
 * Lê .env de --root e o Worker ao vivo via buildFormResultsView.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { buildFormResultsView, type FormResultsView, type FormResultsDeps } from "./studio-ui/studio-onboarding-form.ts";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Respostas livres também podem conter e-mails; nunca os publicar no artefato.
const text = (s: string) => escape(s.replace(/[^\s<>"'@]+@[^\s<>"'@]+/gu, "[e-mail omitido]"));

export function renderFormResultsArtifact(view: FormResultsView, excludedTexts: readonly string[] = []): string {
  if (!view.available) throw new Error(`Resultado indisponível: ${view.motivo}`);
  if (excludedTexts.some((s) => !s.trim())) throw new Error("Filtro de relato vazio");
  const origins = [["Lote da base", view.por_origem.base], ["Onboarding (D+6)", view.por_origem.onboarding], ["Sem convite registrado", view.por_origem.sem_convite]];
  const questions = view.perguntas.map((q) => `<section><h2>${text(q.pergunta)}</h2><p>${q.responderam} responderam · ${q.tipo === "checkbox" ? "Várias opções; percentuais sobre quem respondeu" : "Escolha única"}</p>${q.opcoes.map((o) => {
    const pct = q.responderam ? Math.round(o.n / q.responderam * 100) : 0;
    return `<div class="option"><span>${text(o.opcao)}</span><strong>${o.n} (${pct}%)</strong><meter min="0" max="100" value="${pct}">${pct}%</meter></div>`;
  }).join("")}${q.fora_da_lista ? `<p>Fora da lista de opções: ${q.fora_da_lista}</p>` : ""}</section>`).join("");
  let omitted = 0;
  const open = view.abertas.map((b) => {
    const answers = b.respostas.filter((r) => {
      const hide = excludedTexts.some((s) => r.texto.toLocaleLowerCase("pt-BR").includes(s.toLocaleLowerCase("pt-BR")));
      if (hide) omitted++;
      return !hide;
    });
    return answers.length ? `<section><h3>${text(b.pergunta)}</h3><ul>${answers.map((r) => `<li><time>${text(r.data)}</time> ${text(r.texto)}</li>`).join("")}</ul></section>` : "";
  }).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Formulário da base: parcial</title>
<style>body{font:18px/1.6 system-ui,sans-serif;color:#202020;background:#f8f6f1;max-width:900px;margin:40px auto;padding:0 24px}section{background:white;padding:24px;margin:24px 0;border-radius:12px}h1,h2{line-height:1.2}h2{font-size:24px}.option{display:grid;grid-template-columns:1fr auto;gap:4px 16px;margin:16px 0}meter{width:100%;grid-column:1/-1;height:16px}li{margin:16px 0;white-space:pre-wrap;overflow-wrap:anywhere}time{color:#666}strong{white-space:nowrap}</style></head><body>
<h1>Formulário da base: parcial</h1><p>Foto estática em <time datetime="${escape(view.geradoEm)}">${escape(view.geradoEm)}</time> (UTC). Os resultados mudam com novas respostas.</p>
<section><h2>${view.total} respondentes</h2><ul>${origins.map(([label, n]) => `<li>${label}: ${n}</li>`).join("")}</ul><p>Toparam conversar: ${view.conversa.toparam}. Persona 2 (já paga para aprender): ${view.persona2} de ${view.total}.</p><p>Período das respostas: ${text(view.primeira ?? "sem respostas")} a ${text(view.ultima ?? "sem respostas")}.</p><p>${view.testes_excluidos} respostas de teste excluídas. ${view.versao_anterior} respostas de versões anteriores fora das contagens por opção (versão atual: ${view.versao_atual}).</p>${!view.storeLido ? "<p>Store do onboarding não lido: origem sem convite registrado.</p>" : ""}</section>
${questions}<h2>Respostas abertas</h2>${open || "<p>Nenhuma resposta aberta para exibir.</p>"}<p>${omitted} relatos omitidos pelos filtros de revisão. E-mails removidos dos textos livres.</p></body></html>\n`;
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
