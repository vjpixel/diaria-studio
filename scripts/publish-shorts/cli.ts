/**
 * Uso, flags da CLI e `parseShortsCliArgs`.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../lib/cli-args.ts";
import { ALLOW_UNWATCHED_DIR_FLAG } from "../lib/diaria/short-corte.ts";
import { loadShortsConfig, type InstagramBackend } from "../lib/diaria/short-video.ts";
import { markShortSending } from "../lib/diaria/shorts-sending-marker.ts";
import { ROOT } from "./_shared.ts";

export const USAGE =
  "uso: publish-shorts.ts AAMMDD [--publish --confirm-publish AAMMDD] [--only dest1,dest2] [--now] [--video PATH | --from-drive FILE_ID]\n" +
  "                       [--linkedin-timer | --instagram-timer | --threads-timer] [--force-youtube] [--keep-video]\n" +
  "                       [--edition-dir DIR] [--edition-url URL] [--edition AAMMDD]\n" +
  "     publish-shorts.ts AAMMDD --mark youtube_shorts=URL | facebook_profile=URL | linkedin_page_repost=URL | linkedin_profile=URL | threads_profile=URL\n" +
  "     publish-shorts.ts AAMMDD --mark x=buffer:ID | tiktok=buffer:ID [--scheduled-at ISO] [--thumbnail-offset MS]\n" +
  "     publish-shorts.ts AAMMDD --replace-scheduled --video PATH_PROPRIO [--only ...] [--publish --confirm-publish AAMMDD]\n" +
  "                                                                                 # troca o VÍDEO dos posts JÁ AGENDADOS (V1 por V2) no mesmo horário (#12279): plano sem --publish;\n" +
  "                                                                                 # o --publish só sai com o grant --replace-scheduled do plano; Buffer via skill (--mark-replaced x=buffer:ANTIGO, depois --mark ... --replaces buffer:ANTIGO --video-sha256 H)\n" +
  "     publish-shorts.ts (AAMMDD | --corte SLUG) --update-scheduled [--only ...] [--publish --confirm-publish AAMMDD]\n" +
  "                                                                                 # troca texto e capa dos posts JÁ AGENDADOS (YouTube, Facebook; Buffer via skill), #11795\n" +
  "     publish-shorts.ts --corte SLUG (--cancel | --reschedule --date AAMMDD --at HH:MM) [--confirm SLUG]\n" +
  "                                                                                 # cancela/reagenda o corte já agendado (#13000): plano sem --confirm; nunca toca o que já está no ar\n" +
  "     publish-shorts.ts (AAMMDD | --corte SLUG [--title T] [--hook H]) --update-published [--only ...] [--confirm AAMMDD|SLUG]\n" +
  "                                                                                 # troca o texto dos posts JÁ NO AR (#12936): plano sem --confirm; YouTube/Facebook/LinkedIn pela API, o resto listado\n" +
  "     publish-shorts.ts AAMMDD --confirm-instagram [--since ISO] [--media-id ID]   # registra o Reels postado no Chrome/app (lê a API: conta da diar.ia.br, #11794)\n" +
  "     publish-shorts.ts AAMMDD --confirm-instagram --url URL                       # registra pelo permalink do Reel, sem conferir na API (#11390)\n" +
  "     publish-shorts.ts --corte SLUG --date AAMMDD --at HH:MM --title T --hook H (--video PATH | --from-drive ID) [--cover JPG] [--publish] [--only ...] [--now]\n" +
  "                                                                                 # corte avulso fora de edição (#11795): registro em data/cortes/SLUG/, re-execução só com --corte SLUG\n" +
  "                                                                                 # (fora de data/cortes/: o mesmo --edition-dir e --allow-unwatched-dir)\n" +
  "                                                                                 # (o dry-run também grava data/cortes/SLUG/corte.json: registra o corte; --from-drive baixa sempre para essa pasta)\n" +
  "                                                                                 # --edition-dir fora de data/cortes/SLUG/ (corte) ou de data/editions/AAMM/AAMMDD/ (edição) é recusado;\n" +
  "                                                                                 # --allow-unwatched-dir roda mesmo assim, sem alarme de destino faltante (#11911)";

/** Flags booleanas do `publish-shorts.ts` (não levam valor). */
export const SHORTS_BOOLEAN_FLAGS = ["publish", "now", "confirm-instagram", "linkedin-timer", "instagram-timer", "threads-timer", "force-youtube", "keep-video", "update-scheduled", "replace-scheduled", "require-corte-authorization", "cancel", "reschedule", "update-published", ALLOW_UNWATCHED_DIR_FLAG] as const;

/** #12279: flags que não combinam com `--replace-scheduled` (corte, timers, publicação na hora, outras trocas). */
export const REPLACE_SCHEDULED_FORBIDDEN_FLAGS = [
  "now", "update-scheduled", "update-published", "cancel", "reschedule", "require-corte-authorization", "force-youtube",
  "linkedin-timer", "instagram-timer", "threads-timer", "confirm-instagram",
] as const;
/**
 * `from-drive` fica de fora (#12279, review da PR #13107): ele baixa para o
 * arquivo canônico do vertical, que o Instagram, o Threads, o LinkedIn e os
 * timers do 300 ainda usam; a troca leva o V2 por `--video` com caminho próprio.
 */
