/**
 * scripts/lib/diaria/short-corte.ts (#11795)
 *
 * Miolo PURO do vídeo vertical AVULSO (um "corte" fora de edição, ex.: um
 * trecho de mentoria em `Cortes para as redes`) publicado pelo
 * `publish-shorts.ts --corte SLUG`.
 *
 * Até o #11795 o `publish-shorts.ts` só funcionava a partir de uma edição, e o
 * agendamento de um corte (01/11/2026) saiu com workarounds: um `02-reviewed.md`
 * sintético com um DESTAQUE 1 falso, nome de arquivo e chave de R2 da edição
 * do dia (`diaria-comentada-261102-short.mp4`), `--edition-url` só pra
 * satisfazer o plano, e o horário caindo na rotação do teste do #10831.
 *
 * O modo corte resolve isso com:
 *   - título e gancho explícitos (`--title`, `--hook`), nunca um D1;
 *   - registro próprio em `data/cortes/{slug}/` (`corte.json` + o registro por
 *     destino de sempre, `_internal/06-shorts-published.json`), fora de
 *     `data/editions/` — não conta como amostra do teste de horário;
 *   - chaves de R2 próprias (`shorts/cortes/{slug}.mp4`), que não colidem com
 *     o vertical da edição do dia;
 *   - horário explícito (`--at HH:MM`), fora da rotação do #10831;
 *   - sem delegar aos timers do 300 (eles procuram a pasta da edição e não
 *     enxergam o corte): o que a API não agenda fica `pending_schedule`, com o
 *     comando de re-execução no `owners` do plano;
 *   - #11912: o que o timer do 300 (`Diaria-Shorts-Cortes`) publica depende do
 *     "pode publicar" do editor gravado no `corte.json` (destinos e sha256 do
 *     vídeo e da capa), nunca da simples existência do arquivo.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShortTime } from "./short-video.ts";

/** Especificação do corte, gravada em `data/cortes/{slug}/corte.json`. */
export interface CorteSpec {
  slug: string;
  /** Dia da publicação, AAMMDD. */
  date: string;
  /** HH:MM BRT. */
  hhmm: string;
  title: string;
  /** Gancho: a 1ª frase vai no texto de cada rede (mesmo papel do corpo do D1). */
  hook: string;
  /** Caminho do vertical: relativo à pasta do corte quando está nela (`corteVideoRef`), senão absoluto. */
  video: string;
  /**
   * #11912: o "pode publicar" do editor. Só o `--publish --confirm-publish`
   * do corte grava (`withCortePublishAuthorization`); o dry-run nunca. O
   * `--update-scheduled --publish --confirm-publish` do corte devolve uma
   * autorização derrubada por mudança de PLANO (`planCorteAuthorizationRestore`),
   * nunca uma derrubada por conteúdo. Sem ele, o timer do 300
   * (`Diaria-Shorts-Cortes`) não publica nada.
   */
  publish_confirmed_at?: string;
  /**
   * #11912: destinos que o `--publish` confirmado autorizou: o `--only` usado,
   * ou, sem `--only`, a lista concreta dos destinos da config naquele momento
   * (destino ligado depois não entra).
   */
  publish_confirmed_destinations?: string[];
  /**
   * #11912: impressão digital (sha256) do vídeo e da capa aprovados,
   * obrigatória com a autorização. Trocar o arquivo depois do "pode publicar"
   * (re-export no mesmo `--video`, outro `--from-drive`, outra `--cover`) não
   * herda a autorização.
   */
  publish_confirmed_content?: CorteContentFingerprint;
  /**
   * #11912: quando a última autorização caiu (plano ou conteúdo mudou). Os
   * quatro `publish_revoked_*` andam juntos e convivem com uma autorização
   * parcial (destinos diferentes): o "pode publicar" de um `--only` menor tira
   * da lista só os destinos que concedeu; a lista vazia apaga o registro.
   */
  publish_revoked_at?: string;
  /** #11912: os destinos que estavam autorizados e caíram (o timer alarma `revoked` se ficarem pendentes). */
  publish_revoked_destinations?: string[];
  /**
   * #11912: por que caiu. `plan` (título, gancho, data, horário): o
   * `--update-scheduled --publish --confirm-publish` pode restaurar, desde que
   * o vídeo e a capa sejam os aprovados (`publish_revoked_content`). `content`
   * (vídeo ou capa, inclusive outro `--video`): só um `--publish
   * --confirm-publish` explícito, sem `--update-scheduled`, autoriza de novo.
   */
  publish_revoked_reason_kind?: CorteRevocationKind;
  /** #11912: a impressão digital aprovada antes da queda `plan` (o restore confere contra ela). */
  publish_revoked_content?: CorteContentFingerprint;
}

