/**
 * scripts/lib/diaria/publica-effect-gate.ts (#12655)
 *
 * Gate de efeito externo do fluxo híbrido do `/diaria-publica`: uma fase que
 * pode publicar, subir, agendar ou enfileirar (`PHASE_META[...].effect ===
 * "external"`) só começa quando o estado em disco autoriza. Puro: recebe o
 * registro de autorizações (#12654), o manifesto atual da parte e o veredito
 * do `check-video-before-publish` já lidos; o CLI (`scripts/publica-phase.ts`)
 * faz o I/O.
 *
 * - `upload` (horizontal) e `vertical-api`: precisa de ao
 *   menos uma autorização ATIVA da parte, desta máquina, cujo `plan_sha256` é
 *   o hash do manifesto em disco AGORA. Plano alterado depois da aprovação
 *   (capa, título, link do horizontal gravado depois da aprovação do
 *   vertical) invalida: refazer o dry-run e perguntar de novo. É a mesma
 *   trava que os publishers aplicam por destino antes do 1º efeito
 *   (`consumeBeforeExternalEffects`); aqui ela vale antes de o processo
 *   sequer começar, e para a fase inteira. `vertical-guiado` (os passos no
 *   Chrome e na Buffer) só confere que existe uma autorização do vertical
 *   NÃO invalidada (ativa ou consumida, de qualquer máquina) para o hash do
 *   manifesto em disco agora. Não confere se o `--publish` rodou nem qual
 *   destino cada passo guiado toca: isso segue com quem conduz os passos.
 *   A retomada do `upload` com o vídeo já registrado (`resumeExisting`,
 *   #12883, só refaz podcast/legenda/playlists) passa sem autorização: o
 *   publisher, nesse caminho, não cria vídeo nem consome autorização.
 * - `link`: grava o link do D1 (e enfileira o comentário do LinkedIn). Quem
 *   decide se o link entra é o próprio `link-video-d1.ts` (registro do
 *   upload, releitura na API, `gateVideoLink`); este gate deixa passar.
 * - `stage5` e `stage6-schedule`: o pré-requisito do #12588 em TODOS os
 *   escopos (newsletter, social, all): sem link do vídeo, sem edição marcada
 *   sem vídeo e sem `--skip youtube`, nada sai — inclusive o social, que lê o
 *   link do D1 (X, Threads, Facebook). Vale até o sentinel da Etapa 5
 *   (`.step-5-done.json`): depois dele o `assessVideoBeforePublish` trata a
 *   falta de link como retry de canal e não bloqueia (#12805), então o
 *   Schedule da Etapa 6 passa.
 *
 * Nunca autoriza nada sozinho: só confere o que a conversa já gravou.
 */

import type { VideoPublishAuthorizationStore } from "./video-publish-authorization.ts";
import type { VideoPlanPart } from "./video-publish-plan.ts";
import type { PublicaPart, PublicaPhase } from "./publica-phases.ts";
import { PHASE_META } from "./publica-phases.ts";

export interface VideoGateLike {
  status: string;
  blocking: boolean;
  warning: string | null;
}

export interface EffectGateInput {
  phase: PublicaPhase;
  part: PublicaPart;
  /** Registro de autorizações; `null` + `storeError` quando ilegível (falha fechada). */
  store: VideoPublishAuthorizationStore | null;
  storeError?: string | null;
  /** Hash do manifesto atual da parte em disco (`planSha256`); `null` = sem manifesto. */
  currentPlanSha256: string | null;
  /** Veredito do `assessVideoBeforePublish` (Etapa 5/6). */
  videoGate?: VideoGateLike | null;
  host: string;
  /**
   * Retomada do upload já registrado (#12883): o vídeo desta edição está em
   * `05-youtube-published.json` (`videoId`) e o comando não pode criar outro
   * (o CLI recusa `--force`). Sem `videos.insert` não há autorização a exigir
   * nem a consumir (o `publish-youtube.ts --upload` também não exige). Só
   * vale para `upload`.
   */
  resumeExisting?: { videoId: string } | null;
}

export type EffectGateResult = { ok: true; note: string } | { ok: false; reason: string };

