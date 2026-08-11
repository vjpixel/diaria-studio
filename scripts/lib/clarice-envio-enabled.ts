/**
 * clarice-envio-enabled.ts (automação do envio Clarice — decisões do editor
 * 260811)
 *
 * Toggle explícito "automação de envio ativa/pausada" do par de tasks
 * diárias que passou a governar a rampa Clarice:
 *   - `Diaria-Clarice-Envio` (19:00 BRT) — planeja a onda do dia seguinte e
 *     agenda a campanha pras 06:00 BRT (09:00 UTC);
 *   - `Diaria-Clarice-Envio-Guard` (05:00 BRT) — reavalia o freio de risco de
 *     ISP na véspera imediata do disparo.
 *
 * Espelho de `scripts/lib/clarice-novos-enabled.ts` (#4941), que por sua vez
 * espelha `scripts/lib/studio-chat-enabled.ts` (#4078): mesmo shape de
 * estado, mesmo arquivo dedicado sob `data/`, mesmo CLI `--set
 * enabled|disabled`. Duas divergências deliberadas, ambas documentadas
 * abaixo — a primeira é decisão explícita do editor, a segunda é
 * consequência direta dela.
 *
 * ===========================================================================
 * DIVERGÊNCIA 1 (decisão do editor): ARQUIVO AUSENTE => LIGADO (`true`)
 * ===========================================================================
 * O irmão `clarice-novos-enabled.ts` nasce PAUSADO (`enabled: false` quando o
 * arquivo não existe): lá, armar o timer nunca liga a automação sozinho, e o
 * editor precisa liberar explicitamente depois de conferir a 1ª rodada. Aqui
 * o default é o OPOSTO — **arquivo ausente significa LIGADO**. Foi decisão
 * explícita do editor ao desenhar a automação ("Ligada desde o início"): a
 * rampa Clarice já roda hoje, manualmente, todo dia; a automação substitui um
 * trabalho que já acontece, não estreia um canal novo. Uma automação que
 * nasce pausada, nesse contexto, só produz um dia sem envio até alguém
 * lembrar do toggle.
 *
 * **O risco que esse default cobra, explicitamente aceito:** um arquivo
 * PERDIDO não pausa a automação. Se `data/clarice-envio-enabled.json` sumir —
 * junction `data/` do OneDrive não montada, pasta recriada vazia numa máquina
 * nova, restore parcial de backup — o estado volta pro default LIGADO, mesmo
 * que o editor tivesse pausado de propósito. No irmão, o mesmo acidente
 * falharia pro lado seguro. Aqui, falha pro lado do envio.
 *
 * Duas mitigações, nenhuma delas neste módulo:
 *   (a) o guard de pré-condição da task (`clarice-users.db` presente, ver
 *       `scripts/lib/scheduled-tasks.ts`) cobre justamente o cenário mais
 *       provável de arquivo sumido — `data/` não montada — e aborta a rodada
 *       antes de qualquer escrita;
 *   (b) o freio de risco de ISP (bounce/unsub/spam) roda dentro da rodada e
 *       independe deste toggle: pausar aqui é conveniência do editor, nunca a
 *       única proteção.
 *
 * ===========================================================================
 * DIVERGÊNCIA 2 (consequência da 1): ARQUIVO CORROMPIDO => PAUSADO (`false`)
 * ===========================================================================
 * "Ausente" e "corrompido" são estados DIFERENTES e aqui recebem defaults
 * diferentes — no irmão os dois colapsam em `false` porque `false` já era o
 * default de ausente.
 *
 * JSON inválido, arquivo vazio, `enabled` de tipo errado ou campo faltando
 * não são sinal de INTENÇÃO nenhuma: são sinal de PROBLEMA (escrita
 * interrompida no meio, conflito de sync do OneDrive, edição manual
 * malfeita). Diante de um sinal de problema, o lado seguro de uma automação
 * que dispara e-mail em massa é não disparar. Por isso o fail-soft de leitura
 * aponta pra `false` — deliberadamente diferente do default de ausência.
 *
 * Como um arquivo corrompido pausa a automação sem o editor ter pedido, essa
 * pausa NÃO pode ser silenciosa: `readClariceEnvioEnabledState` chama
 * `opts.onInvalid` (default `console.warn`) sempre que existe um arquivo que
 * não deu pra interpretar. O runner loga isso na rodada; sem o aviso, um
 * arquivo corrompido viraria "a automação simplesmente parou de enviar" —
 * exatamente a classe de falha silenciosa que o #4941 documenta.
 *
 * Resumo das três leituras possíveis:
 *   | estado do arquivo                        | `enabled` | avisa |
 *   |------------------------------------------|-----------|-------|
 *   | ausente                                  | `true`    | não   |
 *   | presente e válido                        | o valor   | não   |
 *   | presente e ilegível/inválido             | `false`   | SIM   |
 *
 * Estado persistido em `data/clarice-envio-enabled.json` — arquivo NOVO e
 * dedicado, nunca reaproveita nenhum estado já existente sob `data/` (mesma
 * disciplina do #4078/#4941), e em particular NUNCA compartilhado com
 * `data/clarice-novos-enabled.json`: são automações distintas, com defaults
 * opostos, que precisam ser pausadas independentemente.
 *
 * Uso CLI (mesmo padrão de `exec-mode.ts`/`clarice-novos-enabled.ts`):
 *   npx tsx scripts/lib/clarice-envio-enabled.ts
 *   # → imprime "enabled" ou "disabled" (exit 0 sempre)
 *   npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled
 *   npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled
 *
 * @see scripts/lib/clarice-novos-enabled.ts (#4941 — molde direto)
 * @see scripts/lib/studio-chat-enabled.ts (#4078 — molde original)
 * @see docs/clarice-envio-daily-setup.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, isMainModule } from "./cli-args.ts";

export interface ClariceEnvioEnabledState {
  /** `true` = default de arquivo AUSENTE (decisão do editor "ligada desde o
   * início" — ver Divergência 1 na docstring do módulo). `false` = o editor
   * pausou explicitamente, OU o arquivo existe e não deu pra interpretar
   * (Divergência 2). */
  enabled: boolean;
  /** ISO — quando o estado foi alterado pela última vez via
   * `setClariceEnvioEnabled`. `null` = nunca escrito (arquivo ausente, estado
   * no default) ou arquivo ilegível. */
  updatedAt: string | null;
}

