/**
 * scripts/lib/diaria/roteiro-pagina.ts (#13120)
 *
 * A página do roteiro do vídeo (`_internal/roteiro-d1.html`, a que o editor lê
 * para gravar) gerada a partir do `roteiro-falas.json`, em vez de escrita à
 * mão. Até o #13120 a skill mantinha as duas coisas em paralelo, e o texto de
 * uma fala aparecia de novo em cada vídeo que a usa: um ajuste esquecido numa
 * cópia fazia a página divergir do JSON que a montagem lê.
 *
 * Layout de referência: o da 261116 (`data/editions/2611/261116/_internal/roteiro-d1.html`),
 * ajustado à mão naquela edição a pedido do editor:
 *   - caixa "Gravação" no topo: como gravar, a duração e as falas de cada vídeo;
 *   - uma seção por vídeo, com título, texto da capa, blocos e falas numeradas;
 *   - box "Na tela" ao lado de cada fala que tem `tela`, empilhado no celular;
 *   - os verticais na ordem de `porVideo.{vertical}.ordem` (#13128), com o
 *     corte parcial riscado (#13129);
 *   - "Notas para a edição" no fim: cortes, ordem, fontes (#13132) e as notas livres.
 *
 * As durações são calculadas (#13130), nunca digitadas. Nenhuma seta (→/←)
 * sai na página (#9721): o texto de tela já é validado sem ela, e o render
 * confere o HTML inteiro.
 */

import { BLOCK_KEYS, type BlockKey } from "./video-montage.ts";
import { corteDaFala, VIDEO_LABEL, VIDEOS_ROTEIRO, type FalaRoteiro, type RoteiroFalas, type VideoRoteiro } from "./roteiro-gravacao.ts";
import { blocoNaVertical, duracaoPorVideo, falasDoVideo, fmtDuracao, roteiroPecas, ROTEIRO_DURACAO_DEFAULT, type RoteiroDuracaoConfig } from "./roteiro-videos.ts";

/** Formato e papel de cada vídeo, no cabeçalho da seção. */
const CABECALHO: Record<VideoRoteiro, string> = {
  horizontal: "Horizontal 1920x1080",
  vertical1: "Vertical 1 · a notícia · 1080x1920",
  vertical2: "Vertical 2 · o guia · 1080x1920",
};

/** O card de CTA padrão (o "Gostou?", #12735); `porVideo.{v}.cta` sobrepõe. */
export const CTA_CARD_PADRAO: Record<VideoRoteiro, string> = {
  horizontal: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Inscreva-se no canal",
  vertical1: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Siga a diar.ia.br",
  vertical2: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Siga a diar.ia.br",
};

const ROTULO_BLOCO: Record<BlockKey, string> = {
  gancho: "Gancho",
  titulo: "Título",
  abertura: "Abertura",
  resumo: "Resumo",
  resumo_curto: "Resumo curto",
  comentario: "Comentário",
  cta_yt: "Chamada final",
  cta_vertical: "Chamada final",
  cta_ig: "Chamada final",
  cta_out: "Chamada final",
  fecho: "Fecho",
};

export const SETA_GLIFO = /[→←]/;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Texto com quebra de linha (`\n`) vira `<br>`. */
function escBr(s: string): string {
  return s
    .split("\n")
    .map((l) => esc(l.trim()))
    .join("<br>");
}

/** A fala com o corte do vídeo marcado: riscado (corte) ou sublinhado (reserva), #13129. */
function textoComCorte(f: FalaRoteiro, v: VideoRoteiro): string {
  const c = corteDaFala(f, v);
  const i = c ? f.texto.indexOf(c.trecho.trim()) : -1;
  if (!c || i < 0) return esc(f.texto);
  const t = c.trecho.trim();
  const marca = c.reserva
    ? `<span class="reserva" title="Corte de reserva: só sai se o vídeo passar do alvo">${esc(t)}</span><span class="tag-corte">reserva</span>`
    : `<del title="Cortado neste vídeo">${esc(t)}</del><span class="tag-corte">cortado aqui</span>`;
  return `${esc(f.texto.slice(0, i))}${marca}${esc(f.texto.slice(i + t.length))}`;
}

