/**
 * scripts/lib/diaria/roteiro-pagina.ts (#13120)
 *
 * A página do roteiro do `/diaria-video-roteiro` (`_internal/roteiro-d1.html`)
 * gerada a partir do `roteiro-falas.json`, em vez de escrita à mão: os boxes
 * "Na tela", os cortes parciais e as cópias de cada fala nos três vídeos saem
 * do mesmo JSON e não divergem. Layout e folha de estilo: os da 261116 (o da
 * 261112 com a fala em grade e o box "Na tela" à direita, empilhado no
 * celular).
 *
 * Também mostra, calculado e não digitado: a duração estimada de cada vídeo
 * (#13130), a ordem própria de cada vertical (#13128), os cortes parciais
 * (#13129, riscados no vertical, com etiqueta) e, nas notas para a edição, as
 * fontes por fala, os fatos checados e os pontos do rascunho que ficaram de
 * fora (#13132).
 *
 * Pure: recebe o roteiro já validado e devolve o HTML.
 */

import type { BlockKey } from "./video-montage.ts";
import { cortesDaFala, VIDEO_LABEL, VIDEOS_ROTEIRO, type FalaRoteiro, type RoteiroFalas, type VideoRoteiro } from "./roteiro-gravacao.ts";
import { ALVOS_ROTEIRO_DEFAULT, avisosDuracao, formatarDuracao, resolverPeca, type AlvosRoteiro, type PecaResolvida } from "./roteiro-videos.ts";

const CTA_CARD: Record<VideoRoteiro, string> = {
  horizontal: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Inscreva-se no canal",
  vertical1: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Siga a diar.ia.br",
  vertical2: "Gostou? / Curta o vídeo / Compartilhe com quem se interessa por IA / Siga a diar.ia.br",
};

