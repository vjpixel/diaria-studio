/**
 * workers/artigos/src/voto-tema-core.ts (#8371)
 *
 * Lógica PURA da votação do tema do Artigo Especial pelos apoiadores
 * (Mantenedor/Patrono, R$25+). Zero I/O — o worker (`voto-tema.ts`) e os
 * scripts do ciclo (`scripts/voto-tema-*.ts`) chamam estas funções contra o
 * KV, mas nada aqui toca `env`/`fetch`/filesystem. Mesmo padrão de
 * `workers/poll/src/vote-dedup.ts`/`lib.ts` — a parte que precisa de teste
 * determinístico fica separada da parte que fala com KV.
 *
 * ## Por que reimplementa (não importa) o formato do token de voto
 *
 * O token opaco (`?t=...`) é o MESMO token de 24 hex chars que o "É IA?" já
 * usa (`computePollToken`, `scripts/lib/shared/poll-token.ts` /
 * `workers/poll/src/poll-token.ts`) — reusar a tabela reversa
 * `polltoken:{token} -> email` do namespace KV `POLL` é o ponto central do
 * desenho (ver corpo da #8371). Mas `workers/poll/src/poll-token.ts` é o
 * bundle de OUTRO worker — importar um arquivo de `workers/poll/src/**` de
 * dentro de `workers/artigos/src/**` acoplaria os dois bundles por um
 * arquivo que só existe pra evitar acoplar bundles (a própria docstring dele
 * explica por que `scripts/lib/shared/poll-token.ts` não é importado
 * diretamente). A forma do token (24 hex chars minúsculos) e a key KV
 * (`polltoken:{token}`) são um contrato ESTÁVEL e pequeno o bastante pra
 * duplicar aqui sem risco de deriva — se um dia divergir, é porque o
 * contrato do "É IA?" mudou, e nesse caso os DOIS lados (poll e artigos)
 * precisam de atenção manual de qualquer forma.
 */

/** Escape mínimo de HTML — usado tanto pela página do worker (`voto-tema-page.ts`
 *  reimplementa localmente, sem importar daqui, mesmo racional de não
 *  acoplar bundles) quanto pelo e-mail montado em `publish-voto-tema-kit.ts`
 *  (que RODA em Node, sem restrição de bundle — importa daqui livremente). */
