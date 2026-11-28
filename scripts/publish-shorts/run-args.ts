/**
 * Argumentos e alvo da rodada (#14327 item 5): a leitura do `argv`, as
 * conferências de uso que abortam antes de qualquer leitura ou gravação, a
 * preparação do corte avulso (`--corte`), a confirmação do `--publish`, a
 * pasta da edição e o escritor do registro (rodada principal ou timer do 300).
 *
 * Movido de `mainUnlocked` (`run.ts`) sem mudança de comportamento: a ordem
 * das conferências é a de antes, e cada saída antecipada devolve o exit code
 * da rodada.
 */
import { join, resolve } from "node:path";
import { publishConfirmationError } from "../lib/diaria/publish-confirm.ts";
import {
  ALLOW_UNWATCHED_DIR_FLAG,
  CORTES_REL_DIR,
  checkCorteDir,
  corteRelDir,
  corteVideoPortabilityWarning,
  resolveCorteVideo,
  type CorteSpec,
} from "../lib/diaria/short-corte.ts";
import { shortsRegistryWriterFor, type ShortsRegistryWriter } from "../lib/diaria/shorts-published-store.ts";
import { ROOT, nonCanonicalEditionDir, canonicalShortsEditionDir, checkEditionDir } from "./_shared.ts";
import { USAGE, replaceScheduledArgsError, parseShortsCliArgs } from "./cli.ts";
import {
  CORTE_FORBIDDEN_FLAGS,
  type CorteRevocation,
  corteRequireAuthArgsError,
  prepareCorteRun,
  corteLifecycleArgsError,
  runCorteLifecycle,
} from "./corte.ts";
import { updatePublishedArgsError, runUpdatePublished } from "./update-published.ts";

/** O que a rodada decidiu a partir dos argumentos (só o que o resto do `mainUnlocked` lê). */
export interface ShortsRunTarget {
  flags: Set<string>;
  values: Record<string, string>;
  /** Edição da rodada (no corte avulso, a data do corte). */
  aammdd: string;
  /** #11795: corte avulso preparado (`corte.json` gravado), ou `null` no modo edição. */
  corte: CorteSpec | null;
  /** #11911: corte fora de data/cortes/ aceito por --allow-unwatched-dir. */
  corteOutside: { dir: string; warning: string } | undefined;
  /** #11912: derrubadas do "pode publicar" nesta rodada (o resto da rodada ainda acrescenta). */
  corteRevocations: CorteRevocation[];
  /** #11912: o filho do timer do corte só CONFERE a autorização. */
  requireCorteAuth: boolean;
  /** #12279: `--replace-scheduled`. */
  replaceRun: boolean;
  /** Pasta da edição (ou do corte), absoluta. */
  dir: string;
  /** #11911: `--edition-dir` fora da pasta canônica da edição (`undefined` no corte e na canônica). */
  editionDirOverride: string | undefined;
  unwatchedEditionWarning: string | undefined;
  linkedinTimer: boolean;
  instagramTimer: boolean;
  threadsTimer: boolean;
  writer: ShortsRegistryWriter;
}

/**
 * #14327: lê os argumentos e decide o alvo da rodada, ou devolve o exit code
 * (erro de uso `2`, ou o resultado das rodadas do corte que terminam aqui:
 * `--cancel`/`--reschedule` e `--update-published`).
 */