function linhaFala(f: FalaRoteiro, v: VideoRoteiro): string {
  const tag = f.gravarAParte ? `<span class="novo">Gravar à parte</span>` : "";
  const tela = f.tela ? `<aside class="tela"><b>Na tela</b>${escBr(f.tela)}</aside>` : "<span></span>";
  return `<div class="row"><p class="fala"><span class="id">${esc(f.id)}</span>${tag}${textoComCorte(f, v)}</p>${tela}</div>`;
}

/** O bloco em que a fala aparece naquele vídeo (o resumo vira resumo curto nos verticais). */
function blocoNoVideo(f: FalaRoteiro, v: VideoRoteiro): BlockKey | null {
  if (!f.bloco) return null;
  return v === "horizontal" ? f.bloco : blocoNaVertical(f.bloco);
}

function classeDoGrupo(b: BlockKey | null): string {
  if (b === "gancho") return "hook";
  if (b === "abertura") return "fixed";
  return "falas";
}

/** As falas do vídeo agrupadas por bloco consecutivo, na ordem do vídeo. */
function grupos(roteiro: RoteiroFalas, v: VideoRoteiro): Array<{ bloco: BlockKey | null; falas: FalaRoteiro[] }> {
  const out: Array<{ bloco: BlockKey | null; falas: FalaRoteiro[] }> = [];
  for (const f of falasDoVideo(roteiro, v).falas) {
    const b = blocoNoVideo(f, v);
    // Chamada falada no fim do vertical entra no comentário (como na 261116), com a etiqueta.
    const rotulo = b && b.startsWith("cta") && out.at(-1)?.bloco === "comentario" ? "comentario" : b;
    const ultimo = out.at(-1);
    if (ultimo && ultimo.bloco === rotulo) ultimo.falas.push(f);
    else out.push({ bloco: rotulo as BlockKey | null, falas: [f] });
  }
  return out;
}

function secaoVideo(roteiro: RoteiroFalas, v: VideoRoteiro, seg: number | undefined, ctaCardS: number): string {
  const peca = roteiroPecas(roteiro)[v] ?? {};
  const spec = seg !== undefined ? `cerca de ${fmtDuracao(seg)}` : "";
  const papel = v === "horizontal" ? "notícia completa · " : "";
  const partes: string[] = [];
  partes.push(`<div class="vh"><h2>${esc(CABECALHO[v])}</h2><span class="spec">${esc(papel + spec)}</span></div>`);
  if (v === "horizontal" && peca.titulo) partes.push(`<div class="titlebox">${esc(peca.titulo.toUpperCase())}</div>`);
  const rotuloTitulo = v === "horizontal" ? "Título do vídeo" : v === "vertical1" ? "Título do vídeo (na tela e nas redes)" : "Título do vídeo (na tela e no Short)";
  const cover: string[] = [];
  if (peca.titulo) cover.push(`<b>${rotuloTitulo}:</b> ${esc(peca.titulo)}`);
  if (peca.capa) cover.push(`<b>Texto da capa:</b> ${esc(peca.capa)}`);
  if (cover.length) partes.push(`<p class="cover">${cover.join("<br>")}</p>`);
  for (const g of grupos(roteiro, v)) {
    const rotulo = g.bloco ? ROTULO_BLOCO[g.bloco] : "Sem bloco";
    partes.push(`<div class="label">${esc(rotulo)}</div><div class="${classeDoGrupo(g.bloco)}">${g.falas.map((f) => linhaFala(f, v)).join("")}</div>`);
  }
  const cta = roteiro.porVideo?.[v]?.cta?.trim() || CTA_CARD_PADRAO[v];
  partes.push(`<div class="close"><b>CTA (card, cerca de ${ctaCardS} s):</b> ${esc(cta)}</div>`);
  return `  <section class="sheet" aria-label="${esc(VIDEO_LABEL[v])}">\n    ${partes.join("\n    ")}\n  </section>`;
}

