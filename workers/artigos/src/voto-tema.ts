/**
 * workers/artigos/src/voto-tema.ts (#8371)
 *
 * Handlers HTTP da votação do tema do Artigo Especial. Lógica de
 * decisão/apuração é 100% de `voto-tema-core.ts` (puro, testado sem KV) —
 * este arquivo só faz a leitura/escrita no KV `POLL` e monta a `Response`.
 *
 * Rotas (montadas em `index.ts`):
 *   GET  /votacao/{ciclo}            → placar público (sem link de voto)
 *   GET  /votacao/{ciclo}/{n}?t=tok  → resolve token, autoriza, renderiza
 *                                      placar + dispara auto-POST do voto
 *   POST /votacao/{ciclo}/{n}?t=tok  → grava o voto (única rota que escreve)
 *
 * Voto é registrado SÓ no POST, nunca no GET — scanners de link de e-mail
 * (Gmail/Outlook) fazem GET automaticamente; se o GET gravasse, um scanner
 * visitando as N opções do e-mail castaria N votos sem a pessoa ter clicado.
 */
import {
  apurar,
  autorizarEleitor,
  ballotKey,
  isUnsubstitutedMergeTagToken,
  isValidTemaVoteToken,
  pollTokenKvKeyMirror,
  resultKey,
  sobreporVotoProprio,
  voteKey,
  voteKeyPrefix,
  type Apuracao,
  type BallotTema,
  type VotoListado,
  type VotoRegistrado,
} from "./voto-tema-core.ts";
import { renderErroPage, renderPlacarPage, renderVotoOpcaoPage } from "./voto-tema-page.ts";

export interface VotoTemaEnv {
  POLL: KVNamespace;
}

/** Resultado gravado por `voto-tema-close.ts` — presença desta chave marca
 *  a votação como FECHADA (nenhum POST novo é aceito). */
interface ResultadoFinal {
  vencedor: number | null;
  empate: boolean;
  contagem: Apuracao["opcoes"];
  total: number;
  fechado_em: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html;charset=utf-8" } });
}

async function readBallot(env: VotoTemaEnv, ciclo: string): Promise<BallotTema | null> {
  const raw = await env.POLL.get(ballotKey(ciclo));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BallotTema;
  } catch {
    return null;
  }
}

async function readResultado(env: VotoTemaEnv, ciclo: string): Promise<ResultadoFinal | null> {
  const raw = await env.POLL.get(resultKey(ciclo));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResultadoFinal;
  } catch {
    return null;
  }
}

/** Pagina o `list()` do prefixo `tema:vote:{ciclo}:` inteiro — com o
 *  eleitorado de ~9 pessoas nunca passa de 1 página, mas paginar
 *  corretamente custa nada e evita um teto silencioso se a votação crescer. */
async function listVotos(env: VotoTemaEnv, ciclo: string): Promise<VotoRegistrado[]> {
  return (await listVotosComChave(env, ciclo)).map((l) => l.voto);
}

