/**
 * scripts/lib/tsc-baseline.ts (#6217)
 *
 * Miolo PURO da catraca (ratchet) de baseline do typecheck estendido
 * (`tsconfig.test.json`, que cobre `scripts/**` + `test/**` — o
 * `tsconfig.json` raiz, usado por `npm run typecheck`, cobre só
 * `scripts/**`). CLI/I/O em `scripts/typecheck-ratchet.ts`.
 *
 * ─── O problema que isto resolve ────────────────────────────────────────
 *
 * `tsc -p tsconfig.test.json --noEmit` hoje devolve ~1.062 erros (achado
 * #6217): 1.034 dentro de `test/**`, 28 dentro de `workers/**` (puxados
 * pra dentro do programa porque MUITOS arquivos de teste importam direto
 * de `workers/*\/src/**` — `exclude` no tsconfig NÃO impede isso, porque
 * `exclude` só filtra quais arquivos entram como ROOT via `include`;
 * qualquer arquivo alcançado por `import` a partir de um root continua
 * sendo type-checado independente de `exclude`. Por isso este módulo NÃO
 * distingue `test/` de `workers/` — a chave é só arquivo+código, venha de
 * onde vier).
 *
 * Corrigir os 1.062 erros de uma vez não cabe nesta unidade. Sem uma
 * catraca, ligar `tsconfig.test.json` no CI reprovaria o master imediato
 * (build vermelho não é aceitável — CLAUDE.md #633/#636) — e a alternativa
 * de NÃO ligar no CI é exatamente o problema original da issue: todo
 * guard de tipo escrito em `test/**` continua decorativo.
 *
 * ─── Design da chave (granularidade) ────────────────────────────────────
 *
 * Contagem pura de erros é frágil — a própria issue aponta o caso: 1 erro
 * some, outro aparece, total permanece igual, a catraca passaria sem
 * perceber a regressão (troca de problema por problema, não zero
 * problemas novos). A chave aqui é **arquivo + código TS** (`TscErrorKey`,
 * `errorKeyString` -> `"{file}::{TSxxxx}"`) — NUNCA a linha. Duas razões
 * pra excluir linha:
 *
 *   1. Qualquer edição ACIMA de um erro conhecido desloca a linha — toda
 *      PR que tocasse um arquivo com erro baseline geraria ruído constante
 *      (o mesmo erro, reportado como "novo" só por ter mudado de linha),
 *      o oposto de uma catraca que só acusa regressão real.
 *   2. arquivo+código já é específico o bastante pra pegar o caso que
 *      importa: um erro NOVO estatisticamente aparece num arquivo
 *      diferente OU com um código de erro diferente do que já existia lá
 *      — colisão exata (mesmo arquivo, mesmo código, IGNORANDO linha) é
 *      rara o suficiente pra não valer o custo de manutenção da linha.
 *
 * **Mas arquivo+código sozinho ainda tem o mesmo furo da contagem pura,
 * só que por chave**: se 1 arquivo já tem 2 erros `TS2304` na baseline e
 * ganha um 3º, o `Set` de chaves não muda (a chave já existia) — o novo
 * erro passaria batido. Por isso a baseline não é uma LISTA de chaves, é
 * um MAPA chave -> quantas ocorrências são aceitas (`TscBaseline`,
 * `computeErrorCounts`). `evaluateRatchet` compara CONTAGEM por chave:
 * contagem atual > contagem da baseline pra uma chave já conhecida
 * também reprova (`increasedKeys`) — fecha exatamente o furo que a
 * contagem pura (ou um Set de chaves sem contagem) deixaria passar.
 *
 * ─── Zero rede, zero `tsc` real neste módulo ────────────────────────────
 *
 * Este arquivo só faz parsing de texto e comparação de mapas — nunca
 * invoca `tsc` nem toca o filesystem (isso é do CLI). Testável 100%
 * injetando a saída bruta do `tsc` como string.
 */

/** Uma ocorrência de erro do `tsc`, identificada por arquivo + código —
 * NUNCA por linha (ver docstring do módulo, seção "Design da chave"). */
export interface TscErrorKey {
  /** Path do arquivo tal como o `tsc` imprime (relativo ao cwd da
   * invocação — o CLI sempre roda do root do repo, então este path é
   * estável entre execuções/máquinas). */
  file: string;
  /** Código do erro TypeScript, ex: `"TS2304"`. */
  code: string;
}

/** Chave estável `"{file}::{code}"` — usada tanto pro mapa de baseline
 * quanto pro mapa de contagem atual. `::` (não usado em paths nem em
 * códigos TS) evita colisão entre um path com `:` (nunca acontece em
 * POSIX/Windows normalizado, mas defensivo) e o código. */
export function errorKeyString(e: TscErrorKey): string {
  return `${e.file}::${e.code}`;
}

/** Regex de 1 linha de erro do `tsc --noEmit` no formato padrão:
 * `path/to/file.ts(12,34): error TS2304: Cannot find name 'Foo'.`
 * Captura path (grupo 1) e código (grupo 2) — ignora linha/coluna/mensagem
 * de propósito (ver docstring do módulo). `m` (multiline) pra casar cada
 * linha da saída bruta (que pode ter múltiplos erros, um por linha, cada
 * um começando no início da linha). */
const TSC_ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+):/gm;

