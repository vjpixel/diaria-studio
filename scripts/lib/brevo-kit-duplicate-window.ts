/**
 * brevo-kit-duplicate-window.ts (#6705)
 *
 * Instrumentação de MEDIÇÃO (não correção) da janela de duplicidade
 * Kit×Brevo descrita na issue #6705: quando um contato `in_brevo` confirma o
 * double opt-in no Kit, `evaluate-brevo-diaria.ts` só detecta isso (e sai da
 * fila do canal Brevo) na PRÓXIMA rodada de avaliação — não no instante do
 * clique. Entre a confirmação real e esta detecção existe uma janela em que
 * a pessoa pode receber a diária pelos dois canais (Kit E Brevo).
 *
 * Decisão do editor (comentário 260830 da issue #6705, via
 * `/diaria-desbloqueia`): medir a frequência real da duplicidade ANTES de
 * escolher entre webhook do Kit (saída instantânea), aumentar a frequência
 * da rodada de avaliação (encurta sem eliminar), ou aceitar-e-documentar.
 * Este módulo é EXCLUSIVAMENTE a medição — nenhuma das 3 soluções é
 * implementada aqui.
 *
 * ## O que é registrado, e por quê
 *
 * A cada detecção real (`push === true`) de "contato já `active` no Kit" no
 * bloco de auto-confirmação de `runEvaluation` (`scripts/evaluate-brevo-
 * diaria.ts`), 1 linha JSONL é gravada (`appendBrevoKitDuplicateWindowLog`)
 * com:
 *
 *   - `detected_at`: quando ESTA rodada notou a confirmação — a saída da
 *     fila acontece agora, não no instante do clique real (que este
 *     processo, rodando 1x/dia via `Diaria-Brevo-Diaria-Evaluate`, nunca
 *     observa diretamente).
 *   - `kit_subscriber_created_at`: `created_at` do subscriber lido via
 *     `GET /v4/subscribers/{id}` do Kit — o timestamp mais próximo que a
 *     API expõe pro momento de entrada no funil. **Não é** o instante da
 *     confirmação do double opt-in em si (a leitura de subscriber do Kit
 *     não separa "criado" de "confirmado" — ver `kit-subscribers.ts`); é só
 *     um limite INFERIOR (a pessoa não pode ter confirmado antes de existir
 *     como subscriber).
 *   - `last_brevo_send_at`/`brevo_sends_count`: estado da Brevo pra este
 *     contato no momento da detecção — já lido pelo Passo 0/2 de
 *     `runEvaluation` (`fetchBrevoContactState`/`latestEventTime` de
 *     `statistics.messagesSent`), nenhuma chamada extra à API.
 *   - `hours_since_last_brevo_send`: horas entre o último envio Brevo
 *     confirmado e esta detecção — é o dado que de fato mede o TAMANHO
 *     PRÁTICO da janela pra este caso específico: um envio Brevo recente
 *     (próximo da detecção) é candidato forte a ter saído DEPOIS que a
 *     pessoa já estava confirmada no Kit (duplicidade real); um envio
 *     antigo é irrelevante pra esta janela. `null` se o contato nunca
 *     recebeu nenhum envio Brevo.
 *
 * ## O que este módulo NÃO faz
 *
 * Não decide com certeza "isto foi duplicidade" — não temos o instante
 * exato da confirmação do double opt-in (só o Kit sabe, e a API de leitura
 * de subscriber não expõe isso). É deliberadamente uma medição CONSERVADORA
 * (conta OCORRÊNCIAS de saída tardia + a distância até o último envio
 * Brevo, nunca uma classificação binária "foi/não foi duplicado") — que
 * threshold de `hours_since_last_brevo_send` conta como "duplicidade
 * provável" fica pra quando o editor analisar o log acumulado, não
 * hard-coded aqui.
 *
 * Não corrige a janela (webhook, frequência de rodada, ou
 * aceitar-e-documentar) — só mede, por decisão explícita do editor
 * (issue #6705). O caller (`runEvaluation`) decide SE chama este módulo via
 * dependência injetável (`appendDuplicateWindowLog`, opcional): omitida nos
 * testes (nenhum efeito colateral em disco), injetada com a implementação
 * de produção só por `main()`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_BREVO_KIT_DUPLICATE_WINDOW_LOG_PATH = resolve(
  ROOT,
  "data/brevo-diaria/kit-duplicate-window-log.jsonl",
);

export interface BrevoKitDuplicateWindowEntry {
  email: string;
  /** ISO — quando ESTA rodada de `runEvaluation` detectou a confirmação. */
  detected_at: string;
  /** ISO `created_at` do subscriber no Kit, ou `null` se indisponível. */
  kit_subscriber_created_at: string | null;
  /** ISO do envio Brevo mais recente já confirmado pra este contato antes
   *  da detecção, ou `null` se nunca recebeu nenhum. */
  last_brevo_send_at: string | null;
  /** Campanhas Brevo (dedup por campaignId) recebidas antes desta detecção. */
  brevo_sends_count: number;
  /** Horas entre `last_brevo_send_at` e `detected_at` — `null` quando
   *  `last_brevo_send_at` é `null` ou não-parseável. Arredondado a 1 casa. */
  hours_since_last_brevo_send: number | null;
}

export interface BuildDuplicateWindowEntryParams {
  email: string;
  kitSubscriberCreatedAt: string | null;
  lastBrevoSendAt: string | null;
  brevoSendsCount: number;
  /** Injetável pra teste (#633) — nunca `Date.now()` direto em teste. */
  nowMs?: number;
}

/**
 * Pura — monta a entrada de log a partir de dados já lidos pelo caller
 * (nenhum fetch aqui). `hours_since_last_brevo_send` é `null` quando
 * `lastBrevoSendAt` é `null` (contato nunca recebeu envio Brevo) ou quando o
 * timestamp não é parseável (fail-safe: nunca `NaN` gravado no log).
 */
export function buildDuplicateWindowEntry(params: BuildDuplicateWindowEntryParams): BrevoKitDuplicateWindowEntry {
  const { email, kitSubscriberCreatedAt, lastBrevoSendAt, brevoSendsCount, nowMs = Date.now() } = params;

  let hoursSinceLastBrevoSend: number | null = null;
  if (lastBrevoSendAt) {
    const sentMs = new Date(lastBrevoSendAt).getTime();
    if (Number.isFinite(sentMs)) {
      hoursSinceLastBrevoSend = Math.round(((nowMs - sentMs) / (60 * 60 * 1000)) * 10) / 10;
    }
  }

  return {
    email,
    detected_at: new Date(nowMs).toISOString(),
    kit_subscriber_created_at: kitSubscriberCreatedAt,
    last_brevo_send_at: lastBrevoSendAt,
    brevo_sends_count: brevoSendsCount,
    hours_since_last_brevo_send: hoursSinceLastBrevoSend,
  };
}

/**
 * I/O — grava 1 linha JSONL append-only (cria o diretório pai se
 * necessário), mesmo padrão de `appendKitExclusionLog`
 * (`brevo-kit-active-exclusion.ts`, #6485).
 */
export function appendBrevoKitDuplicateWindowLog(
  entry: BrevoKitDuplicateWindowEntry,
  path: string = DEFAULT_BREVO_KIT_DUPLICATE_WINDOW_LOG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}