/** Os itens da caixa "Gravação" (duração e falas de cada vídeo, o que gravar à parte, extras). */
export function itensGravacao(roteiro: RoteiroFalas, cfg: RoteiroDuracaoConfig = ROTEIRO_DURACAO_DEFAULT): string[] {
  const dur = new Map(duracaoPorVideo(roteiro, cfg).map((d) => [d.video, d] as const));
  const itens: string[] = [];
  for (const v of VIDEOS_ROTEIRO) {
    const d = dur.get(v);
    if (!d) continue;
    const nome = v === "horizontal" ? "Horizontal" : v === "vertical1" ? "Vertical 1, a notícia" : "Vertical 2, o guia";
    const alvo = d.foraDoAlvo ? (v === "horizontal" ? " (fora da faixa de ~3 min)" : ` (acima do alvo de ${fmtDuracao(d.alvoS)})`) : "";
    if (v === "horizontal") {
      itens.push(`<b>${nome}:</b> cerca de ${fmtDuracao(d.segundos)}${alvo}.`);
      continue;
    }
    const ids = falasDoVideo(roteiro, v).falas.map((f) => (f.gravarAParte ? `${f.id} (à parte)` : f.id));
    itens.push(`<b>${nome}:</b> cerca de ${fmtDuracao(d.segundos)}${alvo}. Falas: ${esc(ids.join(", "))}.`);
  }
  const aParte = roteiro.falas.filter((f) => f.gravarAParte).map((f) => f.id);
  if (aParte.length) itens.push(`<b>Gravar à parte:</b> ${esc(aParte.join(", "))}.`);
  for (const g of roteiro.gravacao ?? []) itens.push(esc(g));
  return itens;
}

/** As "Notas para a edição": cortes, ordem e fontes saem dos campos; o resto, das notas livres. */
export function itensNotas(roteiro: RoteiroFalas): string[] {
  const itens: string[] = [];
  const cortes: string[] = [];
  const reservas: string[] = [];
  for (const f of roteiro.falas) {
    for (const v of VIDEOS_ROTEIRO) {
      const c = corteDaFala(f, v);
      if (!c) continue;
      const txt = `no ${VIDEO_LABEL[v]}, tirar da ${f.id} "${c.trecho.trim()}"`;
      (c.reserva ? reservas : cortes).push(txt);
    }
  }
  if (cortes.length) itens.push(`<b>Cortes por vídeo:</b> ${esc(cortes.join("; "))}. O horizontal fica com a fala inteira.`);
  if (reservas.length) itens.push(`<b>Cortes de reserva:</b> só se o vídeo passar do alvo: ${esc(reservas.join("; "))}.`);
  const horizontal = falasDoVideo(roteiro, "horizontal").falas.map((f) => f.id);
  for (const v of ["vertical1", "vertical2"] as const) {
    const { falas, declarada } = falasDoVideo(roteiro, v);
    if (!declarada) continue;
    const ids = falas.map((f) => f.id);
    const naOrdemDoHorizontal = ids.filter((id) => horizontal.includes(id));
    const herdada = horizontal.filter((id) => naOrdemDoHorizontal.includes(id));
    if (naOrdemDoHorizontal.join() !== herdada.join()) itens.push(`<b>Ordem no ${VIDEO_LABEL[v]}:</b> ${esc(ids.join(", "))}, diferente da do horizontal.`);
  }
  const fontes = roteiro.falas.flatMap((f) => (f.fontes ?? []).map((fo) => ({ id: f.id, ...fo })));
  if (fontes.length) {
    const lista = fontes.map((fo) => `${esc(fo.id)}: <a href="${esc(fo.url)}">${esc(fo.sustenta)}</a>`).join("; ");
    itens.push(`<b>Fontes fora do D1, para o fact-check da fala:</b> ${lista}.`);
  }
  for (const n of roteiro.notas ?? []) itens.push(esc(n));
  return itens;
}