const VIDEO_PHASES: Readonly<Partial<Record<PublicaPhase, VideoPlanPart>>> = {
  upload: "horizontal",
  "vertical-api": "vertical",
  "vertical-guiado": "vertical",
};

/** Pure: a fase externa pode começar agora? */
export function checkExternalEffect(input: EffectGateInput): EffectGateResult {
  const meta = PHASE_META[input.phase];
  if (meta.effect !== "external") return { ok: true, note: `${input.phase} é reversível: sem gate de efeito` };

  const videoPart = VIDEO_PHASES[input.phase];
  if (videoPart) {
    if (input.part !== videoPart) return { ok: false, reason: `${input.phase} é da parte ${videoPart}, não da ${input.part}` };
    if (input.resumeExisting) {
      if (input.phase !== "upload") return { ok: false, reason: `retomada de upload registrado só vale para upload, não para ${input.phase}` };
      return {
        ok: true,
        note: `retomada do vídeo já registrado (${input.resumeExisting.videoId}): sem videos.insert, sem autorização a consumir (#12883)`,
      };
    }
    if (!input.store) {
      return { ok: false, reason: `registro de autorizações indisponível (${input.storeError ?? "não lido"}): nenhuma publicação sem conferir a aprovação` };
    }
    if (!input.currentPlanSha256) {
      return { ok: false, reason: `sem manifesto do plano da parte ${videoPart} em disco: rode o dry-run e peça o "pode publicar"` };
    }
    if (input.phase === "vertical-guiado") {
      // Os passos guiados (Chrome, Buffer) vêm depois do `--publish`, que
      // consome as autorizações: vale qualquer aprovação do plano ATUAL, ativa
      // ou consumida. Invalidada não vale (interrupção ou "não" do editor).
      const approved = input.store.authorizations.filter(
        (a) => a.part === videoPart && a.status !== "invalidated" && a.plan_sha256 === input.currentPlanSha256,
      );
      return approved.length
        ? { ok: true, note: `plano ${input.currentPlanSha256.slice(0, 12)} aprovado (${approved.length} destino(s))` }
        : {
            ok: false,
            reason: `o plano do vertical em disco (${input.currentPlanSha256.slice(0, 12)}) não foi aprovado (ou a aprovação foi invalidada): refaça o dry-run e peça o "pode publicar"`,
          };
    }
    const active = input.store.authorizations.filter((a) => a.part === videoPart && a.status === "active");
    if (!active.length) {
      return {
        ok: false,
        reason: `sem autorização ativa da parte ${videoPart}: "pode publicar" explícito do editor sobre o plano e video-publish-authorize.ts grant antes (#11741, #12654)`,
      };
    }
    const here = active.filter((a) => a.granted_host === input.host);
    if (!here.length) {
      return { ok: false, reason: `autorização da parte ${videoPart} foi concedida em outra máquina (${active[0].granted_host}): o consumo aqui seria recusado` };
    }
    const matching = here.filter((a) => a.plan_sha256 === input.currentPlanSha256);
    if (!matching.length) {
      return {
        ok: false,
        reason:
          `o plano da parte ${videoPart} mudou depois da aprovação (aprovado ${here[0].plan_sha256.slice(0, 12)}, em disco ${input.currentPlanSha256.slice(0, 12)}): ` +
          "refaça o dry-run, mostre o plano novo e peça o \"pode publicar\" de novo",
      };
    }
    return { ok: true, note: `${matching.length} autorização(ões) ativa(s) da parte ${videoPart} para o plano ${input.currentPlanSha256.slice(0, 12)}` };
  }

  if (input.phase === "stage5" || input.phase === "stage6-schedule") {
    const g = input.videoGate;
    if (!g) return { ok: false, reason: "pré-requisito do vídeo não conferido (check-video-before-publish): sem ele a Etapa 5/6 não sai (#12588)" };
    if (g.blocking) return { ok: false, reason: `sem link do vídeo no D1 (${g.status}): ${g.warning ?? "check-video-before-publish exit 3"} (#12588)` };
    return { ok: true, note: `vídeo do D1: ${g.status}${g.warning ? ` (${g.warning})` : ""}` };
  }

  return { ok: true, note: `${input.phase}: o próprio script confere o pré-requisito` };
}
