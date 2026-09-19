/**
 * workers/artigos/src/voto-tema-page.ts (#8371)
 *
 * HTML das 3 telas da votação de tema: placar público, tela de voto (landing
 * do link do e-mail, auto-POST + fallback sem JS) e erro. Mesmo estilo
 * visual mínimo de `gate-page.ts` deste worker — sem framework, CSS inline.
 */
import type { Apuracao, BallotTema, CandidatoTema } from "./voto-tema-core.ts";

/** Reimplementação local — `htmlEscape` vive em `workers/poll/src/lib.ts`,
 *  bundle de outro worker (mesmo racional de não importar cross-worker
 *  documentado em `voto-tema-core.ts`). */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLE = `
  :root { --teal: #00A0A0; --ink: #171411; --paper: #FBFAF6; --rule: #EBE5D0; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: #6b6558; margin: 0 0 28px; }
  .opcao { border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .opcao .barra-bg { background: var(--rule); border-radius: 6px; height: 10px; margin: 8px 0 6px; overflow: hidden; }
  .opcao .barra { background: var(--teal); height: 100%; }
  .opcao .meta { display: flex; justify-content: space-between; font-size: 0.85rem; color: #6b6558; }
  .cta { display: inline-block; background: var(--teal); color: #fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; font-size: 1rem; cursor: pointer; }
  .voto-atual { background: #eafafa; border: 1px solid var(--teal); padding: 10px 14px; border-radius: 8px; margin-top: 20px; font-size: 0.9rem; }
  .erro { background: #fdeceb; border: 1px solid #e08a80; padding: 16px; border-radius: 8px; }
`;

function shell(title: string, body: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${htmlEscape(title)} · diar.ia.br</title>
<style>${BASE_STYLE}</style>
${extraHead}
</head>
<body>
<main>${body}</main>
</body>
</html>`;
}

function barraHtml(opcao: { n: number; titulo: string; votos: number }, total: number, meuVoto: number | null): string {
  const pct = total > 0 ? Math.round((opcao.votos / total) * 100) : 0;
  const destaque = meuVoto === opcao.n ? ' style="border-color:var(--teal)"' : "";
  return `<div class="opcao"${destaque}>
    <strong>${htmlEscape(opcao.titulo)}</strong>
    <div class="barra-bg"><div class="barra" style="width:${pct}%"></div></div>
    <div class="meta"><span>${opcao.votos} voto(s)</span><span>${pct}%</span></div>
  </div>`;
}

export interface PlacarPageOptions {
  ciclo: string;
  ballot: BallotTema;
  apuracao: Apuracao;
  fechado: boolean;
  /** `n` da opção que ESTE visitante votou, se souber (só na página pós-voto
   *  — o placar público genérico nunca sabe quem é o visitante). */
  meuVoto: number | null;
}

export function renderPlacarPage(opts: PlacarPageOptions): string {
  const { ciclo, ballot, apuracao, fechado, meuVoto } = opts;
  const barras = apuracao.opcoes.map((o) => barraHtml(o, apuracao.total, meuVoto)).join("\n");
  const eleitoradoTotal = ballot.eleitores.length;
  const statusLine = fechado
    ? apuracao.empate
      ? "Votação encerrada — empate, decisão editorial pendente."
      : apuracao.vencedor !== null
        ? `Votação encerrada — venceu: ${htmlEscape(ballot.opcoes.find((o) => o.n === apuracao.vencedor)?.titulo ?? "")}.`
        : "Votação encerrada — sem votos registrados."
    : `${apuracao.total} de ${eleitoradoTotal} apoiador(es) já votaram.`;
  const meuVotoBlock =
    meuVoto !== null
      ? `<div class="voto-atual">Seu voto: ${htmlEscape(ballot.opcoes.find((o) => o.n === meuVoto)?.titulo ?? `opção ${meuVoto}`)}. Pode trocar clicando em outro link do e-mail — o último clique vale.</div>`
      : "";
  return shell(
    `Votação — ${ballot.titulo}`,
    `<h1>${htmlEscape(ballot.titulo)}</h1>
     <p class="sub">${htmlEscape(statusLine)}</p>
     ${barras}
     ${meuVotoBlock}`,
  );
}

export interface VotoOpcaoPageOptions {
  ciclo: string;
  ballot: BallotTema;
  opcao: CandidatoTema;
  apuracao: Apuracao;
  /** Path relativo (`/votacao/{ciclo}/{n}?t=...`) usado tanto pelo fetch()
   *  automático quanto pelo `<form>` de fallback sem JS. */
  actionPath: string;
}

/**
 * Landing do link de voto do e-mail — GET com token válido e eleitor
 * autorizado. Renderiza o placar ATUAL (antes deste voto contar) + dispara
 * um POST automático via `fetch()` (progressive enhancement); sem JS, o
 * visitante vê o mesmo placar com um botão "Confirmar voto" que faz o MESMO
 * POST via `<form>` — nenhum voto é contado só por um `GET` de scanner de
 * link, porque scanners nunca executam o JS nem submetem o form.
 */
export function renderVotoOpcaoPage(opts: VotoOpcaoPageOptions): string {
  const { ballot, opcao, apuracao, actionPath } = opts;
  const barras = apuracao.opcoes.map((o) => barraHtml(o, apuracao.total, null)).join("\n");
  const body = `<h1>${htmlEscape(ballot.titulo)}</h1>
    <p class="sub">Confirmando seu voto em <strong>${htmlEscape(opcao.titulo)}</strong>…</p>
    ${barras}
    <noscript>
      <form method="POST" action="${htmlEscape(actionPath)}">
        <button class="cta" type="submit">Confirmar voto em "${htmlEscape(opcao.titulo)}"</button>
      </form>
    </noscript>
    <form id="f" method="POST" action="${htmlEscape(actionPath)}" style="display:none">
      <button class="cta" type="submit">Confirmar voto em "${htmlEscape(opcao.titulo)}"</button>
    </form>`;
  const script = `<script>
  (function () {
    fetch(${JSON.stringify(actionPath)}, { method: "POST" })
      .then(function (r) { return r.text(); })
      .then(function (html) { document.open(); document.write(html); document.close(); })
      .catch(function () { var f = document.getElementById("f"); if (f) f.style.display = "block"; });
  })();
  </script>`;
  return shell(`Confirmando voto — ${ballot.titulo}`, body, script);
}

export function renderErroPage(mensagem: string): string {
  return shell("Votação", `<h1>Não foi possível registrar</h1><div class="erro">${htmlEscape(mensagem)}</div>`);
}
