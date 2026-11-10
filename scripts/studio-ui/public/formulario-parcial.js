// formulario-parcial.js (#12583) — HTML do painel "Formulário: resultado
// parcial" da página /assinantes, sobre o JSON de
// GET /api/onboarding/form-results (`FormResultsView`,
// scripts/studio-ui/studio-onboarding-form.ts). Lógica pura (sem DOM), para
// o teste importar; assinantes.js só põe o resultado na página.
//
// A visão agregada não mostra e-mail. O único e-mail sai em
// `conversaHtml`, que a página põe num bloco à parte.

import { escapeHtml } from "./assinantes-actions.js";

const ORIGEM_LABEL = Object.freeze({
  base: "lote da base",
  onboarding: "onboarding (D+6)",
  sem_convite: "sem convite registrado",
});

function pct(n, total) {
  if (!total) return "—";
  return `${Math.round((n / total) * 100)}%`;
}

function tile(label, value) {
  return `<div class="assinantes-tile"><div class="assinantes-tile-label">${escapeHtml(label)}</div><div class="assinantes-tile-value">${escapeHtml(String(value))}</div></div>`;
}

/** Linha de resumo: total, origem, testes e versões. */
export function formSummaryHtml(data) {
  const tiles = [
    tile("Respostas", data.total),
    tile(ORIGEM_LABEL.base, data.por_origem.base),
    tile(ORIGEM_LABEL.onboarding, data.por_origem.onboarding),
    tile(ORIGEM_LABEL.sem_convite, data.por_origem.sem_convite),
    tile("Toparam conversar", data.conversa.toparam),
  ];
  const notas = [];
  if (data.primeira) notas.push(`de ${data.primeira} a ${data.ultima}`);
  if (data.testes_excluidos > 0) notas.push(`${data.testes_excluidos} resposta(s) de teste do editor fora da conta`);
  if (data.versao_anterior > 0) notas.push(`${data.versao_anterior} resposta(s) de versão anterior das perguntas fora das contagens por opção`);
  if (!data.storeLido) notas.push("store do onboarding não lido nesta sessão: a origem sai toda como \"sem convite registrado\"");
  return `<div class="assinantes-summary-grid">${tiles.join("")}</div>` + (notas.length ? `<p class="hint">${escapeHtml(notas.join(" · "))}</p>` : "");
}

/** Uma tabela por pergunta de marcar, com contagem e % sobre quem respondeu a pergunta. */
export function formQuestionsHtml(perguntas) {
  return perguntas
    .map((q) => {
      const tipo = q.tipo === "checkbox" ? "várias opções; % sobre quem respondeu" : "escolha única";
      const rows = q.opcoes
        .map((o) => `<tr><td>${escapeHtml(o.opcao)}</td><td class="mono">${o.n}</td><td class="mono">${pct(o.n, q.responderam)}</td></tr>`)
        .join("");
      const fora = q.fora_da_lista > 0 ? `<tr><td><em>fora da lista de opções</em></td><td class="mono">${q.fora_da_lista}</td><td></td></tr>` : "";
      return (
        `<h3>${escapeHtml(q.pergunta)}</h3>` +
        `<p class="hint">${q.responderam} responderam (${escapeHtml(tipo)})</p>` +
        `<div class="table-scroll"><table class="triage-table"><thead><tr><th>Opção</th><th>Pessoas</th><th>%</th></tr></thead><tbody>${rows}${fora}</tbody></table></div>`
      );
    })
    .join("");
}

/** Respostas abertas, sem e-mail; bloco vazio é omitido. */
export function formOpenAnswersHtml(abertas) {
  const blocks = abertas.filter((b) => b.respostas.length > 0);
  if (blocks.length === 0) return `<p class="hint">Nenhuma resposta aberta ainda.</p>`;
  return blocks
    .map(
      (b) =>
        `<h3>${escapeHtml(b.pergunta)}</h3><ul class="formulario-abertas">` +
        b.respostas.map((r) => `<li><span class="mono">${escapeHtml(r.data)}</span> ${escapeHtml(r.texto)}</li>`).join("") +
        `</ul>`,
    )
    .join("");
}

/** Quem topou a conversa (único bloco com e-mail). */
export function conversaHtml(conversa) {
  if (conversa.pessoas.length === 0) return `<p class="hint">Ninguém marcou a conversa ainda.</p>`;
  const rows = conversa.pessoas
    .map((p) => `<tr><td>${escapeHtml(p.email)}</td><td class="mono">${escapeHtml(p.data)}</td><td>${escapeHtml(ORIGEM_LABEL[p.origem] ?? p.origem)}</td></tr>`)
    .join("");
  return `<div class="table-scroll"><table class="triage-table"><thead><tr><th>E-mail</th><th>Data</th><th>Origem</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Texto de estado quando a leitura não deu certo. */
export function formUnavailableText(data) {
  return `Resultado indisponível: ${data && data.motivo ? data.motivo : "resposta inesperada do servidor"}`;
}
