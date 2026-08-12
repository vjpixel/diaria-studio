/**
 * clarice-abc-state.ts (#5055)
 *
 * Estado DURÁVEL do teste A/B/C de assunto da Clarice News. Existe porque a
 * decisão "o teste acabou" não tinha onde morar.
 *
 * ===========================================================================
 * O PROBLEMA QUE ISTO RESOLVE
 * ===========================================================================
 * `recommendAbcAction` (`clarice-wave-plan.ts`) é PURA e recalcula a
 * recomendação do zero a cada invocação, a partir dos cliques do ciclo. Isso
 * é correto enquanto o teste está EM CURSO — e errado depois que o editor o
 * encerra, por dois motivos distintos:
 *
 *   1. **Não havia como registrar o encerramento.** O único gancho era o flag
 *      `--locked-subject` de `clarice-plan-wave.ts`, que é por invocação e que
 *      o orquestrador da task diária deliberadamente NÃO repassava. A task de
 *      19:00 BRT não tinha como saber de nada.
 *   2. **Mesmo um `travar` calculado não gruda.** No dia seguinte o cálculo
 *      roda de novo; se o p-valor voltar a passar de 0,05 (amostra nova, dia
 *      excluído por drift de naming, `attributionUnknown`), a recomendação
 *      volta pra `continuar` e o teste REABRE sozinho — sem ninguém decidir
 *      nada. Foi exatamente o que aconteceu com a onda de 12/08/2026, que saiu
 *      planejada com 3 assuntos depois de o editor ter encerrado o teste.
 *
 * O custo de um teste que não termina não é só cosmético: a ressalva de "poder
 * baixo" (#4559) entra em `caveats`, e `clarice-envio-run.ts` ZERA o passo
 * adaptativo de volume quando há ressalva. Isso fecha um laço que se
 * auto-alimenta — base pequena → poder baixo → passo zerado → base nunca
 * cresce → poder nunca melhora. Na rodada de 11/08/2026 o motor calculou
 * +14,7% de escalada legítima (freio `ok`, risco em 27% do limiar) e jogou
 * fora, mantendo o volume travado em 3.159/dia. Encerrar o teste destrava isso
 * SEM nenhum código novo de volume: o ramo `encerrado` devolve `caveats: []`,
 * então não há o que zerar o passo.
 *
 * ===========================================================================
 * REABRIR É SEMPRE ATO EXPLÍCITO DO EDITOR
 * ===========================================================================
 * Requisito central da #5055, e a razão de este módulo existir em vez de um
 * `--locked-subject` melhorado: **nenhum caminho automático sai de
 * `encerrado`.** Recálculo de dados não reabre; p-valor novo não reabre;
 * amostra nova não reabre. Só `reopenClariceAbcTest` (CLI `--reopen
 * --confirm`) reabre, e ela exige as DUAS flags justamente pra que um
 * `--reopen` digitado por engano não passe.
 *
 * ===========================================================================
 * AS TRÊS LEITURAS POSSÍVEIS
 * ===========================================================================
 *   | estado do arquivo                          | status      | avisa |
 *   |--------------------------------------------|-------------|-------|
 *   | ausente                                    | `aberto`    | não   |
 *   | presente e válido                          | o valor     | não   |
 *   | presente e ilegível/inválido/sem assunto   | `aberto`    | SIM   |
 *
 * O fail-soft aponta pra `aberto` — ao contrário de `clarice-envio-enabled.ts`,
 * cujo fail-soft aponta pro lado que NÃO envia. Aqui a direção segura é outra:
 * `aberto` significa "volta a recalcular", que é exatamente o comportamento
 * pré-#5055 (chato — 3 células e volume travado — mas conhecido e seguro). O
 * lado perigoso seria confiar num `subject` truncado/corrompido e mandá-lo
 * como assunto pra milhares de pessoas. Por isso `encerrado` SEM `subject`
 * não-vazio é tratado como inválido, não como "encerrado sem assunto": um
 * estado escrito pela metade nunca trava assunto nenhum.
 *
 * Como cair pra `aberto` reabre o teste sem o editor ter pedido, essa queda
 * NÃO pode ser silenciosa — `readClariceAbcState` chama `opts.onInvalid`
 * (default `console.warn`) sempre que existe arquivo que não deu pra
 * interpretar, e devolve o motivo em `invalidReason` pro caller registrar no
 * relatório da rodada (mesma disciplina do #4800: nunca confundir "não deu pra
 * ler" com "está aberto de verdade").
 *
 * ===========================================================================
 * ESTE MÓDULO NÃO DECIDE NADA SOZINHO
 * ===========================================================================
 * Ele só PERSISTE a decisão do editor. Quem traduz isso em ação continua sendo
 * `recommendAbcAction`, que permanece PURA (sem disco): os call sites leem o
 * estado aqui e passam `lockedSubject` adiante. A pureza daquele módulo é o
 * que o mantém testável sem tocar em `data/`, e não vale a pena furá-la.
 *
 * Estado persistido em `data/clarice-abc-state.json` — arquivo NOVO e
 * dedicado, nunca reaproveita nenhum estado existente sob `data/` (mesma
 * disciplina do #4078/#4941/#5027).
 *
 * Uso CLI:
 *   npx tsx scripts/lib/clarice-abc-state.ts
 *   # → "aberto" ou 'encerrado — "<assunto>"' (exit 0 sempre)
 *   npx tsx scripts/lib/clarice-abc-state.ts --close --subject "..." [--winner A|B|C] [--rationale "..."]
 *   npx tsx scripts/lib/clarice-abc-state.ts --reopen --confirm [--rationale "..."]
 *   npx tsx scripts/lib/clarice-abc-state.ts --json
 *
 * @see scripts/lib/clarice-wave-plan.ts (`recommendAbcAction` — consome via `lockedSubject`)
 * @see scripts/clarice-envio-run.ts (orquestrador da task diária)
 * @see scripts/lib/clarice-envio-enabled.ts (#5027 — molde do read fail-soft com aviso)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./cli-args.ts";

export type AbcTestStatus = "aberto" | "encerrado";
export type AbcCell = "A" | "B" | "C";

export interface ClariceAbcState {
  /** `aberto` = default de arquivo ausente e de qualquer leitura que falhe.
   * `encerrado` = o editor encerrou o teste; `subject` é o assunto travado. */
  status: AbcTestStatus;
  /** Assunto travado. Não-vazio SEMPRE que `status === "encerrado"` — um
   * `encerrado` sem assunto é rejeitado na leitura (ver docstring). */
  subject: string | null;
  /** Célula vencedora, quando o editor quis registrá-la. OPCIONAL de
   * propósito: o encerramento de 11/08/2026 foi decisão EDITORIAL sobre um
   * teste sem significância estatística (p 0,2715) — forçar a declaração de
   * uma "vencedora" ali seria registrar como veredito do dado algo que o dado
   * não sustenta. O assunto é o que importa; a célula é anotação. */
  winner: AbcCell | null;
  /** ISO da decisão. `null` quando o estado está no default. */
  decidedAt: string | null;
  /** Quem decidiu — sempre `"editor"` na prática; explícito pra que o arquivo
   * se explique sozinho pra quem o abrir daqui a 6 meses. */
  decidedBy: string | null;
  /** Por que foi encerrado/reaberto. Texto livre do editor. */
  rationale: string | null;
}

