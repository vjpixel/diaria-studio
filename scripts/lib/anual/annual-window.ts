/**
 * annual-window.ts (#7569)
 *
 * Resolução da janela da edição ANUAL — puro, sem I/O.
 *
 * A `/diaria-anual` roda 2x por ano, com janelas diferentes (decisão do
 * editor, 07/09/2026):
 *
 *   - `aniversario` (roda em agosto) cobre **ago–jul**: o ano que fecha no
 *     aniversário da diar.ia.br (1ª edição: 27/08/2025).
 *   - `janeiro` (roda em janeiro) cobre **jan–dez**: o ano civil que acabou.
 *
 * As duas se sobrepõem em ago–dez, e isso é intencional — cada edição é uma
 * retrospectiva completa e independente, não um incremento da anterior.
 *
 * A 1ª rodada é uma EXCEÇÃO declarada: o aniversário de 27/08/2026 passou e
 * a edição sai em setembro/2026 cobrindo 13 meses (`--desde 2508 --ate
 * 2608`), o primeiro ano inteiro do projeto. Por isso `desde`/`ate` são
 * overrides de primeira classe, não um escape hatch — a janela do `--tipo` é
 * só o default.
 *
 * **Nunca assuma 12 meses.** `months.length` é 13 na 1ª rodada e pode ser
 * qualquer coisa quando o editor passa a janela à mão; todo texto que
 * mencione o período (draft, banner, gate) tem que derivar daqui.
 */

/** Rodada anual — define a janela default e se há bloco de aniversário. */
export type AnnualTipo = "aniversario" | "janeiro";

export interface AnnualWindow {
  tipo: AnnualTipo;
  /** Primeiro mês da janela, YYMM. */
  desde: string;
  /** Último mês da janela, YYMM (inclusive). */
  ate: string;
  /** Todos os meses YYMM de `desde` a `ate`, em ordem cronológica. */
  months: string[];
  /** Ano da edição (o do `ate`), 4 dígitos — usado no nome do diretório. */
  year: number;
  /** Rótulo humano da janela, ex: "agosto/2025 a agosto/2026". */
  label: string;
  /** `true` quando a janela não tem os 12 meses do default do tipo. */
  isException: boolean;
  /** Avisos a imprimir em banner (tipo assumido, janela fora do padrão). */
  warnings: string[];
}

const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

const YYMM_RE = /^\d{4}$/;

/** YYMM → índice absoluto de mês (yy*12 + mm-1), pra aritmética de janela. */
export function yymmToIndex(yymm: string): number {
  assertYymm(yymm);
  const yy = Number(yymm.slice(0, 2));
  const mm = Number(yymm.slice(2, 4));
  return yy * 12 + (mm - 1);
}

/** Inverso de `yymmToIndex`. */
export function indexToYymm(index: number): string {
  const yy = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return `${String(yy).padStart(2, "0")}${String(mm).padStart(2, "0")}`;
}

function assertYymm(yymm: string): void {
  if (!YYMM_RE.test(yymm)) {
    throw new Error(`mês inválido: ${JSON.stringify(yymm)} — esperado YYMM (ex: 2608)`);
  }
  const mm = Number(yymm.slice(2, 4));
  if (mm < 1 || mm > 12) {
    throw new Error(`mês inválido: ${yymm} — o par MM precisa estar entre 01 e 12`);
  }
}

/** Lista inclusiva de meses YYMM entre dois extremos. */
export function monthsBetween(desde: string, ate: string): string[] {
  const from = yymmToIndex(desde);
  const to = yymmToIndex(ate);
  if (to < from) {
    throw new Error(`janela invertida: --desde ${desde} vem depois de --ate ${ate}`);
  }
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(indexToYymm(i));
  return out;
}

/** "2508" → "agosto/2025". Assume século 20xx (o projeto nasceu em 2025). */
export function yymmLabel(yymm: string): string {
  assertYymm(yymm);
  const year = 2000 + Number(yymm.slice(0, 2));
  const month = Number(yymm.slice(2, 4));
  return `${MONTH_NAMES[month - 1]}/${year}`;
}