const CABECALHO: Record<VideoRoteiro, { h2: string; spec: string; tituloLabel: string }> = {
  horizontal: { h2: "Horizontal 1920x1080", spec: "notícia completa", tituloLabel: "Título do vídeo" },
  vertical1: { h2: "Vertical 1 · a notícia · 1080x1920", spec: "", tituloLabel: "Título do vídeo (na tela e nas redes)" },
  vertical2: { h2: "Vertical 2 · o guia · 1080x1920", spec: "Short", tituloLabel: "Título do vídeo (na tela e no Short)" },
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Rótulo do grupo de falas na página, pelo bloco da montagem. */
export function rotuloDoBloco(bloco: BlockKey | undefined, v: VideoRoteiro): string {
  switch (bloco) {
    case "gancho":
      return "Gancho";
    case "abertura":
      return "Abertura";
    case "titulo":
      return "Título";
    case "resumo":
    case "resumo_curto":
      return v === "horizontal" ? "Resumo" : "Resumo curto";
    case "comentario":
      return "Comentário";
    case "cta_yt":
    case "cta_vertical":
    case "cta_ig":
    case "cta_out":
      return "Chamada final";
    case "fecho":
      return "Fecho";
    default:
      return "Fala";
  }
}

const CLASSE_DO_GRUPO: Partial<Record<BlockKey, string>> = { gancho: "hook", abertura: "fixed" };

/** O texto da fala com os cortes deste vídeo riscados (os de reserva marcados à parte). */
function textoComCortes(f: FalaRoteiro, v: VideoRoteiro, aplicadas: PecaResolvida["reservasAplicadas"]): string {
  if (v === "horizontal") return escapeHtml(f.texto);
  const cortes = cortesDaFala(f, v);
  if (!cortes.length) return escapeHtml(f.texto);
  // Posições dos trechos no texto (o validador garante que existem).
  const marcas: Array<{ a: number; b: number; reserva: boolean; aplicado: boolean }> = [];
  for (const c of cortes) {
    const a = f.texto.indexOf(c.trecho);
    if (a < 0 || marcas.some((m) => a < m.b && a + c.trecho.length > m.a)) continue;
    marcas.push({ a, b: a + c.trecho.length, reserva: c.reserva, aplicado: !c.reserva || aplicadas.some((r) => r.id === f.id && r.trecho === c.trecho) });
  }
  marcas.sort((x, y) => x.a - y.a);
  let out = "";
  let pos = 0;
  for (const m of marcas) {
    out += escapeHtml(f.texto.slice(pos, m.a));
    const trecho = escapeHtml(f.texto.slice(m.a, m.b));
    out += m.reserva
      ? `<del class="reserva${m.aplicado ? " aplicado" : ""}" title="${m.aplicado ? "corte de reserva aplicado" : "corte de reserva: só se passar do alvo"}">${trecho}</del>`
      : `<del title="cortado neste vídeo">${trecho}</del>`;
    pos = m.b;
  }
  return out + escapeHtml(f.texto.slice(pos));
}

function etiquetasDaFala(f: FalaRoteiro, v: VideoRoteiro, aplicadas: PecaResolvida["reservasAplicadas"]): string {
  const tags: string[] = [];
  if (f.gravarAParte) tags.push(`<span class="novo">Gravar à parte</span>`);
  else tags.push(`<span class="id">${escapeHtml(f.id)}</span>`);
  if (f.etiqueta) tags.push(`<span class="sug">${escapeHtml(f.etiqueta)}</span>`);
  if (v !== "horizontal") {
    const cortes = cortesDaFala(f, v);
    if (cortes.some((c) => !c.reserva)) tags.push(`<span class="corte">Cortada neste vídeo</span>`);
    const reservas = cortes.filter((c) => c.reserva);
    if (reservas.length) {
      const aplicada = reservas.some((c) => aplicadas.some((r) => r.id === f.id && r.trecho === c.trecho));
      tags.push(`<span class="corte">${aplicada ? "Corte de reserva aplicado" : "Corte de reserva"}</span>`);
    }
  }
  return tags.join("");
}

function linhaDaFala(f: FalaRoteiro, v: VideoRoteiro, aplicadas: PecaResolvida["reservasAplicadas"]): string {
  const tela = f.tela ? `<aside class="tela"><b>Na tela</b>${escapeHtml(f.tela).replace(/\n/g, "<br>")}</aside>` : "<span></span>";
  return `<div class="row"><p class="fala">${etiquetasDaFala(f, v, aplicadas)}${textoComCortes(f, v, aplicadas)}</p>${tela}</div>`;
}

function secaoDoVideo(roteiro: RoteiroFalas, peca: PecaResolvida, alvos: AlvosRoteiro): string {
  const v = peca.video;
  const cab = CABECALHO[v];
  const p = roteiro.porVideo?.[v];
  const spec = [cab.spec, `cerca de ${formatarDuracao(peca.segundos)} (alvo ~${formatarDuracao(peca.alvoS)})`].filter(Boolean).join(" · ");
  const linhas: string[] = [`  <section class="sheet" aria-label="${escapeHtml(VIDEO_LABEL[v])}">`];
  linhas.push(`    <div class="vh"><h2>${cab.h2}</h2><span class="spec">${escapeHtml(spec)}</span></div>`);
  if (v === "horizontal" && p?.titulo) linhas.push(`    <div class="titlebox">${escapeHtml(p.titulo.toLocaleUpperCase("pt-BR"))}</div>`);
  const cover: string[] = [];
  if (p?.titulo) cover.push(`<b>${cab.tituloLabel}:</b> ${escapeHtml(p.titulo)}`);
  if (p?.capa) cover.push(`<b>Texto da capa:</b> ${escapeHtml(p.capa)}`);
  if (cover.length) linhas.push(`    <p class="cover">${cover.join("<br>")}</p>`);
  // Falas consecutivas do mesmo rótulo formam um grupo.
  const grupos: Array<{ rotulo: string; bloco?: BlockKey; falas: FalaRoteiro[] }> = [];
  for (const fv of peca.falas) {
    const rotulo = rotuloDoBloco(fv.fala.bloco, v);
    const ult = grupos[grupos.length - 1];
    if (ult && ult.rotulo === rotulo) ult.falas.push(fv.fala);
    else grupos.push({ rotulo, bloco: fv.fala.bloco, falas: [fv.fala] });
  }
  for (const g of grupos) {
    const classe = (g.bloco && CLASSE_DO_GRUPO[g.bloco]) ?? "falas";
    linhas.push(`    <div class="label">${escapeHtml(g.rotulo)}</div><div class="${classe}">${g.falas.map((f) => linhaDaFala(f, v, peca.reservasAplicadas)).join("")}</div>`);
  }
  linhas.push(`    <div class="close"><b>CTA (card, cerca de ${formatarDuracao(alvos.ctaCardS)}):</b> ${escapeHtml(CTA_CARD[v])}</div>`);
  linhas.push("  </section>");
  return linhas.join("\n");
}

function idsDaPeca(peca: PecaResolvida): string {
  return peca.falas.map((f) => (f.fala.gravarAParte ? (f.fala.bloco === "gancho" ? "o gancho gravado à parte" : "a chamada final") : f.fala.id)).join(", ");
}

/** As notas para a edição: ordem própria, cortes, fontes, fatos checados, pontos de fora e notas livres. */
export function notasDaEdicao(roteiro: RoteiroFalas, pecas: readonly PecaResolvida[]): string[] {
  const notas: string[] = [];
  const horizontal = pecas.find((p) => p.video === "horizontal");
  for (const p of pecas) {
    if (!p.ordemDeclarada || !horizontal) continue;
    const ordemH = roteiro.falas.filter((f) => f.videos.includes(p.video)).map((f) => f.id);
    const ordemV = p.falas.map((f) => f.fala.id);
    if (ordemH.join() !== ordemV.join()) notas.push(`<b>Ordem no ${VIDEO_LABEL[p.video]}:</b> ${escapeHtml(ordemV.join(", "))}. No horizontal a ordem é ${escapeHtml(ordemH.join(", "))}.`);
  }
  for (const p of pecas) {
    if (p.video === "horizontal") continue;
    const cortes = roteiro.falas.flatMap((f) => cortesDaFala(f, p.video as "vertical1" | "vertical2").map((c) => ({ id: f.id, ...c })));
    if (!cortes.length) continue;
    const desc = cortes.map((c) => {
      const aplicada = p.reservasAplicadas.some((r) => r.id === c.id && r.trecho === c.trecho);
      const tipo = c.reserva ? (aplicada ? "reserva, aplicada: a estimativa passava do alvo" : "reserva: só se passar do alvo") : "sempre";
      return `${escapeHtml(c.id)}, "${escapeHtml(c.trecho)}" (${tipo})`;
    });
    notas.push(`<b>Cortes no ${VIDEO_LABEL[p.video]}:</b> ${desc.join("; ")}. O horizontal fica com a fala inteira.`);
  }
  const fontes = roteiro.falas.filter((f) => f.fontes?.length);
  if (fontes.length) {
    notas.push(
      `<b>Fontes, para o fact-check da fala:</b> ${fontes
        .map((f) => `${escapeHtml(f.id)}: ${f.fontes!.map((fo) => `<a href="${escapeHtml(fo.url)}">${escapeHtml(fo.sustenta)}</a>`).join("; ")}`)
        .join(" · ")}.`,
    );
  }
  if (roteiro.fatosChecados?.length) {
    const sit: Record<string, string> = { confirmado: "confirmado", "fonte-terceira": "só em fonte terceira", contraditorio: "contraditório", "sem-fonte": "sem fonte" };
    notas.push(
      `<b>Fatos checados fora da fonte do D1:</b> ${roteiro.fatosChecados
        .map((fc) => `${escapeHtml(fc.fato)} (${sit[fc.situacao]}${fc.fonte ? `, ${escapeHtml(fc.fonte)}` : ""}${fc.correcao ? `; corrigido para: ${escapeHtml(fc.correcao)}` : ""})`)
        .join("; ")}.`,
    );
  }
  if (roteiro.excluidos?.length) {
    notas.push(`<b>Pontos do rascunho que ficaram de fora:</b> ${roteiro.excluidos.map((e) => `${escapeHtml(e.ponto)}${e.parcial ? " (entrou em parte)" : ""}: ${escapeHtml(e.motivo)}`).join("; ")}.`);
  }
  for (const n of roteiro.notas ?? []) notas.push(escapeHtml(n));
  return notas;
}

const CSS = `:root {
  --bg: #f6f3ee; --paper: #fffdf9; --fg: #1d2a30; --muted: #5c6a70; --rule: #d9d2c5; --ink: #0f4c5c;
  --sug-bg: #e3f0f2; --sug-fg: #0b4350; --hook-bg: #fbeed2; --warn: #8a4b00; --new-bg: #e6f3e1; --new-fg: #245018;
  --cut: #9a3412;
  --display: "Caveat", "Segoe Print", "Bradley Hand", cursive;
  --body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121a1d; --paper: #182226; --fg: #e8ecee; --muted: #98a6ac; --rule: #2c3a40; --ink: #7fd0e0;
    --sug-bg: #1c3a42; --sug-fg: #bfe6ee; --hook-bg: #3a3017; --warn: #f0b562; --new-bg: #1f3520; --new-fg: #b5e3a8;
    --cut: #fdba74; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #121a1d; --paper: #182226; --fg: #e8ecee; --muted: #98a6ac; --rule: #2c3a40; --ink: #7fd0e0;
  --sug-bg: #1c3a42; --sug-fg: #bfe6ee; --hook-bg: #3a3017; --warn: #f0b562; --new-bg: #1f3520; --new-fg: #b5e3a8;
  --cut: #fdba74; color-scheme: dark;
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
.fixed { font-style: italic; margin: 0; }
.sug, .novo, .corte { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; margin-right: 6px; vertical-align: 1px; }
.sug { background: var(--sug-bg); color: var(--sug-fg); }
.novo { background: var(--new-bg); color: var(--new-fg); }
.corte { border: 1px solid var(--cut); color: var(--cut); }
del { color: var(--cut); text-decoration-thickness: 2px; }
del.reserva { text-decoration-style: dashed; }
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
.review .aviso { color: var(--warn); }
.vh { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; justify-content: space-between; }
.vh h2 { margin: 0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink); }
.vh .spec { font-size: 13px; color: var(--muted); }
.cover { margin: 0; font-size: 15px; color: var(--muted); line-height: 1.7; }
.cover b { color: var(--fg); font-weight: 600; }
.id { display: inline-block; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); border: 1px solid var(--rule); border-radius: 4px; padding: 0 5px; margin-right: 7px; vertical-align: 1px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 14px; align-items: start; }
.row + .row { margin-top: 10px; }
.row p.fala { margin: 0; text-wrap: pretty; }
.tela { font-size: 13.5px; line-height: 1.45; background: var(--sug-bg); color: var(--sug-fg); border-left: 3px solid var(--ink); border-radius: 4px; padding: 7px 10px; }
.tela b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px; }
.hook .row p.fala { font-weight: 600; }
.fixed .row p.fala { font-style: italic; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; gap: 6px; } }
@media (max-width: 520px) { .sheet { padding: 16px 14px; } body { font-size: 16px; } }`;

const SCRIPT = `<script>
(function () {
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
})();
</script>`;

export interface RenderRoteiroOpts {
  alvos?: AlvosRoteiro;
  /** Rótulo da versão, na linha de meta ("v5"). */
  versao?: string;
  /** Linha `<!-- artifact: URL -->` a manter no topo (a da página anterior). */
  artifactLine?: string;
}

/** Pure (#13120): a página inteira do roteiro a partir do JSON. */
export function renderRoteiroPagina(roteiro: RoteiroFalas, opts: RenderRoteiroOpts = {}): string {
  const alvos = opts.alvos ?? ALVOS_ROTEIRO_DEFAULT;
  const pecas = VIDEOS_ROTEIRO.map((v) => resolverPeca(roteiro, v, alvos)).filter((p) => p.falas.length > 0);
  const edicao = roteiro.edicao ?? "";
  const verticais = pecas.filter((p) => p.video !== "horizontal").length;
  const gravarAParte = roteiro.falas.filter((f) => f.gravarAParte);

  const review: string[] = [];
  for (const p of pecas) {
    const base = `<b>${p.video === "horizontal" ? "Horizontal" : p.video === "vertical1" ? "Vertical 1, a notícia" : "Vertical 2, o guia"}:</b> cerca de ${formatarDuracao(p.segundos)} (alvo ~${formatarDuracao(p.alvoS)})`;
    review.push(p.video === "horizontal" ? `${base}.` : `${base}. Falas: ${escapeHtml(idsDaPeca(p))}.${p.video === "vertical2" ? " Sai uma semana depois do vertical 1." : ""}`);
  }
  if (gravarAParte.length) review.push(`<b>Gravar à parte:</b> ${gravarAParte.map((f) => (f.bloco === "gancho" ? `o gancho do ${VIDEO_LABEL[f.videos[0]]}` : `a chamada final do ${VIDEO_LABEL[f.videos[0]]}`)).join(" e ")}.`);
  for (const a of avisosDuracao(pecas, alvos)) review.push(`<span class="aviso">${escapeHtml(a.replace(/ \(#13130\)$/, ""))}</span>`);

  const notas = notasDaEdicao(roteiro, pecas);
  const meta = [`Edição ${escapeHtml(edicao)}`, `1 horizontal${verticais ? ` + ${verticais} vertica${verticais > 1 ? "is" : "l"}` : ""}`, ...(opts.versao ? [escapeHtml(opts.versao)] : [])].join(" · ");

  const out: string[] = [];
  if (opts.artifactLine) out.push(opts.artifactLine);
  out.push(`<title>Roteiro D1 ${escapeHtml(edicao)}</title>`);
  out.push(`<meta name="claude:viewport-fit-sides" content="cover">`);
  out.push(`<!-- Gerada por scripts/render-roteiro-video.ts a partir de _internal/roteiro-falas.json (#13120): editar o JSON e gerar de novo, não o HTML. -->`);
  out.push(`<style>\n${CSS}\n</style>`);
  out.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Inter:wght@400;600&display=swap">`);
  out.push("", `<main class="wrap">`);
  out.push(`  <section class="review" aria-label="Gravação">`);
  out.push(`    <h2>Gravação</h2>`);
  out.push(`    <p>Grave uma vez, na ordem do horizontal, com uma pausa curta entre as falas. Os verticais são cortes do mesmo bruto: a etiqueta <span class="id">H1</span> diz de qual fala vem. O texto de tela fica no box ao lado da fala; trecho riscado num vertical sai só dele.</p>`);
  out.push(`    <ul>\n${review.map((l) => `      <li>${l}</li>`).join("\n")}\n    </ul>`);
  out.push(`  </section>`, "");
  out.push(`  <div class="meta" id="meta">`, `    <span>${meta}</span>`, `    <button type="button" id="copiar">Copiar roteiro</button>`, `  </div>`, "");
  out.push(`  <div id="roteiro" style="display:flex;flex-direction:column;gap:26px">`);
  for (const p of pecas) out.push(secaoDoVideo(roteiro, p, alvos));
  out.push(`  </div>`);
  if (notas.length) {
    out.push("", `  <section class="notes" aria-label="Notas para a edição">`, `    <h2>Notas para a edição</h2>`, `    <ul>`);
    for (const n of notas) out.push(`      <li>${n}</li>`);
    out.push(`    </ul>`, `  </section>`);
  }
  out.push(`</main>`, "", SCRIPT, "");
  return out.join("\n");
}