/** Resultado da leitura: o estado + por que ele caiu pro default, se caiu. */
export interface ClariceAbcStateRead extends ClariceAbcState {
  /** `null` quando a leitura foi limpa (arquivo ausente ou válido). Texto
   * quando existe arquivo que não deu pra interpretar — o caller registra
   * isso no relatório em vez de deixar a reabertura passar em silêncio. */
  invalidReason: string | null;
}

/** Arquivo AUSENTE (ou ilegível): teste ABERTO — comportamento pré-#5055. */
const ABSENT_DEFAULT: ClariceAbcState = {
  status: "aberto",
  subject: null,
  winner: null,
  decidedAt: null,
  decidedBy: null,
  rationale: null,
};

export function clariceAbcStatePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-abc-state.json");
}

function asCell(v: unknown): AbcCell | null {
  return v === "A" || v === "B" || v === "C" ? v : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export interface ReadAbcStateOptions {
  /** Chamado quando existe arquivo que não deu pra interpretar. Default
   * `console.warn` — nunca silencioso. */
  onInvalid?: (message: string) => void;
}

/**
 * Lê o estado. NUNCA lança: qualquer problema vira `aberto` + `invalidReason`
 * + chamada a `onInvalid`. Ver a tabela das três leituras na docstring do
 * módulo.
 */
export function readClariceAbcState(
  rootDir: string,
  opts: ReadAbcStateOptions = {},
): ClariceAbcStateRead {
  const onInvalid = opts.onInvalid ?? ((m: string) => console.warn(m));
  const p = clariceAbcStatePath(rootDir);
  if (!existsSync(p)) return { ...ABSENT_DEFAULT, invalidReason: null };

  const fallback = (why: string): ClariceAbcStateRead => {
    const msg =
      `⚠️  ${p} existe mas não deu pra interpretar (${why}) — assumindo teste A/B/C ABERTO ` +
      `(volta a recalcular, 3 células). Corrija o arquivo ou rode ` +
      `\`npx tsx scripts/lib/clarice-abc-state.ts --close --subject "..."\` de novo.`;
    onInvalid(msg);
    return { ...ABSENT_DEFAULT, invalidReason: `${why} (${p})` };
  };

  let raw: Partial<ClariceAbcState>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ClariceAbcState>;
  } catch (err) {
    return fallback(`JSON inválido: ${String((err as Error)?.message ?? err)}`);
  }
  if (!raw || typeof raw !== "object") return fallback("conteúdo não é um objeto JSON");

  if (raw.status === "aberto") {
    return {
      ...ABSENT_DEFAULT,
      status: "aberto",
      decidedAt: asStringOrNull(raw.decidedAt),
      decidedBy: asStringOrNull(raw.decidedBy),
      rationale: asStringOrNull(raw.rationale),
      invalidReason: null,
    };
  }
  if (raw.status !== "encerrado") {
    return fallback(`campo "status" ausente ou desconhecido (${JSON.stringify(raw.status)})`);
  }

  // `encerrado` SEM assunto não trava nada — ver docstring. Um estado escrito
  // pela metade nunca vira um assunto vazio saindo pra base inteira.
  const subject = asStringOrNull(raw.subject);
  if (!subject) return fallback('status="encerrado" sem campo "subject" não-vazio');

  return {
    status: "encerrado",
    subject,
    winner: asCell(raw.winner),
    decidedAt: asStringOrNull(raw.decidedAt),
    decidedBy: asStringOrNull(raw.decidedBy),
    rationale: asStringOrNull(raw.rationale),
    invalidReason: null,
  };
}