/** #11912: motivo da queda do "pode publicar" (ver `publish_revoked_reason_kind`). */
export type CorteRevocationKind = "plan" | "content";

/** #11912: sha256 (hex) do vídeo e da capa do corte; `null` = arquivo ausente. */
export interface CorteContentFingerprint {
  video_sha256: string | null;
  cover_sha256: string | null;
}

export const CORTE_SPEC_FILE = "corte.json";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DATE_RE = /^\d{6}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Slug do corte: minúsculas, dígitos e hífen (vira nome de pasta e chave de R2). */
export function validateCorteSlug(slug: string): string | null {
  return SLUG_RE.test(slug) ? null : `--corte espera um slug em minúsculas, dígitos e hífen (2 a 64 caracteres), recebeu ${JSON.stringify(slug)}`;
}

/** Pasta dos cortes, relativa à raiz do repo. */
export const CORTES_REL_DIR = "data/cortes";

/** Pasta do corte, relativa à raiz do repo. */
export function corteRelDir(slug: string): string {
  return `data/cortes/${slug}`;
}

/**
 * #11911: escape explícito do `publish-shorts.ts` para rodar de uma pasta que
 * nenhum timer nem vigia enxerga — no modo corte, fora de `data/cortes/{slug}/`;
 * no modo edição, fora de `data/editions/{AAMMDD}/`.
 */
export const ALLOW_UNWATCHED_DIR_FLAG = "allow-unwatched-dir";

/**
 * #11911: caminho real de `p` mesmo que ele (ou o fim dele) ainda não exista —
 * resolve o maior ancestral existente e reanexa o resto. `data/` é symlink pro
 * OneDrive e a pasta do corte nasce na 1ª rodada, então `realpath` puro falharia
 * justamente no caso comum.
 */
