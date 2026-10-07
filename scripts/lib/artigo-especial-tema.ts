/**
 * artigo-especial-tema.ts (#9099)
 *
 * Etapa A de `/diaria-artigo-especial` (produção): de onde sai o TEMA do
 * próximo artigo. A fonte é a votação dos apoiadores (`/diaria-voto-tema`):
 * o placar fechado `tema:result:{aamm}` no KV, lido via
 * `npx tsx scripts/voto-tema-stats.ts --ciclo AAMM --json` (o JSON entra
 * aqui como `stats`), mais a cédula local
 * `data/artigo-especial/votacao/{aamm}/ballot.json` para a descrição do
 * candidato (o placar só carrega o título).
 *
 * Votação ABERTA ou EMPATADA não tem vencedor — `resolveTemaVencedor` lança
 * em vez de escolher o líder parcial: declarar vencedor é ato do
 * `voto-tema-close.ts` (`--forcar-vencedor N` no empate), nunca desta skill.
 * O editor pode pular a votação passando `--tema` direto (artigo fora do
 * ciclo de voto); aí este módulo nem é chamado.
 */

export interface TemaStatsLike {
  ciclo: string;
  fechado: boolean;
  vencedor: number | null;
  empate: boolean;
  opcoes: ReadonlyArray<{ n: number; titulo: string; votos?: number }>;
}

export interface BallotLike {
  opcoes: ReadonlyArray<{ n: number; titulo: string; descricao?: string }>;
}

export interface TemaVencedor {
  ciclo: string;
  n: number;
  titulo: string;
  descricao: string | null;
}

export class TemaVencedorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemaVencedorError";
  }
}

/** Pura: vencedor da votação, ou lança com a ação que destrava. */
export function resolveTemaVencedor(stats: TemaStatsLike, ballot: BallotLike | null): TemaVencedor {
  if (!stats.fechado) {
    throw new TemaVencedorError(
      `votação ${stats.ciclo} ainda aberta — feche com 'npx tsx scripts/voto-tema-close.ts --ciclo ${stats.ciclo} --push' (ou passe --tema para escrever fora do ciclo).`,
    );
  }
  if (stats.empate) {
    throw new TemaVencedorError(
      `votação ${stats.ciclo} fechou EMPATADA — decisão editorial: 'voto-tema-close.ts --ciclo ${stats.ciclo} --forcar-vencedor N --push'.`,
    );
  }
  if (stats.vencedor === null) throw new TemaVencedorError(`votação ${stats.ciclo} fechou sem nenhum voto — sem vencedor.`);
  const opcao = stats.opcoes.find((o) => o.n === stats.vencedor);
  if (!opcao) throw new TemaVencedorError(`votação ${stats.ciclo}: vencedor ${stats.vencedor} não está entre as opções do placar.`);
  const daCedula = ballot?.opcoes.find((o) => o.n === opcao.n);
  if (daCedula && daCedula.titulo !== opcao.titulo) {
    throw new TemaVencedorError(
      `votação ${stats.ciclo}: a opção ${opcao.n} no placar ("${opcao.titulo}") difere da cédula local ("${daCedula.titulo}") — ballot.json mudou depois da abertura?`,
    );
  }
  return { ciclo: stats.ciclo, n: opcao.n, titulo: opcao.titulo, descricao: daCedula?.descricao?.trim() || null };
}

const STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "na", "no", "nas", "nos", "um", "uma", "para", "por", "com", "que", "como"]);

/**
 * Pura: SUGESTÃO de slug a partir do tema (o editor confirma no gate da
 * Etapa A — o slug vira URL pública e não muda depois). Sem acento, só
 * `[a-z0-9-]`, sem stopwords nas pontas, no máximo `maxWords` palavras.
 */
export function suggestSlug(titulo: string, maxWords = 5): string {
  const words = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.filter((w) => !STOPWORDS.has(w)).slice(0, maxWords);
  return (kept.length ? kept : words.slice(0, maxWords)).join("-");
}