export const REPLACE_SCHEDULED_FORBIDDEN_VALUES = ["corte", "mark", "mark-replaced", "replaces", "video-sha256", "scheduled-at", "from-drive"] as const;

/** Pure (#12279): o `--replace-scheduled` é da edição, sem timers e sem publicação na hora. `null` = ok. */
export function replaceScheduledArgsError(flags: ReadonlySet<string>, values: Readonly<Record<string, string>>): string | null {
  if (!flags.has("replace-scheduled")) {
    if (values["replaces"] !== undefined && values["mark"] === undefined) return "--replaces só vale com --mark x=buffer:ID ou tiktok=buffer:ID (#12279)";
    if (values["mark-replaced"] !== undefined && values["mark"] !== undefined) return "--mark-replaced é um passo próprio: não combina com --mark (#12279)";
    return null;
  }
  const bad = [
    ...REPLACE_SCHEDULED_FORBIDDEN_FLAGS.filter((f) => flags.has(f)).map((f) => `--${f}`),
    ...REPLACE_SCHEDULED_FORBIDDEN_VALUES.filter((v) => values[v] !== undefined).map((v) => `--${v}`),
  ];
  if (bad.length) {
    const drive = bad.includes("--from-drive") ? " (baixe o V2 para um caminho próprio e passe --video PATH: o --from-drive sobrescreveria o vertical que os outros destinos e os timers ainda usam)" : "";
    return `--replace-scheduled é da edição e não combina com ${bad.join(", ")}${drive} (#12279)`;
  }
  return null;
}

/**
 * #12279: a marca "cancelando" da troca é a marca de envio do destino no
 * arquivo da rodada principal: a releitura do registro e o dry-run a acusam
 * enquanto o desfecho do cancelamento não é conhecido.
 */
export function markReplaceCancelling(dir: string, aammdd: string, destination: string): void {
  markShortSending(dir, aammdd, "main", { destination, started_at: new Date().toISOString(), pid: process.pid });
}

/** #12279: lock da substituição: enquanto ele vive, nenhum --publish da rodada principal sai. */
export const SHORTS_REPLACE_LOCK_FILE = "_internal/shorts-replace.lock";

/**
 * Pure (#10978): `parseArgs` + a edição. O parser genérico lê
 * `--confirm-instagram 261022` como `values["confirm-instagram"] = "261022"`
 * (a data vira valor da flag) e o comando caía no usage. Aqui a data colada
 * numa flag booleana volta a ser a edição, então as duas ordens valem.
 * Valor que não é AAMMDD numa flag booleana, ou duas edições diferentes, é
 * erro de uso (nunca adivinha qual edição gravar).
 */
export function parseShortsCliArgs(argv: string[]):
  | { ok: true; aammdd: string; flags: Set<string>; values: Record<string, string>; positional: string[] }
  | { ok: false; error: string } {
  const { flags, values, positional } = parseArgs(argv);
  const positionalOut = [...positional];
  // Só AAMMDD é posicional: o resto (ex.: um `publish` sem `--`) é erro de uso,
  // nunca candidato a edição ("edição ambígua: 261022, publish" enganava).
  const unknown = positionalOut.find((p) => !/^\d{6}$/.test(p));
  if (unknown !== undefined) return { ok: false, error: `argumento não reconhecido: ${unknown}` };
  for (const f of SHORTS_BOOLEAN_FLAGS) {
    const v = values[f];
    if (v === undefined) continue;
    if (!/^\d{6}$/.test(v)) return { ok: false, error: `--${f} não leva valor (recebeu "${v}")` };
    delete values[f];
    flags.add(f);
    positionalOut.push(v);
  }
  const candidates = [...new Set([values["edition"], ...positionalOut].filter((x): x is string => typeof x === "string"))];
  if (candidates.length > 1) return { ok: false, error: `edição ambígua: ${candidates.join(", ")}` };
  const aammdd = candidates[0];
  // #11795: no corte avulso a data vem de --date (ou do corte.json); o AAMMDD posicional é opcional.
  if (!aammdd && values["corte"] !== undefined) return { ok: true, aammdd: "", flags, values, positional: positionalOut };
  if (!aammdd || !/^\d{6}$/.test(aammdd)) return { ok: false, error: "AAMMDD ausente ou inválido" };
  return { ok: true, aammdd, flags, values, positional: positionalOut };
}

/**
 * #11410: `publishing.shorts.threads_profile_via_timer` no config real; config
 * ilegível = `"unreadable"` (o `--threads-timer` recusa).
 */
export function configuredThreadsViaTimer(): boolean | "unreadable" {
  try {
    return loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))).threadsProfileViaTimer;
  } catch {
    return "unreadable";
  }
}

/**
 * Backend do Instagram no config real; config ilegível = `"unreadable"` (#11368:
 * o `--instagram-timer` recusa, inclusive no `--mark`, em vez de pular a regra).
 */
export function configuredInstagramBackend(): InstagramBackend | "unreadable" {
  try {
    return loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))).instagramBackend;
  } catch {
    return "unreadable";
  }
}