export function realpathLenient(p: string, realpath: (p: string) => string = realpathSync): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpath(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** #11911: desfecho da conferência da pasta do corte (`checkCorteDir`). */
export type CorteDirCheck =
  | { ok: true; outside: false }
  | { ok: true; outside: true; dir: string; warning: string }
  | { ok: false; error: string };

/**
 * Puro (#11911): a pasta do corte (`--edition-dir`, ou a canônica) é
 * `data/cortes/{slug}/` do repo? Só ela é vista pelo timer do 300
 * (`Diaria-Shorts-Cortes`) e pelo vigia de cortes sem dono
 * (`corte-owner-watch.ts`): em 02/11/2026 um corte rodado de
 * `~/diaria-cortes/...` ficou fora dos dois e o Reels sumiu sem alarme.
 * A comparação é pelo caminho REAL (symlink e `..` resolvidos), nunca pelo texto.
 * Fora dela: recusa, a menos do escape `--allow-unwatched-dir`, que devolve o
 * aviso de que nenhum alarme de destino faltante cobre o corte.
 */
export function checkCorteDir(input: {
  slug: string;
  dir: string;
  /** `data/cortes` do repo. */
  cortesRoot: string;
  allowUnwatched: boolean;
  realpath?: (p: string) => string;
}): CorteDirCheck {
  const real = (p: string) => realpathLenient(p, input.realpath);
  const actual = real(input.dir);
  const canonical = real(join(input.cortesRoot, input.slug));
  if (actual === canonical) return { ok: true, outside: false };
  const dir = resolve(input.dir);
  const where = actual === dir ? dir : `${dir} (caminho real ${actual})`;
  if (!input.allowUnwatched) {
    return {
      ok: false,
      error:
        `a pasta do corte ${where} fica fora de ${corteRelDir(input.slug)}/: o timer do 300 (${CORTE_TIMER_TASK}) e o vigia de cortes sem dono só leem ${CORTES_REL_DIR}/, então nenhum destino que faltar deste corte gera alarme. ` +
        `Mova ou registre o corte em ${corteRelDir(input.slug)}/ (rode sem --edition-dir; o --video pode apontar para o arquivo onde ele estiver). ` +
        `Para rodar mesmo assim, sem alarme, passe --${ALLOW_UNWATCHED_DIR_FLAG} (#11911)`,
    };
  }
  return {
    ok: true,
    outside: true,
    dir,
    warning:
      `corte "${input.slug}" fora de ${CORTES_REL_DIR}/ (${where}) por --${ALLOW_UNWATCHED_DIR_FLAG}: nenhum alarme de destino faltante cobre este corte ` +
      `(o timer ${CORTE_TIMER_TASK} e o vigia de cortes sem dono só leem ${CORTES_REL_DIR}/); confira cada destino à mão (#11911)`,
  };
}

/** Nome do vertical baixado na pasta do corte (`--from-drive` sem `--video`). */
export function corteVideoFileName(slug: string): string {
  return `corte-${slug}.mp4`;
}

/**
 * Como o `video` vai para o `corte.json`: RELATIVO à pasta do corte quando o
 * arquivo está dentro dela (caso `--from-drive`), senão o caminho absoluto.
 * `data/` sincroniza entre as máquinas; um absoluto de uma máquina não existe
 * na outra, então a re-execução dos `owners` cairia em "vídeo curto ausente".
 */
export function corteVideoRef(corteDir: string, absVideo: string): string {
  const rel = relative(corteDir, absVideo);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : absVideo;
}

/** Caminho do vertical a partir do `video` do `corte.json` (relativo = dentro da pasta do corte). */
export function resolveCorteVideo(corteDir: string, video: string): string {
  return isAbsolute(video) ? video : join(corteDir, video);
}

/**
 * Aviso quando o vídeo do corte está fora de `data/` (não sincroniza entre as
 * máquinas): a re-execução em outra máquina não vai achar o arquivo.
 */
export function corteVideoPortabilityWarning(video: string, dataDir: string): string | null {
  if (!isAbsolute(video)) return null;
  const rel = relative(dataDir, video);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return null;
  return `vídeo do corte fora de data/ (${video}): re-execução em outra máquina não acha o arquivo — use --from-drive ou copie o vídeo para a pasta do corte`;
}

/**
 * Chaves do corte no R2. Prefixo próprio (`shorts/cortes/`): nunca o
 * `shorts/diaria-comentada-{AAMMDD}-short.mp4` da edição do dia.
 */
export function corteR2Key(slug: string, kind: "video" | "cover"): string {
  return kind === "video" ? `shorts/cortes/${slug}.mp4` : `shorts/cortes/${slug}-cover.jpg`;
}

/** Horário do corte: explícito, fora do teste de horário do vertical (#10831). */
export function corteShortTime(hhmm: string): ShortTime {
  return { hhmm, source: "explicit", reason: "corte avulso: horário explícito (--at), fora do teste de horário do vertical (#10831, #11795)" };
}

/**
 * Task do 300 que publica os destinos do corte que a API não agenda (#11795,
 * `scripts/shorts-corte-timer.ts`), com `publishing.shorts.corte_via_timer`.
 */
export const CORTE_TIMER_TASK = "Diaria-Shorts-Cortes";

/** Destinos do corte que ficam `pending_schedule` antes do horário: a API deles não agenda. */
export const CORTE_TIMER_DESTINATIONS: readonly string[] = ["linkedin_profile", "threads_profile", "instagram"];

/** Comando base das re-execuções (`owners` do plano): o resto vem do `corte.json`. */
export function corteBaseCommand(slug: string, outsideDir?: string): string {
  // #11911: corte fora de data/cortes/ (--allow-unwatched-dir): a re-execução volta à mesma pasta.
  const outside = outsideDir !== undefined ? ` --edition-dir ${JSON.stringify(outsideDir)} --${ALLOW_UNWATCHED_DIR_FLAG}` : "";
  return `npx tsx scripts/publish-shorts.ts --corte ${slug}${outside}`;
}

/** Título e gancho no formato que os montadores de texto do vertical leem (`{ title, body }`). */
export function corteTextInput(spec: Pick<CorteSpec, "title" | "hook">): { title: string; body: string } {
  return { title: spec.title, body: spec.hook };
}

/** Lê e valida o `corte.json`. Ilegível ou inválido lança (nunca vira "corte novo"). */
export function parseCorteSpec(raw: string, path: string): CorteSpec {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} ilegível: ${(e as Error).message}`);
  }
  const problems = corteSpecProblems(data);
  if (problems.length) throw new Error(`${path} inválido: ${problems.join("; ")}`);
  return data as CorteSpec;
}

function corteSpecProblems(data: unknown): string[] {
  if (!data || typeof data !== "object") return ["não é um objeto"];
  const d = data as Record<string, unknown>;
  const problems: string[] = [];
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const slug = str("slug");
  if (slug === null || validateCorteSlug(slug)) problems.push("slug inválido");
  if (!DATE_RE.test(str("date") ?? "")) problems.push("date precisa ser AAMMDD (--date)");
  if (!HHMM_RE.test(str("hhmm") ?? "")) problems.push("hhmm precisa ser HH:MM (--at)");
  if (!(str("title") ?? "").trim()) problems.push("title vazio (--title)");
  if (!(str("hook") ?? "").trim()) problems.push("hook vazio (--hook)");
  if (!(str("video") ?? "").trim()) problems.push("video vazio (--video ou --from-drive)");
  // #11912: autorização malformada lança (nunca vira "autorizado", nem some em silêncio).
  const iso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  const destList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
  const sha = (v: unknown) => typeof v === "string" && SHA256_RE.test(v);
  const fingerprint = (v: unknown) => {
    const c = v as Record<string, unknown> | null;
    return !!c && typeof c === "object" && sha(c["video_sha256"]) && (c["cover_sha256"] === null || sha(c["cover_sha256"]));
  };
  const at = d["publish_confirmed_at"];
  const dests = d["publish_confirmed_destinations"];
  const content = d["publish_confirmed_content"];
  if ((at === undefined) !== (dests === undefined)) problems.push("publish_confirmed_at e publish_confirmed_destinations andam juntos");
  if (at !== undefined && !iso(at)) problems.push("publish_confirmed_at precisa ser data ISO");
  if (dests !== undefined && !destList(dests)) problems.push("publish_confirmed_destinations precisa ser lista de destinos");
  if (content !== undefined && at === undefined) problems.push("publish_confirmed_content sem publish_confirmed_at");
  if (at !== undefined && !fingerprint(content)) {
    problems.push("publish_confirmed_content obrigatório com a autorização: video_sha256 (sha256 hex) e cover_sha256 (sha256 hex ou null)");
  }
  const revokedAt = d["publish_revoked_at"];
  const revokedDests = d["publish_revoked_destinations"];
  const revokedKind = d["publish_revoked_reason_kind"];
  const revokedContent = d["publish_revoked_content"];
  if ((revokedAt === undefined) !== (revokedDests === undefined) || (revokedAt === undefined) !== (revokedKind === undefined)) {
    problems.push("publish_revoked_at, publish_revoked_destinations e publish_revoked_reason_kind andam juntos");
  }
  if (revokedAt !== undefined && !iso(revokedAt)) problems.push("publish_revoked_at precisa ser data ISO");
  if (revokedDests !== undefined && !destList(revokedDests)) problems.push("publish_revoked_destinations precisa ser lista de destinos");
  if (revokedKind !== undefined && revokedKind !== "plan" && revokedKind !== "content") problems.push('publish_revoked_reason_kind precisa ser "plan" ou "content"');
  if (revokedKind === "plan" && !fingerprint(revokedContent)) problems.push('publish_revoked_content obrigatório com publish_revoked_reason_kind "plan"');
  if (revokedContent !== undefined && revokedKind !== "plan") problems.push('publish_revoked_content só com publish_revoked_reason_kind "plan"');
  // Autorizado e derrubado convivem (destinos diferentes), nunca o mesmo destino nos dois.
  if (destList(dests) && destList(revokedDests)) {
    const both = dests.filter((x) => revokedDests.includes(x));
    if (both.length) problems.push(`destino autorizado e derrubado ao mesmo tempo: ${both.join(", ")}`);
  }
  return problems;
}

/** Flags da CLI que alimentam o `corte.json`. */
export interface CorteFlags {
  date?: string;
  at?: string;
  title?: string;
  hook?: string;
  video?: string;
}

/**
 * Pure: junta o `corte.json` existente com as flags desta rodada (a flag
 * vence). Devolve a spec válida, se ela mudou (pra gravar), ou os problemas.
 * Mudar título, gancho ou horário depois de algum destino registrado só vale
 * para os destinos ainda não publicados: quem chama avisa.
 *
 * #11912: a spec devolvida nunca carrega a autorização (`publish_confirmed_*`).
 * Quando o plano muda (`changed` não vazio) e quem chama grava, a autorização
 * anterior cai junto: o "pode publicar" foi dado sobre o plano antigo. Sem
 * mudança, nada é gravado e a autorização do arquivo continua valendo.
 */
export function mergeCorteSpec(
  slug: string,
  existing: CorteSpec | null,
  flags: CorteFlags,
): { ok: true; spec: CorteSpec; changed: (keyof CorteSpec)[] } | { ok: false; error: string } {
  const slugErr = validateCorteSlug(slug);
  if (slugErr) return { ok: false, error: slugErr };
  if (existing && existing.slug !== slug) return { ok: false, error: `corte.json é do corte "${existing.slug}", não de "${slug}"` };
  const pick = (v: string | undefined) => (v === undefined ? undefined : v.trim());
  const candidate: CorteSpec = {
    slug,
    date: pick(flags.date) ?? existing?.date ?? "",
    hhmm: pick(flags.at) ?? existing?.hhmm ?? "",
    title: pick(flags.title) ?? existing?.title ?? "",
    hook: pick(flags.hook) ?? existing?.hook ?? "",
    video: pick(flags.video) ?? existing?.video ?? "",
  };
  const problems = corteSpecProblems(candidate);
  if (problems.length) {
    return { ok: false, error: `corte "${slug}" incompleto: ${problems.join("; ")}${existing ? "" : " (1ª rodada do corte: passe --date, --at, --title, --hook e --video ou --from-drive)"}` };
  }
  const keys: (keyof CorteSpec)[] = ["date", "hhmm", "title", "hook", "video"];
  const changed = existing ? keys.filter((k) => existing[k] !== candidate[k]) : keys;
  return { ok: true, spec: candidate, changed };
}

/**
 * #11912: destinos que o editor autorizou ("pode publicar") para o corte, ou
 * `null` quando o `corte.json` não tem autorização (só dry-run): aí o timer
 * do 300 não publica nada.
 */
export function corteAuthorizedDestinations(spec: CorteSpec): string[] | null {
  if (!spec.publish_confirmed_at || !spec.publish_confirmed_destinations?.length) return null;
  return spec.publish_confirmed_destinations;
}

/** #11912: destinos cujo "pode publicar" caiu e não voltou (`[]` = nenhum). */
export function corteRevokedDestinations(spec: CorteSpec): string[] {
  return spec.publish_revoked_at ? spec.publish_revoked_destinations ?? [] : [];
}

function withoutRevocation(spec: CorteSpec): CorteSpec {
  const { publish_revoked_at: _a, publish_revoked_destinations: _d, publish_revoked_reason_kind: _k, publish_revoked_content: _c, ...rest } = spec;
  return rest;
}

/**
 * Pure (#11912): grava a autorização do `--publish --confirm-publish` do
 * corte. `only` é a lista CONCRETA de destinos da rodada (o `--only`, ou os
 * destinos da config quando não há `--only`), `content` é a impressão digital
 * do vídeo e da capa que esta rodada publica.
 *
 * Mesmo conteúdo já autorizado: soma destinos (o "pode publicar" anterior,
 * sobre o mesmo plano e o mesmo arquivo, segue valendo); `changed` só quando
 * algo muda. Conteúdo diferente: a autorização antiga não se estende ao
 * arquivo novo, então os destinos são só os desta rodada, e os antigos que
 * ficaram de fora vão para o registro de derrubada (`content`), para o timer
 * alarmar em vez de esquecê-los. Da derrubada anterior saem só os destinos
 * concedidos agora; o registro some quando a lista fica vazia.
 */
export function withCortePublishAuthorization(
  spec: CorteSpec,
  only: readonly string[],
  content: CorteContentFingerprint,
  nowIso: string,
): { spec: CorteSpec; changed: boolean } {
  if (only.length === 0) return { spec, changed: false };
  const current = corteAuthorizedDestinations(spec);
  const sameContent = current !== null && corteContentCheck(spec.publish_confirmed_content, content).kind === "ok";
  const base = sameContent ? current : [];
  const dropped = current && !sameContent ? current.filter((d) => !only.includes(d)) : [];
  const next = [...base, ...only.filter((d) => !base.includes(d))];
  const revokedBefore = corteRevokedDestinations(spec);
  const revokedLeft = [...revokedBefore.filter((d) => !next.includes(d)), ...dropped.filter((d) => !revokedBefore.includes(d))];
  const revokedSame = revokedLeft.length === revokedBefore.length && revokedLeft.every((d) => revokedBefore.includes(d));
  if (sameContent && next.length === base.length && revokedSame) return { spec, changed: false };
  let revocation: Partial<CorteSpec> = {};
  if (revokedLeft.length) {
    // Destino antigo derrubado aqui caiu por conteúdo; misturado com uma queda `plan`, vale o mais restrito.
    const kind: CorteRevocationKind = dropped.length || spec.publish_revoked_reason_kind === "content" ? "content" : "plan";
    revocation = {
      publish_revoked_at: dropped.length ? nowIso : spec.publish_revoked_at ?? nowIso,
      publish_revoked_destinations: revokedLeft,
      publish_revoked_reason_kind: kind,
      ...(kind === "plan" && spec.publish_revoked_content ? { publish_revoked_content: spec.publish_revoked_content } : {}),
    };
  }
  return {
    spec: {
      ...withoutRevocation(spec),
      publish_confirmed_at: nowIso,
      publish_confirmed_destinations: next,
      publish_confirmed_content: { video_sha256: content.video_sha256, cover_sha256: content.cover_sha256 },
      ...revocation,
    },
    changed: true,
  };
}

/**
 * Pure (#11912): derruba a autorização do corte (plano ou conteúdo mudou) e
 * soma os destinos que estavam autorizados ao registro de derrubada
 * (`publish_revoked_*`), para o timer alarmar em vez de pular em silêncio.
 * `publish_revoked_at` vira `nowIso` a cada queda (o alarme `revoked` usa a
 * data para avisar de novo). Queda `plan` guarda a impressão digital aprovada
 * (o restore do `--update-scheduled` confere contra ela); qualquer queda
 * `content`, agora ou antes, torna o registro inteiro `content`. Sem
 * autorização, devolve a spec como está (`revoked: null`).
 */
export function withoutCortePublishAuthorization(
  spec: CorteSpec,
  nowIso: string,
  kind: CorteRevocationKind,
): { spec: CorteSpec; revoked: string[] | null } {
  const current = corteAuthorizedDestinations(spec);
  if (!current) return { spec, revoked: null };
  const { publish_confirmed_at: _a, publish_confirmed_destinations: _d, publish_confirmed_content: approved, ...rest } = spec;
  const prev = corteRevokedDestinations(spec);
  const prevContent = spec.publish_revoked_content;
  const samePrevContent = !prev.length || (spec.publish_revoked_reason_kind === "plan" && !!prevContent && !!approved && corteContentCheck(prevContent, approved).kind === "ok");
  const merged: CorteRevocationKind = kind === "plan" && samePrevContent ? "plan" : "content";
  return {
    spec: {
      ...withoutRevocation(rest),
      publish_revoked_at: nowIso,
      publish_revoked_destinations: [...prev, ...current.filter((d) => !prev.includes(d))],
      publish_revoked_reason_kind: merged,
      ...(merged === "plan" && approved ? { publish_revoked_content: approved } : {}),
    },
    revoked: current,
  };
}

/**
 * Pure (#11912): o conteúdo atual bate com o aprovado? `ok`; `missing` quando
 * o vídeo, ou a capa que foi aprovada, não está nesta máquina (cópia do
 * OneDrive atrasada: alarme, nunca derrubada); `changed` quando o arquivo é
 * outro. `reason` em português, para o alarme e para a recusa do
 * `publish-shorts`.
 */
export type CorteContentCheck = { kind: "ok" } | { kind: "missing" | "changed"; reason: string };

export function corteContentCheck(approved: CorteContentFingerprint | undefined, current: CorteContentFingerprint): CorteContentCheck {
  if (!approved) return { kind: "changed", reason: 'a autorização não tem a impressão digital do vídeo e da capa: dê o "pode publicar" de novo' };
  if (current.video_sha256 === null) return { kind: "missing", reason: "vídeo do corte ausente nesta máquina" };
  if (approved.cover_sha256 !== null && current.cover_sha256 === null) return { kind: "missing", reason: "capa aprovada do corte ausente nesta máquina" };
  const changed: string[] = [];
  if (approved.video_sha256 !== current.video_sha256) changed.push("o vídeo");
  if (approved.cover_sha256 !== current.cover_sha256) changed.push("a capa");
  return changed.length ? { kind: "changed", reason: `${changed.join(" e ")} do corte mudou depois do "pode publicar"` } : { kind: "ok" };
}

/**
 * Pure (#11912): o `--update-scheduled --publish --confirm-publish` do corte
 * pode devolver o "pode publicar"? Só para queda `plan` (título, gancho, data,
 * horário corrigidos: a confirmação desta rodada é sobre o plano novo), só
 * para destinos que a config conhece e, com `--only`, só os dele. Queda
 * `content` exige `--publish --confirm-publish` explícito. O conteúdo atual é
 * conferido por quem chama (`publish_revoked_content`).
 */
export function planCorteAuthorizationRestore(
  spec: CorteSpec,
  only: readonly string[] | null,
  known: ReadonlySet<string>,
): { ok: true; destinations: string[] } | { ok: false; reason: string } {
  const revoked = corteRevokedDestinations(spec);
  if (!revoked.length) return { ok: false, reason: 'nenhum "pode publicar" derrubado a restaurar' };
  if (spec.publish_revoked_reason_kind !== "plan") {
    return { ok: false, reason: 'o "pode publicar" caiu porque o vídeo ou a capa mudou: o --update-scheduled não o devolve; dê o "pode publicar" explícito com --publish --confirm-publish (sem --update-scheduled)' };
  }
  const destinations = revoked.filter((d) => known.has(d) && (!only || only.includes(d)));
  if (!destinations.length) return { ok: false, reason: `nenhum destino derrubado (${revoked.join(", ")}) está na config atual${only ? " e no --only desta rodada" : ""}` };
  return { ok: true, destinations };
}