/**
 * Atalho pro que quase todo call site quer: o assunto travado, ou `null` se o
 * teste está aberto. É exatamente o formato que `recommendAbcAction` aceita em
 * `opts.lockedSubject`, então o call site vira uma linha.
 */
export function lockedSubjectFromState(state: ClariceAbcState): string | null {
  return state.status === "encerrado" ? state.subject : null;
}

function writeState(rootDir: string, state: ClariceAbcState): ClariceAbcState {
  const p = clariceAbcStatePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

export interface CloseAbcOptions {
  subject: string;
  winner?: AbcCell | null;
  rationale?: string | null;
  decidedBy?: string;
  now?: () => Date;
}

/**
 * Encerra o teste travando `subject`. Escrita propaga erro (não é fail-soft
 * como a leitura — mesma disciplina de `setClariceEnvioEnabled`: falhar em
 * silêncio deixaria o editor achando que encerrou quando não encerrou).
 *
 * Assunto vazio/só-espaço é ERRO, não um encerramento sem assunto: é a mesma
 * invariante que a leitura protege, aplicada na escrita pra que o arquivo
 * inválido nem chegue a existir.
 */
export function closeClariceAbcTest(rootDir: string, opts: CloseAbcOptions): ClariceAbcState {
  const subject = (opts.subject ?? "").trim();
  if (!subject) {
    throw new Error(
      "closeClariceAbcTest: `subject` é obrigatório e não pode ser vazio — encerrar o teste É travar um assunto.",
    );
  }
  const now = opts.now ?? (() => new Date());
  return writeState(rootDir, {
    status: "encerrado",
    subject,
    winner: opts.winner ?? null,
    decidedAt: now().toISOString(),
    decidedBy: opts.decidedBy ?? "editor",
    rationale: opts.rationale ?? null,
  });
}

export interface ReopenAbcOptions {
  rationale?: string | null;
  decidedBy?: string;
  now?: () => Date;
}

/**
 * Reabre o teste. ÚNICO caminho de volta pra `aberto` — nenhum recálculo, em
 * nenhum módulo, chama isto. O `--confirm` que a CLI exige mora na CLI, não
 * aqui: uma função de biblioteca com dois parâmetros de confirmação seria
 * cerimônia sem ganho, já que só a CLI é o caminho do editor.
 */
export function reopenClariceAbcTest(rootDir: string, opts: ReopenAbcOptions = {}): ClariceAbcState {
  const now = opts.now ?? (() => new Date());
  return writeState(rootDir, {
    status: "aberto",
    subject: null,
    winner: null,
    decidedAt: now().toISOString(),
    decidedBy: opts.decidedBy ?? "editor",
    rationale: opts.rationale ?? null,
  });
}

/** Uma linha legível pro relatório da rodada e pro gate do planejador. */
export function describeAbcState(state: ClariceAbcStateRead | ClariceAbcState): string {
  if (state.status === "encerrado") {
    const when = state.decidedAt ? ` em ${state.decidedAt.slice(0, 10)}` : "";
    const who = state.decidedBy ? ` por ${state.decidedBy}` : "";
    const cell = state.winner ? ` (célula ${state.winner})` : "";
    return `teste A/B/C ENCERRADO${when}${who} — assunto travado: "${state.subject}"${cell}`;
  }
  return "teste A/B/C ABERTO — recomendação recalculada a partir dos cliques do ciclo";
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = process.cwd();
  const json = hasFlag(argv, "json");

  // `ClariceAbcStateRead` de propósito na união: no caminho de LEITURA o
  // `--json` sai com `invalidReason` junto (é o que diz se o "aberto" é
  // intencional ou queda de fail-soft); nos de escrita o campo nem existe.
  const emit = (state: ClariceAbcState | ClariceAbcStateRead): void => {
    if (json) console.log(JSON.stringify(state, null, 2));
    else console.log(describeAbcState(state));
  };

  if (hasFlag(argv, "close")) {
    const subject = getArg(argv, "subject");
    if (!subject) {
      console.error('❌ --close exige --subject "Assunto a travar".');
      process.exit(1);
    }
    emit(
      closeClariceAbcTest(root, {
        subject,
        winner: asCell(getArg(argv, "winner")),
        rationale: getArg(argv, "rationale") || null,
      }),
    );
  } else if (hasFlag(argv, "reopen")) {
    // As DUAS flags são exigidas de propósito: reabrir o teste volta a fatiar
    // a audiência em 3 e a congelar o volume, e é justamente o que a #5055
    // proíbe que aconteça sem intenção explícita.
    if (!hasFlag(argv, "confirm")) {
      console.error(
        "❌ --reopen exige também --confirm. Reabrir volta a mandar 3 assuntos e congela a escalada de volume (#5055) — " +
          "não é uma ação que deva passar por engano.",
      );
      process.exit(1);
    }
    emit(reopenClariceAbcTest(root, { rationale: getArg(argv, "rationale") || null }));
  } else {
    emit(readClariceAbcState(root));
  }
}