/**
 * Janela default de um tipo, ancorada no ano de referência:
 *   - `aniversario`, ano N → ago/N-1 a jul/N
 *   - `janeiro`, ano N     → jan/N-1 a dez/N-1
 *
 * `refYear` é o ano em que a edição É ENVIADA (4 dígitos).
 */
export function defaultWindowFor(tipo: AnnualTipo, refYear: number): { desde: string; ate: string } {
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  if (tipo === "aniversario") {
    return { desde: `${yy(refYear - 1)}08`, ate: `${yy(refYear)}07` };
  }
  return { desde: `${yy(refYear - 1)}01`, ate: `${yy(refYear - 1)}12` };
}

/**
 * Tipo default a partir do mês corrente: agosto → `aniversario`, janeiro →
 * `janeiro`. Qualquer outro mês não tem resposta óbvia — em vez de parar pra
 * perguntar (#5321), assume o tipo da rodada mais próxima **para trás** (a
 * que deveria ter saído) e devolve o aviso pro banner.
 */
export function defaultTipoFor(month: number): { tipo: AnnualTipo; assumed: boolean } {
  if (month === 8) return { tipo: "aniversario", assumed: false };
  if (month === 1) return { tipo: "janeiro", assumed: false };
  // fev–jul: a rodada mais recente foi a de janeiro. set–dez: foi a de agosto.
  return { tipo: month >= 2 && month <= 7 ? "janeiro" : "aniversario", assumed: true };
}

export interface ResolveAnnualWindowArgs {
  tipo?: string;
  desde?: string;
  ate?: string;
  /** Data de referência (default: agora). Injetável pra teste. */
  today?: Date;
}

/**
 * Resolve a janela final combinando `--tipo`, `--desde` e `--ate`.
 *
 * Precedência: `--desde`/`--ate` explícitos sempre vencem o default do tipo,
 * inclusive um só dos dois (o outro vem do default). O `tipo` continua
 * mandando no bloco de aniversário mesmo com janela sobrescrita — é ele que
 * diz "esta é a edição de aniversário", não o recorte de datas.
 */
export function resolveAnnualWindow(args: ResolveAnnualWindowArgs = {}): AnnualWindow {
  const warnings: string[] = [];
  const today = args.today ?? new Date();

  let tipo: AnnualTipo;
  if (args.tipo) {
    if (args.tipo !== "aniversario" && args.tipo !== "janeiro") {
      throw new Error(`--tipo inválido: ${JSON.stringify(args.tipo)} — use "aniversario" ou "janeiro"`);
    }
    tipo = args.tipo;
  } else {
    const d = defaultTipoFor(today.getMonth() + 1);
    tipo = d.tipo;
    if (d.assumed) {
      warnings.push(
        `Tipo não informado e o mês corrente não é de rodada anual — assumindo --tipo ${d.tipo} ` +
          `(a rodada mais recente). Passe --tipo para a outra.`,
      );
    }
  }

  // Ano de referência: o do `--ate` quando ele existe (a janela manda), senão
  // o ano corrente. Sem isso, `--ate 2608` em setembro/2026 e em janeiro/2027
  // resolveriam diretórios diferentes pra mesma edição.
  const refYear = args.ate ? 2000 + Number(args.ate.slice(0, 2)) + (tipo === "janeiro" ? 1 : 0) : today.getFullYear();
  const dflt = defaultWindowFor(tipo, refYear);

  const desde = args.desde ?? dflt.desde;
  const ate = args.ate ?? dflt.ate;
  const months = monthsBetween(desde, ate);

  const isException = desde !== dflt.desde || ate !== dflt.ate;
  if (isException) {
    warnings.push(
      `Janela fora do default de --tipo ${tipo} (${yymmLabel(dflt.desde)} a ${yymmLabel(dflt.ate)}): ` +
        `usando ${yymmLabel(desde)} a ${yymmLabel(ate)} (${months.length} meses).`,
    );
  }

  // O ano do diretório/edição é o do último mês da janela — é o ano que a
  // retrospectiva fecha, independente de quando ela é enviada.
  const year = 2000 + Number(ate.slice(0, 2));

  return {
    tipo,
    desde,
    ate,
    months,
    year,
    label: `${yymmLabel(desde)} a ${yymmLabel(ate)}`,
    isException,
    warnings,
  };
}