export function htmlEscapeVotoTema(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── ciclo (AAMM) ────────────────────────────────────────────────────────

/** Ciclo de votação — mês de publicação do artigo, formato `AAMM` (4
 *  dígitos). Formato deliberadamente diferente de `AAMMDD` (diária, 6
 *  dígitos) e `YYMM-MM` (mensal, com hífen) — a dupla desses dois formatos
 *  já produziu bug de produção no worker de poll (ver corpo da #8371). */
export type CicloVotacao = string & { readonly __cicloVotacao: unique symbol };

const CICLO_RE = /^\d{4}$/;

/** `null` se `raw` não for exatamente 4 dígitos — rejeita explicitamente
 *  `AAMMDD` (6 dígitos) e `YYMM-MM` (contém hífen), não só "aceita o que
 *  bate a regex". */
export function parseCicloVotacao(raw: string): CicloVotacao | null {
  if (typeof raw !== "string" || !CICLO_RE.test(raw)) return null;
  return raw as CicloVotacao;
}

// ── cédula ──────────────────────────────────────────────────────────────

export interface CandidatoTema {
  n: number;
  titulo: string;
  descricao: string;
  proponente?: string;
}

export interface BallotTema {
  titulo: string;
  opcoes: CandidatoTema[];
  /** sha256 hex (`eleitorHash`) de cada e-mail do eleitorado, no momento da
   *  abertura da votação — não os e-mails crus (ver `autorizarEleitor`). */
  eleitores: string[];
  aberta_em: string;
  fecha_em?: string;
}

export type CedulaValidation = { ok: true } | { ok: false; reason: string };

/** Valida a cédula ANTES de gravar no KV — nº mínimo de opções, sem `n`
 *  duplicado, título/descrição obrigatórios por opção. Não valida
 *  `eleitores`/datas (resolvidos pelo caller, que sabe a audiência real). */
export function validarCedula(ballot: Pick<BallotTema, "titulo" | "opcoes">): CedulaValidation {
  if (!ballot.titulo || !ballot.titulo.trim()) {
    return { ok: false, reason: "título da votação ausente." };
  }
  if (!Array.isArray(ballot.opcoes) || ballot.opcoes.length < 2) {
    return {
      ok: false,
      reason: `cédula precisa de pelo menos 2 opções (recebeu ${Array.isArray(ballot.opcoes) ? ballot.opcoes.length : 0}).`,
    };
  }
  const seen = new Set<number>();
  for (const o of ballot.opcoes) {
    if (!Number.isInteger(o.n) || o.n <= 0) {
      return { ok: false, reason: `opção com "n" inválido: ${JSON.stringify(o.n)}.` };
    }
    if (seen.has(o.n)) {
      return { ok: false, reason: `opção n=${o.n} duplicada — cada opção precisa de um "n" único.` };
    }
    seen.add(o.n);
    if (!o.titulo || !o.titulo.trim()) {
      return { ok: false, reason: `opção n=${o.n} sem título.` };
    }
    if (!o.descricao || !o.descricao.trim()) {
      return { ok: false, reason: `opção n=${o.n} sem descrição.` };
    }
  }
  return { ok: true };
}

// ── chaves KV (prefixo `tema:`, namespace `POLL` reusado) ────────────────

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function ballotKey(ciclo: string): string {
  return `tema:ballot:${ciclo}`;
}

export function voteKeyPrefix(ciclo: string): string {
  return `tema:vote:${ciclo}:`;
}

export function voteKey(ciclo: string, email: string): string {
  return `${voteKeyPrefix(ciclo)}${normalizeEmail(email)}`;
}

export function resultKey(ciclo: string): string {
  return `tema:result:${ciclo}`;
}

// ── token de voto (mirror mínimo do formato de `poll-token.ts`) ──────────

const TEMA_TOKEN_HEX_LEN = 24;
const TEMA_TOKEN_RE = new RegExp(`^[0-9a-f]{${TEMA_TOKEN_HEX_LEN}}$`);

/** `true` se `token` tem a forma esperada (24 hex chars minúsculos) — não
 *  verifica se ele EXISTE no KV (isso é responsabilidade do lookup). */
export function isValidTemaVoteToken(token: string): boolean {
  return typeof token === "string" && TEMA_TOKEN_RE.test(token);
}

/** Chave KV da tabela reversa compartilhada com a base inteira da diária —
 *  mesma key que `scripts/lib/shared/poll-token.ts::pollTokenKvKey`
 *  produziria pro mesmo token; reimplementada aqui só pra não importar o
 *  bundle do worker `poll` (ver docstring do módulo). */
export function pollTokenKvKeyMirror(token: string): string {
  return `polltoken:${token}`;
}

/** #2262 (mesmo guard de `workers/poll/src/lib.ts::isUnsubstitutedMergeTag`):
 *  detecta merge tag Liquid/Handlebars não-substituída (`{{...}}`) chegando
 *  como se fosse o token — sinal de test-send/preview/atributo ausente, não
 *  um token real. */
export function isUnsubstitutedMergeTagToken(raw: string): boolean {
  return typeof raw === "string" && (raw.includes("{{") || raw.includes("}}"));
}

// ── hash do eleitorado ────────────────────────────────────────────────────

/** SHA-256 hex de `input`. Portável (Web Crypto — disponível tanto no
 *  runtime do Worker quanto no Node ≥ 20 via `globalThis.crypto`), então
 *  `voto-tema-open.ts` e o worker calculam o MESMO hash sem duplicar a
 *  implementação do algoritmo — só esta função. */
export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash do e-mail (normalizado) que entra em `BallotTema.eleitores` — nunca
 *  o e-mail cru, pra não vazar a lista de apoiadores num objeto que a rota
 *  pública de placar poderia, por erro futuro, expor. */
export async function eleitorHash(email: string): Promise<string> {
  return sha256Hex(normalizeEmail(email));
}

/**
 * `true` se `email` (resolvido do token) pertence ao eleitorado gravado na
 * cédula — o guard central da #8371: sem ele, qualquer token válido de
 * QUALQUER assinante da diária (a tabela `polltoken:` é compartilhada com a
 * base inteira) votaria na recompensa exclusiva dos apoiadores.
 */
export async function autorizarEleitor(email: string, eleitores: readonly string[]): Promise<boolean> {
  const hash = await eleitorHash(email);
  return eleitores.includes(hash);
}

// ── apuração ──────────────────────────────────────────────────────────────

export interface VotoRegistrado {
  opcao: number;
  ts: string;
}

/** Estado em memória de "quem votou em quê" — chave é o e-mail normalizado.
 *  Representa o resultado de um `list` do prefixo `tema:vote:{ciclo}:` no
 *  KV real; existe como tipo pra testar "troca de voto" sem KV. */
export type VotosPorEmail = ReadonlyMap<string, VotoRegistrado>;

/**
 * Pure: aplica um voto — sobrescreve o registro anterior da MESMA pessoa
 * (último clique vence, decisão do editor). Não muta `votes`; devolve um
 * novo Map. É exatamente o que um 2º `PUT` na mesma chave KV
 * (`tema:vote:{ciclo}:{email}`) faz em produção — esta função existe pra
 * testar essa semântica sem KV real.
 */
export function upsertVoto(votes: VotosPorEmail, email: string, voto: VotoRegistrado): VotosPorEmail {
  const next = new Map(votes);
  next.set(normalizeEmail(email), voto);
  return next;
}

export interface ApuracaoOpcao {
  n: number;
  titulo: string;
  votos: number;
}

export interface Apuracao {
  opcoes: ApuracaoOpcao[];
  total: number;
  /** `null` quando `empate` é `true` OU quando não há voto nenhum ainda —
   *  os dois casos em que declarar um vencedor seria inventar um resultado. */
  vencedor: number | null;
  /** `true` só quando 2+ opções empatam no maior número de votos (>0). Zero
   *  votos em todas as opções NÃO é empate (não há disputa nenhuma ainda). */
  empate: boolean;
}

/**
 * Pure: apura a contagem a partir da cédula (que define as opções válidas —
 * a fonte da verdade de QUAIS `n` existem, não os votos) + a lista de votos
 * registrados. Determinístico: a ORDEM de `votos` nunca muda o resultado —
 * é sempre a contagem final por opção, nunca um replay sequencial. Isso é o
 * que torna a apuração seguro de recalcular a qualquer momento via `list` do
 * prefixo KV (nunca diverge por reordenação de paginação).
 */
export function apurar(ballot: Pick<BallotTema, "opcoes">, votos: readonly VotoRegistrado[]): Apuracao {
  const contagem = new Map<number, number>();
  for (const o of ballot.opcoes) contagem.set(o.n, 0);
  for (const v of votos) {
    if (contagem.has(v.opcao)) contagem.set(v.opcao, (contagem.get(v.opcao) ?? 0) + 1);
  }
  const opcoes: ApuracaoOpcao[] = ballot.opcoes.map((o) => ({
    n: o.n,
    titulo: o.titulo,
    votos: contagem.get(o.n) ?? 0,
  }));
  const total = votos.length;
  const max = opcoes.reduce((m, o) => Math.max(m, o.votos), 0);
  const top = max > 0 ? opcoes.filter((o) => o.votos === max).map((o) => o.n) : [];
  const empate = top.length > 1;
  const vencedor = !empate && top.length === 1 ? top[0] : null;
  return { opcoes, total, vencedor, empate };
}