export async function resolveShortsRunTarget(argv: string[]): Promise<number | ShortsRunTarget> {
  const parsed = parseShortsCliArgs(argv);
  if (!parsed.ok) {
    console.error(`publish-shorts: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { flags, values } = parsed;
  let aammdd = parsed.aammdd;
  // #11795: corte avulso — pasta, registro, data, título e gancho próprios, fora de data/editions/.
  const corteSlug = values["corte"];
  let corte: CorteSpec | null = null;
  // #11911: corte fora de data/cortes/ aceito por --allow-unwatched-dir (sem alarme de destino faltante).
  let corteOutside: { dir: string; warning: string } | undefined;
  // #11912: derrubadas do "pode publicar" nesta rodada — saem no JSON, não só no stderr.
  const corteRevocations: CorteRevocation[] = [];
  const requireCorteAuth = flags.has("require-corte-authorization");
  // #11912: o filho do timer só CONFERE a autorização; nunca muda o plano nem grava nada.
  const requireAuthArgsErr = corteRequireAuthArgsError(flags, values);
  if (requireAuthArgsErr) {
    console.error(`publish-shorts: ${requireAuthArgsErr}`);
    return 2;
  }
  // #13000: --cancel/--reschedule do corte — conferido antes de qualquer leitura ou gravação.
  const lifecycleErr = corteLifecycleArgsError(flags, values);
  if (lifecycleErr) {
    console.error(`publish-shorts: ${lifecycleErr}`);
    return 2;
  }
  // #12936: --update-published — conferido antes de qualquer leitura ou gravação.
  const updatePublishedErr = updatePublishedArgsError(flags, values, aammdd);
  if (updatePublishedErr) {
    console.error(`publish-shorts: ${updatePublishedErr}`);
    return 2;
  }
  // #12279: --replace-scheduled — conferido antes de qualquer leitura ou gravação.
  const replaceRun = flags.has("replace-scheduled");
  const replaceArgsErr = replaceScheduledArgsError(flags, values);
  if (replaceArgsErr) {
    console.error(`publish-shorts: ${replaceArgsErr}`);
    return 2;
  }
  if (corteSlug !== undefined) {
    const forbidden = CORTE_FORBIDDEN_FLAGS.filter((f) => flags.has(f));
    if (forbidden.length) {
      console.error(`publish-shorts: --corte não combina com ${forbidden.map((f) => `--${f}`).join(", ")} (timers e conferência do Instagram são da edição; registre à mão com --mark)`);
      return 2;
    }
    if (values["edition"] !== undefined) {
      console.error("publish-shorts: --corte usa --date AAMMDD, não --edition");
      return 2;
    }
    const corteDir = resolve(values["edition-dir"] ?? join(ROOT, corteRelDir(corteSlug)));
    // #11911: só data/cortes/{slug}/ é vista pelo timer do corte e pelo vigia de cortes sem dono.
    // Conferido antes de qualquer gravação (o prepareCorteRun já grava o corte.json).
    const dirCheck = checkCorteDir({ slug: corteSlug, dir: corteDir, cortesRoot: join(ROOT, CORTES_REL_DIR), allowUnwatched: flags.has(ALLOW_UNWATCHED_DIR_FLAG) });
    if (!dirCheck.ok) {
      console.error(`publish-shorts: ${dirCheck.error}`);
      return 2;
    }
    if (dirCheck.outside) {
      corteOutside = { dir: dirCheck.dir, warning: dirCheck.warning };
      console.error(`[aviso] ${dirCheck.warning}`);
    }
    // #13000: antes do prepareCorteRun, que gravaria o --date/--at novos e derrubaria o "pode publicar".
    if (flags.has("cancel") || flags.has("reschedule")) return runCorteLifecycle({ dir: corteDir, slug: corteSlug, flags, values });
    // #12936: antes do prepareCorteRun, que gravaria --title/--hook e derrubaria o "pode publicar".
    if (flags.has("update-published")) {
      return runUpdatePublished({ dir: corteDir, aammdd: "", corteSlug, values, only: values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null });
    }
    try {
      corte = prepareCorteRun({ slug: corteSlug, dir: corteDir, values, positionalDate: aammdd, log: (l) => console.error(l), onRevoked: (r) => corteRevocations.push(r), unwatchedDirWarning: corteOutside?.warning, readOnly: requireCorteAuth });
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
    aammdd = corte.date;
    console.error(`[premissa] corte avulso "${corte.slug}": ${corte.date} às ${corte.hhmm} BRT, vídeo ${resolveCorteVideo(corteDir, corte.video)}, registro em ${corteDir}`);
    const portability = corteVideoPortabilityWarning(resolveCorteVideo(corteDir, corte.video), join(ROOT, "data"));
    if (portability) console.error(`[aviso] ${portability}`);
  }
  // #11741: `--publish` tem efeito público — só com a confirmação explícita da
  // edição (no corte avulso, a data do corte), checada antes de qualquer
  // download, credencial, API ou gravação de registro.
  if (flags.has("publish")) {
    const confirmErr = publishConfirmationError({ script: "publish-shorts", mode: "--publish", aammdd, flags, values });
    if (confirmErr) {
      console.error(confirmErr);
      return 2;
    }
  }
  // #11911: a pasta canônica da edição é a do repo (ROOT), nunca relativa ao cwd — mesmo critério do corte.
  const canonicalEditionDir = canonicalShortsEditionDir(aammdd);
  const dir = corte ? resolve(values["edition-dir"] ?? join(ROOT, corteRelDir(corte.slug))) : resolve(values["edition-dir"] ?? canonicalEditionDir);
  // #11911: `--edition-dir` fora de data/editions/{AAMM}/{AAMMDD}: nada é delegado aos timers do 300.
  const editionDirOverride = corte ? undefined : nonCanonicalEditionDir(dir, canonicalEditionDir);
  // #11911: e é recusada sem --allow-unwatched-dir. Em 02/11 a rodada original foi no modo edição com
  // --edition-dir ~/diaria-cortes/... e os timers de Instagram da edição ficaram cegos; o
  // `--instagram-timer` com a mesma pasta foi só a remediação manual (12:38 BRT).
  // Depois da confirmação do --publish e antes de qualquer leitura ou gravação na pasta.
  let unwatchedEditionWarning: string | undefined;
  if (!corte) {
    const editionCheck = checkEditionDir({ aammdd, override: editionDirOverride, allowUnwatched: flags.has(ALLOW_UNWATCHED_DIR_FLAG), canonicalDir: canonicalEditionDir });
    if (!editionCheck.ok) {
      console.error(`publish-shorts: ${editionCheck.error}`);
      return 2;
    }
    if (editionCheck.outside) {
      unwatchedEditionWarning = editionCheck.warning;
      console.error(`[aviso] ${editionCheck.warning}`);
    }
  }
  // #11157: cada escritor grava no próprio arquivo (o timer do 300 no dele) e
  // toda gravação relê do disco e troca só a própria entrada, sob lock.
  const linkedinTimer = flags.has("linkedin-timer");
  const instagramTimer = flags.has("instagram-timer");
  const threadsTimer = flags.has("threads-timer");
  if (linkedinTimer && instagramTimer) {
    console.error("publish-shorts: --instagram-timer não combina com --linkedin-timer (cada timer grava o próprio registro)");
    return 2;
  }
  if (threadsTimer && (linkedinTimer || instagramTimer)) {
    console.error("publish-shorts: --threads-timer não combina com outro timer (cada timer grava o próprio registro)");
    return 2;
  }
  const writer = shortsRegistryWriterFor(linkedinTimer, instagramTimer, threadsTimer);
  return {
    flags, values, aammdd, corte, corteOutside, corteRevocations, requireCorteAuth, replaceRun, dir,
    editionDirOverride, unwatchedEditionWarning, linkedinTimer, instagramTimer, threadsTimer, writer,
  };
}