async function listVotosComChave(env: VotoTemaEnv, ciclo: string): Promise<VotoListado[]> {
  const out: VotoListado[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.POLL.list({ prefix: voteKeyPrefix(ciclo), cursor });
    for (const k of page.keys) {
      const raw = await env.POLL.get(k.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Partial<VotoRegistrado>;
        if (typeof parsed.opcao === "number" && typeof parsed.ts === "string") {
          out.push({ chave: k.name, voto: { opcao: parsed.opcao, ts: parsed.ts } });
        }
      } catch {
        // entrada corrompida — ignora, não derruba a apuração inteira
      }
    }
    if (page.list_complete || !("cursor" in page) || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

async function resolveTokenEmail(env: VotoTemaEnv, token: string): Promise<string | null> {
  if (!isValidTemaVoteToken(token)) return null;
  return env.POLL.get(pollTokenKvKeyMirror(token));
}

function tokenGuardError(token: string | null): string | null {
  if (!token) return "Link inválido — parâmetro de identidade ausente.";
  if (isUnsubstitutedMergeTagToken(token)) {
    return "Este link ainda tem uma tag de e-mail não resolvida — abra o e-mail original (não um preview/test-send) e clique no botão de voto.";
  }
  if (!isValidTemaVoteToken(token)) return "Link de voto malformado.";
  return null;
}

export async function handleVotacaoPlacar(_request: Request, env: VotoTemaEnv, ciclo: string): Promise<Response> {
  const ballot = await readBallot(env, ciclo);
  if (!ballot) return html(renderErroPage("Votação não encontrada — confira o link."), 404);

  const resultado = await readResultado(env, ciclo);
  if (resultado) {
    const apuracao: Apuracao = {
      opcoes: resultado.contagem,
      total: resultado.total,
      vencedor: resultado.vencedor,
      empate: resultado.empate,
    };
    return html(renderPlacarPage({ ciclo, ballot, apuracao, fechado: true, meuVoto: null }));
  }

  const votos = await listVotos(env, ciclo);
  const apuracao = apurar(ballot, votos);
  return html(renderPlacarPage({ ciclo, ballot, apuracao, fechado: false, meuVoto: null }));
}

export async function handleVotacaoOpcaoGet(
  request: Request,
  env: VotoTemaEnv,
  ciclo: string,
  n: number,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const tokenError = tokenGuardError(token);
  if (tokenError) return html(renderErroPage(tokenError), 400);

  const ballot = await readBallot(env, ciclo);
  if (!ballot) return html(renderErroPage("Votação não encontrada — confira o link."), 404);

  if (await readResultado(env, ciclo)) {
    return html(renderErroPage("Esta votação já foi encerrada — seu clique não altera o resultado final."), 409);
  }

  const opcao = ballot.opcoes.find((o) => o.n === n);
  if (!opcao) return html(renderErroPage("Esta opção não existe nesta cédula."), 404);

  const email = await resolveTokenEmail(env, token as string);
  if (!email) return html(renderErroPage("Link de voto inválido — talvez já tenha expirado."), 403);

  const authorized = await autorizarEleitor(email, ballot.eleitores);
  if (!authorized) {
    return html(
      renderErroPage(
        "Este link não pertence ao eleitorado desta votação (Mantenedor/Patrono, R$25+/mês) — recusando registrar.",
      ),
      403,
    );
  }

  const votos = await listVotos(env, ciclo);
  const apuracao = apurar(ballot, votos);
  const actionPath = `/votacao/${ciclo}/${n}?t=${encodeURIComponent(token as string)}`;
  return html(renderVotoOpcaoPage({ ciclo, ballot, opcao, apuracao, actionPath }));
}

export async function handleVotoPost(request: Request, env: VotoTemaEnv, ciclo: string, n: number): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const tokenError = tokenGuardError(token);
  // Erros em HTML, não JSON: o auto-POST da página de voto faz document.write
  // do corpo e o fallback sem JS é um <form> — JSON cru chegaria à pessoa (#8825).
  if (tokenError) return html(renderErroPage(tokenError), 400);

  const ballot = await readBallot(env, ciclo);
  if (!ballot) return html(renderErroPage("Votação não encontrada — confira o link."), 404);

  if (await readResultado(env, ciclo)) {
    return html(renderErroPage("Esta votação já foi encerrada — seu clique não altera o resultado final."), 409);
  }

  const opcao = ballot.opcoes.find((o) => o.n === n);
  if (!opcao) return html(renderErroPage("Esta opção não existe nesta cédula."), 404);

  const email = await resolveTokenEmail(env, token as string);
  if (!email) return html(renderErroPage("Link de voto inválido — talvez já tenha expirado."), 403);

  const authorized = await autorizarEleitor(email, ballot.eleitores);
  if (!authorized) {
    return html(
      renderErroPage(
        "Este link não pertence ao eleitorado desta votação (Mantenedor/Patrono, R$25+/mês) — recusando registrar.",
      ),
      403,
    );
  }

  // Último clique vence — um PUT na mesma chave sobrescreve o voto anterior
  // desta pessoa, sem precisar ler o valor antigo antes (mesma semântica de
  // `upsertVoto` em voto-tema-core.ts, que é o que os testes exercitam).
  const voto: VotoRegistrado = { opcao: n, ts: new Date().toISOString() };
  const chave = voteKey(ciclo, email);
  await env.POLL.put(chave, JSON.stringify(voto));

  const votos = sobreporVotoProprio(await listVotosComChave(env, ciclo), chave, voto);
  const apuracao = apurar(ballot, votos);
  return html(renderPlacarPage({ ciclo, ballot, apuracao, fechado: false, meuVoto: n }));
}
