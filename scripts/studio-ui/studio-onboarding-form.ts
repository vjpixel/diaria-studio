/**
 * studio-onboarding-form.ts (#12583)
 *
 * Camada de leitura de `GET /api/onboarding/form-results`: o resultado
 * parcial do formulário (formulario.diar.ia.br, #10605) para o editor ver no
 * Studio sem pedir a uma sessão. Lê AO VIVO o `GET /api/respostas` do Worker
 * (o mesmo endpoint e token do executor, `onboarding.followup` do
 * `platform.config.json` + `form_responses_token_env` do .env/Doppler) e o
 * store local (`data/onboarding/store.json`, para a origem de cada resposta)
 * e agrega em `buildFormPartialResults` (lógica pura,
 * `scripts/lib/onboarding-form-partial-results.ts`).
 *
 * Só leitura: nenhum POST, nenhuma escrita no KV, no Kit ou no store. Só
 * roda quando o editor clica em "Carregar" na página (não a cada abertura),
 * porque cada leitura percorre as páginas do KV no Worker.
 *
 * Falhas conhecidas (endpoint ou token ausentes, Worker fora) viram
 * `{ available: false, motivo }`, nunca exceção: a página mostra o motivo.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStore } from "../lib/onboarding-store.ts";
import { resolveFollowupConfig, type FollowupConfig, type FollowupConfigRaw, type FollowupPerson } from "../lib/onboarding-followup.ts";
import { buildFormPartialResults, type FormPartialResults } from "../lib/onboarding-form-partial-results.ts";
import type { FormResponse } from "../lib/onboarding-form-contract.ts";
import { fetchFormResponsesReal } from "../onboarding-followup-run.ts";

export type FormResultsView =
  | ({ available: true; geradoEm: string; storeLido: boolean } & FormPartialResults)
  | { available: false; motivo: string; geradoEm: string };

export interface FormResultsDeps {
  /** Lê as respostas do Worker (padrão: `fetchFormResponsesReal`). */
  fetchResponses?: (cfg: FollowupConfig) => Promise<FormResponse[]>;
  storePath?: string;
  configPath?: string;
  now?: () => Date;
}

/** Monta a visão; nunca lança pros casos conhecidos. */
export async function buildFormResultsView(rootDir: string, deps: FormResultsDeps = {}): Promise<FormResultsView> {
  const geradoEm = (deps.now ?? (() => new Date()))().toISOString();
  let cfg: FollowupConfig;
  try {
    const raw = JSON.parse(readFileSync(deps.configPath ?? resolve(rootDir, "platform.config.json"), "utf8")) as {
      onboarding?: { followup?: FollowupConfigRaw };
    };
    cfg = resolveFollowupConfig(raw.onboarding?.followup);
  } catch (e) {
    return { available: false, motivo: `platform.config.json ilegível: ${(e as Error).message}`, geradoEm };
  }
  if (!cfg.formResponsesUrl) {
    return { available: false, motivo: "onboarding.followup.form_responses_url não configurado no platform.config.json", geradoEm };
  }
  let responses: FormResponse[];
  try {
    responses = await (deps.fetchResponses ?? ((c) => fetchFormResponsesReal(c)))(cfg);
  } catch (e) {
    return { available: false, motivo: `respostas indisponíveis: ${(e as Error).message}`, geradoEm };
  }
  const storePath = deps.storePath ?? resolve(rootDir, "data", "onboarding", "store.json");
  const { store, corrupted } = readStore(storePath);
  const people: Record<string, FollowupPerson> = corrupted ? {} : (store.followup?.people ?? {});
  const storeLido = !corrupted && Object.keys(people).length > 0;
  return { available: true, geradoEm, storeLido, ...buildFormPartialResults(responses, { people }) };
}