/**
 * Pura: extrai `{file, code}` de cada linha de erro na saída bruta do
 * `tsc --noEmit`. Linhas que não casam o formato (headers, linhas em
 * branco, "Found N errors.") são ignoradas — nunca lança. Preserva
 * duplicatas (mesma chave pode aparecer várias vezes — é exatamente o que
 * `computeErrorCounts` usa pra contar ocorrências).
 *
 * @pure
 */
export function parseTscErrors(output: string): TscErrorKey[] {
  const out: TscErrorKey[] = [];
  // new RegExp(...) — a regex tem flag `g` com estado (`lastIndex`); uma
  // instância nova por chamada evita o bug clássico de reentrância entre
  // invocações concorrentes/repetidas no mesmo processo.
  const re = new RegExp(TSC_ERROR_LINE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out.push({ file: m[1]!, code: m[2]! });
  }
  return out;
}

/** Baseline persistida — mapa `"{file}::{code}"` -> quantas ocorrências
 * daquela combinação são conhecidas/aceitas. Serializado em
 * `tsc-baseline.json` (root do repo, committed — ver `scripts/typecheck-ratchet.ts`). */
export type TscBaseline = Record<string, number>;

/**
 * Pura: conta ocorrências por chave — insumo tanto pra gerar a baseline
 * (`--update-baseline`) quanto pro estado ATUAL comparado contra ela.
 *
 * @pure
 */
export function computeErrorCounts(errors: readonly TscErrorKey[]): TscBaseline {
  const counts: TscBaseline = {};
  for (const e of errors) {
    const key = errorKeyString(e);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface RatchetIncreasedEntry {
  key: string;
  baselineCount: number;
  currentCount: number;
}

export interface RatchetResolvedEntry {
  key: string;
  baselineCount: number;
}

export interface RatchetResult {
  /** `true` quando não há nenhuma chave nova nem contagem aumentada — o
   * CI só falha quando `ok` é `false`. Baseline diminuir (`resolvedKeys`/
   * `decreasedKeys` não-vazios) NUNCA reprova — é sempre bem-vindo. */
  ok: boolean;
  /** Chaves com ocorrência(s) agora, ausentes da baseline por completo —
   * a classe "erro genuinamente novo". */
  newKeys: string[];
  /** Chaves já conhecidas cuja contagem ATUAL é MAIOR que a da baseline —
   * a classe "mais uma ocorrência do mesmo tipo de erro, no mesmo
   * arquivo" (o furo que uma baseline sem contagem por chave deixaria
   * passar — ver docstring do módulo). */
  increasedKeys: RatchetIncreasedEntry[];
  /** Chaves da baseline com contagem MENOR agora (mas ainda > 0) — sinal
   * informativo de que o baseline PODE ser apertado (nunca obrigatório). */
  decreasedKeys: RatchetIncreasedEntry[];
  /** Chaves da baseline que sumiram por completo (contagem atual 0/ausente)
   * — sinal mais forte ainda de que o baseline pode ser baixado (ver
   * `scripts/typecheck-ratchet.ts --update-baseline`). */
  resolvedKeys: RatchetResolvedEntry[];
}

/**
 * Pura: compara o estado ATUAL (`current`, de `computeErrorCounts` sobre a
 * saída fresca do `tsc`) contra a `baseline` persistida. Regra de
 * aprovação: **nenhuma chave nova, nenhuma contagem que subiu** — chave
 * que sumiu ou contagem que caiu NUNCA reprova (a catraca só trava
 * regressão, nunca exige progresso).
 *
 * @pure
 */
export function evaluateRatchet(current: Readonly<TscBaseline>, baseline: Readonly<TscBaseline>): RatchetResult {
  const newKeys: string[] = [];
  const increasedKeys: RatchetIncreasedEntry[] = [];
  const decreasedKeys: RatchetIncreasedEntry[] = [];
  const resolvedKeys: RatchetResolvedEntry[] = [];

  for (const [key, count] of Object.entries(current)) {
    const baselineCount = baseline[key] ?? 0;
    if (baselineCount === 0) {
      newKeys.push(key);
    } else if (count > baselineCount) {
      increasedKeys.push({ key, baselineCount, currentCount: count });
    } else if (count < baselineCount) {
      decreasedKeys.push({ key, baselineCount, currentCount: count });
    }
  }

  for (const [key, baselineCount] of Object.entries(baseline)) {
    if (!(key in current)) resolvedKeys.push({ key, baselineCount });
  }

  newKeys.sort();
  increasedKeys.sort((a, b) => a.key.localeCompare(b.key));
  decreasedKeys.sort((a, b) => a.key.localeCompare(b.key));
  resolvedKeys.sort((a, b) => a.key.localeCompare(b.key));

  return {
    ok: newKeys.length === 0 && increasedKeys.length === 0,
    newKeys,
    increasedKeys,
    decreasedKeys,
    resolvedKeys,
  };
}

/** Serializa uma baseline em JSON determinístico (chaves ordenadas,
 * 2-space indent, newline final) — pra diff de PR ficar legível e estável
 * (nunca reordena por acidente entre execuções em máquinas diferentes). */
export function serializeBaseline(baseline: Readonly<TscBaseline>): string {
  const sorted: TscBaseline = {};
  for (const key of Object.keys(baseline).sort()) sorted[key] = baseline[key]!;
  return JSON.stringify(sorted, null, 2) + "\n";
}