const CSS = `:root {
  --bg: #f6f3ee; --paper: #fffdf9; --fg: #1d2a30; --muted: #5c6a70; --rule: #d9d2c5; --ink: #0f4c5c;
  --sug-bg: #e3f0f2; --sug-fg: #0b4350; --hook-bg: #fbeed2; --warn: #8a4b00; --new-bg: #e6f3e1; --new-fg: #245018;
  --display: "Caveat", "Segoe Print", "Bradley Hand", cursive;
  --body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121a1d; --paper: #182226; --fg: #e8ecee; --muted: #98a6ac; --rule: #2c3a40; --ink: #7fd0e0;
    --sug-bg: #1c3a42; --sug-fg: #bfe6ee; --hook-bg: #3a3017; --warn: #f0b562; --new-bg: #1f3520; --new-fg: #b5e3a8; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #121a1d; --paper: #182226; --fg: #e8ecee; --muted: #98a6ac; --rule: #2c3a40; --ink: #7fd0e0;
  --sug-bg: #1c3a42; --sug-fg: #bfe6ee; --hook-bg: #3a3017; --warn: #f0b562; --new-bg: #1f3520; --new-fg: #b5e3a8; color-scheme: dark;
}
body { background: var(--bg); color: var(--fg); font-family: var(--body); font-size: 17px; line-height: 1.6; padding-block: 28px 56px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
.meta { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; justify-content: space-between; }
.meta button { font: inherit; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink); background: transparent; border: 1px solid var(--ink); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.meta button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
.titlebox { border: 2.5px solid var(--ink); border-radius: 10px 4px 12px 5px; padding: 14px 20px; font-family: var(--display); font-size: clamp(30px, 6vw, 42px); line-height: 1.15; color: var(--ink); text-wrap: balance; background: var(--paper); }
.sheet { background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.hook { background: var(--hook-bg); border-radius: 6px; padding: 12px 16px; font-weight: 600; text-wrap: pretty; }
.label { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.fixed .row p.fala { font-style: italic; }
.close { border-top: 2px solid var(--ink); padding-top: 12px; font-style: italic; color: var(--muted); }
.notes { font-size: 15px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.notes h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin: 0; color: var(--fg); }
.notes ul { margin: 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 6px; }
.notes b { color: var(--warn); font-weight: 600; }
.notes a { color: var(--ink); overflow-wrap: anywhere; }
.review { background: var(--paper); border: 1px solid var(--ink); border-radius: 6px; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; font-size: 15.5px; }
.review h2 { margin: 0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink); }
.review p { margin: 0; text-wrap: pretty; }
.review ul { margin: 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 7px; }
.novo { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; background: var(--new-bg); color: var(--new-fg); padding: 2px 7px; border-radius: 4px; margin-right: 6px; vertical-align: 1px; }
.vh { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; justify-content: space-between; }
.vh h2 { margin: 0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink); }
.vh .spec { font-size: 13px; color: var(--muted); }
.cover { margin: 0; font-size: 15px; color: var(--muted); line-height: 1.7; }
.cover b { color: var(--fg); font-weight: 600; }
.id { display: inline-block; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); border: 1px solid var(--rule); border-radius: 4px; padding: 0 5px; margin-right: 7px; vertical-align: 1px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 14px; align-items: start; }
.row + .row { margin-top: 10px; }
.row p.fala { margin: 0; text-wrap: pretty; }
.tela { font-size: 13.5px; line-height: 1.45; background: var(--sug-bg); color: var(--sug-fg); border-left: 3px solid var(--ink); border-radius: 4px; padding: 7px 10px; font-weight: 400; }
.tela b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px; }
del { color: var(--muted); }
.reserva { text-decoration: underline dashed var(--warn); text-underline-offset: 3px; }
.tag-corte { display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--warn); border: 1px solid var(--warn); border-radius: 4px; padding: 0 5px; margin-left: 6px; vertical-align: 1px; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; gap: 6px; } }
@media (max-width: 520px) { .sheet { padding: 16px 14px; } body { font-size: 16px; } }`;

const SCRIPT = `(function () {
  var btn = document.getElementById('copiar');
  btn.addEventListener('click', function () {
    var el = document.getElementById('roteiro');
    var txt = el.innerText;
    var done = function () { btn.textContent = 'Copiado'; setTimeout(function () { btn.textContent = 'Copiar roteiro'; }, 1600); };
    try { navigator.clipboard.writeText(txt).then(done, function () { sel(el); }); } catch (e) { sel(el); }
  });
  function sel(el) {
    try { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = 'Selecionado: copie com Ctrl+C'; } catch (e) {}
  }
})();`;