/** Arquivo AUSENTE: automação LIGADA. Ver Divergência 1 na docstring. */
const ABSENT_DEFAULT: ClariceEnvioEnabledState = { enabled: true, updatedAt: null };

/** Arquivo PRESENTE mas ilegível/inválido: automação PAUSADA. Ver Divergência 2. */
const INVALID_DEFAULT: ClariceEnvioEnabledState = { enabled: false, updatedAt: null };

export interface ReadClariceEnvioEnabledOptions {
  /** Chamado quando o arquivo EXISTE mas não deu pra interpretar (JSON
   * inválido, vazio, `enabled` ausente ou de tipo errado, erro de leitura).
   * Default `console.warn`. Injetável porque essa pausa não foi pedida pelo
   * editor e não pode ser silenciosa — o runner encaminha isso pro log/
   * relatório da rodada; testes passam um coletor pra assertar o aviso sem
   * poluir a saída. */
  onInvalid?: (message: string) => void;
}

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-enabled.json");
}

/**
 * Lê o estado do toggle. Fail-soft total — nunca lança. Ausente →
 * `{enabled: true, updatedAt: null}`; presente e válido → o valor do arquivo;
 * presente e ilegível/inválido → `{enabled: false, updatedAt: null}` + aviso
 * via `opts.onInvalid`. Ver a tabela na docstring do módulo.
 */
export function readClariceEnvioEnabledState(
  rootDir: string,
  opts: ReadClariceEnvioEnabledOptions = {},
): ClariceEnvioEnabledState {
  const warn = opts.onInvalid ?? ((m: string) => console.warn(m));
  const p = statePath(rootDir);
  if (!existsSync(p)) return { ...ABSENT_DEFAULT };

  let raw: Partial<ClariceEnvioEnabledState>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ClariceEnvioEnabledState>;
  } catch (e) {
    warn(
      `[clarice-envio-enabled] ${p} existe mas não deu pra ler/parsear (${(e as Error).message}) — ` +
        `assumindo PAUSADO por segurança. Isso NÃO é o default de arquivo ausente (que é LIGADO): ` +
        `um arquivo ilegível é sinal de problema, não de intenção. Conserte o arquivo ou rode ` +
        `\`npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled\` pra reescrevê-lo.`,
    );
    return { ...INVALID_DEFAULT };
  }

  if (raw === null || typeof raw !== "object" || typeof raw.enabled !== "boolean") {
    warn(
      `[clarice-envio-enabled] ${p} existe mas não tem um campo booleano "enabled" — ` +
        `assumindo PAUSADO por segurança (arquivo inválido não é o mesmo que arquivo ausente). ` +
        `Rode \`npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled\` pra reescrevê-lo.`,
    );
    return { ...INVALID_DEFAULT };
  }

  return {
    enabled: raw.enabled,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** Atalho booleano de `readClariceEnvioEnabledState` — o que
 * `clarice-envio-run.ts`/`clarice-envio-guard.ts` consultam no Passo 0, ANTES
 * de qualquer chamada Brevo. */
export function isClariceEnvioEnabled(rootDir: string, opts: ReadClariceEnvioEnabledOptions = {}): boolean {
  return readClariceEnvioEnabledState(rootDir, opts).enabled;
}

/** Escreve o novo estado do toggle — único ponto de escrita deste módulo.
 * Cria `data/` se por algum motivo ainda não existir. Propaga qualquer erro
 * de escrita real (disco cheio, permissão) pro caller — mesma disciplina de
 * `setClariceNovosEnabled`/`setChatEnabled`: a leitura é fail-soft, a
 * escrita NÃO. Uma falha silenciosa aqui deixaria o editor achando que pausou
 * a automação quando na verdade ela segue ligada — o pior resultado possível
 * pro caminho de escrita deste módulo em particular, porque o default de
 * ausência é LIGADO. */
export function setClariceEnvioEnabled(
  rootDir: string,
  enabled: boolean,
  opts: { now?: () => Date } = {},
): ClariceEnvioEnabledState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  const state: ClariceEnvioEnabledState = { enabled, updatedAt: now().toISOString() };
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const setArg = getArg(process.argv.slice(2), "set");
  if (setArg === "enabled" || setArg === "disabled") {
    const state = setClariceEnvioEnabled(process.cwd(), setArg === "enabled");
    console.log(state.enabled ? "enabled" : "disabled");
  } else {
    console.log(isClariceEnvioEnabled(process.cwd()) ? "enabled" : "disabled");
  }
}