export interface RenderOpts {
  cfg?: RoteiroDuracaoConfig;
  /** Link do artefato publicado, gravado na 1ª linha (`<!-- artifact: URL -->`, Passo 5 da skill). */
  artifactUrl?: string;
}

/**
 * Pure (#13120): a página do roteiro a partir do JSON (já validado). Lança se
 * algum texto trouxer seta (→/←, #9721), que o validador só confere no `tela`.
 */
export function renderRoteiroPagina(roteiro: RoteiroFalas, opts: RenderOpts = {}): string {
  const cfg = opts.cfg ?? ROTEIRO_DURACAO_DEFAULT;
  const dur = new Map(duracaoPorVideo(roteiro, cfg).map((d) => [d.video, d.segundos] as const));
  const videos = VIDEOS_ROTEIRO.filter((v) => roteiro.falas.some((f) => f.videos.includes(v)));
  const nVert = videos.filter((v) => v !== "horizontal").length;
  const composicao = [videos.includes("horizontal") ? "1 horizontal" : "", nVert ? `${nVert} vertica${nVert > 1 ? "is" : "l"}` : ""].filter(Boolean).join(" + ");
  const notas = itensNotas(roteiro);
  const html = [
    ...(opts.artifactUrl ? [`<!-- artifact: ${opts.artifactUrl} -->`] : []),
    `<title>Roteiro D1 ${esc(roteiro.edicao ?? "")}</title>`,
    `<meta name="claude:viewport-fit-sides" content="cover">`,
    `<!-- Gerado de _internal/roteiro-falas.json por scripts/render-roteiro-video.ts (#13120): editar o JSON e gerar de novo, nunca o HTML à mão. -->`,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Inter:wght@400;600&display=swap">`,
    `<style>\n${CSS}\n</style>`,
    ``,
    `<main class="wrap">`,
    `  <section class="review" aria-label="Gravação">`,
    `    <h2>Gravação</h2>`,
    `    <p>Grave uma vez, na ordem do horizontal, com uma pausa curta entre as falas. Os verticais são cortes do mesmo bruto: a etiqueta <span class="id">H1</span> diz de qual fala vem. O texto de tela fica no box ao lado da fala.</p>`,
    `    <ul>\n${itensGravacao(roteiro, cfg).map((i) => `      <li>${i}</li>`).join("\n")}\n    </ul>`,
    `  </section>`,
    ``,
    `  <div class="meta" id="meta">`,
    `    <span>Edição ${esc(roteiro.edicao ?? "")} · ${esc(composicao)}</span>`,
    `    <button type="button" id="copiar">Copiar roteiro</button>`,
    `  </div>`,
    ``,
    `  <div id="roteiro" style="display:flex;flex-direction:column;gap:26px">`,
    ...videos.map((v) => secaoVideo(roteiro, v, dur.get(v), cfg.ctaCardS)),
    `  </div>`,
    ...(notas.length
      ? [``, `  <section class="notes" aria-label="Notas para a edição">`, `    <h2>Notas para a edição</h2>`, `    <ul>\n${notas.map((n) => `      <li>${n}</li>`).join("\n")}\n    </ul>`, `  </section>`]
      : []),
    `</main>`,
    ``,
    `<script>\n${SCRIPT}\n</script>`,
    ``,
  ].join("\n");
  const seta = html.match(SETA_GLIFO);
  if (seta) throw new Error(`a página sairia com seta (${seta[0]}), proibida no que chega ao leitor (#9721): troque no roteiro-falas.json`);
  return html;
}

/** O link do artefato na 1ª linha de uma página já gravada (`<!-- artifact: URL -->`), ou null. */
export function artifactUrlDe(htmlExistente: string): string | null {
  const m = htmlExistente.match(/^\s*<!--\s*artifact:\s*(\S+)\s*-->/);
  return m ? m[1] : null;
}

/** Os blocos da montagem, exportados para o teste conferir a cobertura dos rótulos. */
export const BLOCOS_COM_ROTULO = BLOCK_KEYS.filter((b) => ROTULO_BLOCO[b]);
