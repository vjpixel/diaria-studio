/**
 * check-dedup-freshness.ts
 *
 * Pre-flight de Stage 0: valida que `data/past-editions-raw.json` está fresh
 * o suficiente pra base de dedup ser confiável.
 *
 * Compara `max(published_at)` no raw com `Date.now() - <maxStalenessHours>`.
 * Se o raw está stale, o script falha loud (exit 1) — orchestrator deve
 * apresentar ao editor antes de prosseguir, em vez de aprovar links repetidos
 * com base congelada.
 *
 * Caso real (#230): edição 260428 com `data/past-editions-raw.json` carregando
 * só 5 edições de 14-23/abril enquanto Beehiiv tinha posts de 04-25 e 04-27.
 * Destaque GPT-5.5 do gate batia com edição 04-25 — dedup não pegou. Editor
 * só notou no review manual.
 *
 * **2º critério, independente de calendário (#8142).** O critério de idade
 * acima é FROUXO de propósito (48-96h conforme dia da semana, #675) e por
 * isso não distingue "não publicamos há dias" de "publicamos todo dia e a
 * base não enxerga". Caso real: `read_backend` continuou `"beehiiv"` depois
 * do ENVIO migrar pro Kit (#7388, 04/09/2026) — a Beehiiv nunca mais recebeu
 * post, `refresh-dedup.ts` saía com `new_posts: 0`/exit 0 (sem erro — a
 * FONTE que parou, não o fetch) e o critério de idade sozinho não bate
 * alarme (a Beehiiv continua existindo como arquivo público congelado, então
 * "publicado há Nh" mede a idade do post ERRADO). `evaluateLocalEditionsUnseen`
 * cobre isso: varre `data/editions/{AAMMDD}/` por marcador de envio local
 * (`_internal/05-published.json` — backend Beehiiv, ou
 * `_internal/newsletter-kit-published.json` — backend Kit) e compara a data
 * da edição contra `most_recent` do raw. Detalhe crítico: um marcador com
 * `scheduled_at` no FUTURO não conta — a edição do dia seguinte já tem o
 * dela gravado na véspera (`stage-6-run.ts` agenda 24h+ à frente); sem esse
 * cuidado o guard abortaria toda noite por causa da PRÓPRIA edição do dia
 * seguinte.
 *
 * Uso pelo orchestrator no Stage 0, **após** o `refresh-dedup-runner`:
 *
 *   npx tsx scripts/check-dedup-freshness.ts
 *
 * Flags opcionais:
 *   --max-staleness-hours <N>   default 48 (cobertura de fim de semana)
 *   --raw <path>                default data/past-editions-raw.json
 *   --now <ISO>                 override pra teste/CI; default Date.now()
 *   --editions-root <path>      default data/editions (override pra teste)
 *
 * Output (stdout, JSON):
 *   { "ok": true,  "most_recent": "2026-04-27T...", "age_hours": 12.3, ... }
 *   { "ok": false, "most_recent": "2026-04-23T...", "age_hours": 96.7, ... }
 *   { "ok": false, ..., "local_editions_unseen": ["260904", "260908"], ... }
 *
 * Exit codes:
 *   0 = fresh (ou base vazia + bootstrap pendente, decidido pelo caller)
 *   1 = stale por idade E/OU por edição local não vista pela base
 *       (orchestrator: pedir ao editor pra investigar antes de prosseguir)
 *   2 = erro (raw não existe, args inválidos, JSON corrompido)
 *
 * Refs #230, #675, #8142.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";

export interface FreshnessResult {
  ok: boolean;
  raw_path: string;
  count: number;
  most_recent: string | null;
  age_hours: number | null;
  max_staleness_hours: number;
  reason?: string;
  /** #8142 — quantas edições locais com marcador de envio (não-futuro) foram checadas. */
  local_editions_checked?: number;
  /** #8142 — AAMMDDs com marcador de envio local que a base não enxerga (ordenado asc). */
  local_editions_unseen?: string[];
}

interface RawPost {
  id?: string;
  title?: string;
  published_at?: string;
}

/**
 * Pure: avalia freshness dado um array de posts e ts atual. Não toca filesystem.
 */
export function evaluateFreshness(
  posts: RawPost[],
  nowMs: number,
  maxStalenessHours: number,
  rawPath = "data/past-editions-raw.json",
): FreshnessResult {
  if (posts.length === 0) {
    return {
      ok: false,
      raw_path: rawPath,
      count: 0,
      most_recent: null,
      age_hours: null,
      max_staleness_hours: maxStalenessHours,
      reason: "raw vazio — bootstrap nunca rodou ou falhou",
    };
  }

  let maxMs = -Infinity;
  let maxIso: string | null = null;
  for (const p of posts) {
    const iso = p.published_at;
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = iso;
    }
  }

  if (maxIso === null) {
    return {
      ok: false,
      raw_path: rawPath,
      count: posts.length,
      most_recent: null,
      age_hours: null,
      max_staleness_hours: maxStalenessHours,
      reason: "nenhuma entrada com published_at parseável",
    };
  }

  const ageMs = nowMs - maxMs;
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageHoursRounded = Math.round(ageHours * 10) / 10;

  // Guarda contra `published_at` no futuro (#241): clock skew, dados de teste
  // ou parsing quebrado podem produzir idade negativa. Tratar como anomalia
  // — escolha do issue: failhar loud, deixar editor decidir.
  if (ageHours < 0) {
    return {
      ok: false,
      raw_path: rawPath,
      count: posts.length,
      most_recent: maxIso,
      age_hours: ageHoursRounded,
      max_staleness_hours: maxStalenessHours,
      reason: `edição mais recente tem published_at no futuro (${maxIso}, ${Math.abs(ageHours).toFixed(1)}h à frente do agora) — verificar clock skew, dados de teste no raw, ou parsing quebrado`,
    };
  }

  const ok = ageHours <= maxStalenessHours;
  return {
    ok,
    raw_path: rawPath,
    count: posts.length,
    most_recent: maxIso,
    age_hours: ageHoursRounded,
    max_staleness_hours: maxStalenessHours,
    reason: ok
      ? undefined
      : `edição mais recente publicada há ${ageHours.toFixed(1)}h (limite ${maxStalenessHours}h) — scripts/refresh-dedup.ts pode ter falhado silenciosamente; investigar antes de prosseguir`,
  };
}

// ── critério 2: edições locais que a base não enxerga (#8142) ─────────────

/**
 * Converte AAMMDD pra "YYYY-MM-DD" (assume século 20xx — mesma convenção do
 * resto do repo, ex: `editionDir()`). Pura, sem I/O. Lança em input malformado
 * (mesmo padrão de `editionDir()` em `scripts/lib/edition-paths.ts`).
 */
export function aammddToIsoDate(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) {
    throw new Error(
      `aammddToIsoDate: AAMMDD inválido: ${JSON.stringify(aammdd)} (esperado exatamente 6 dígitos)`,
    );
  }
  const yy = aammdd.slice(0, 2);
  const mm = aammdd.slice(2, 4);
  const dd = aammdd.slice(4, 6);
  return `20${yy}-${mm}-${dd}`;
}

/** Shape mínimo comum a `_internal/05-published.json` (Beehiiv) e
 * `_internal/newsletter-kit-published.json` (Kit) — só os campos usados
 * pela classificação abaixo. */
export interface LocalPublishMarker {
  status?: string | null;
  scheduled_at?: string | null;
  published_at?: string | null;
}

/**
 * Pura: decide se um marcador de publicação local representa um envio que
 * a base de dedup JÁ DEVERIA enxergar (`true`) ou um agendamento futuro que
 * ainda não conta (`false`) — a edição de amanhã já tem `_internal/05-published.json`/
 * `newsletter-kit-published.json` gravado na véspera com `scheduled_at` no
 * futuro (Stage 6 agenda 24h+ à frente); contar isso faria o guard abortar
 * toda noite (#8142).
 *
 * Regra: `published_at` presente conta sempre (já saiu). Sem `published_at`,
 * `scheduled_at` no futuro NÃO conta; `scheduled_at` no passado/presente ou
 * ausente conta (draft/test_sent local, sem agendamento pendente).
 */
export function isLocalMarkerAlreadyDue(
  marker: LocalPublishMarker,
  nowMs: number,
): boolean {
  if (typeof marker.published_at === "string" && marker.published_at.length > 0) {
    return true;
  }
  if (typeof marker.scheduled_at === "string" && marker.scheduled_at.length > 0) {
    const ms = Date.parse(marker.scheduled_at);
    if (!Number.isNaN(ms)) {
      return ms <= nowMs;
    }
  }
  return true;
}

export interface LocalEditionMarker {
  aammdd: string;
  marker: LocalPublishMarker;
}

/**
 * Pura: dado os marcadores de envio local já lidos do disco + o
 * `most_recent` (ISO) do raw de dedup, retorna quais AAMMDDs "devidos"
 * (`isLocalMarkerAlreadyDue`) a base NÃO enxerga — comparando a data da
 * edição (derivada do AAMMDD) contra a data do post mais recente no raw.
 * Não toca filesystem.
 */
export function evaluateLocalEditionsUnseen(
  markers: LocalEditionMarker[],
  rawMostRecentIso: string | null,
  nowMs: number,
): { checked: number; unseen: string[] } {
  const rawMostRecentDate = rawMostRecentIso
    ? rawMostRecentIso.slice(0, 10)
    : null;
  const unseen: string[] = [];
  let checked = 0;
  for (const { aammdd, marker } of markers) {
    if (!isLocalMarkerAlreadyDue(marker, nowMs)) continue;
    checked++;
    const editionDate = aammddToIsoDate(aammdd);
    if (rawMostRecentDate === null || editionDate > rawMostRecentDate) {
      unseen.push(aammdd);
    }
  }
  unseen.sort();
  return { checked, unseen };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * I/O: varre `editionsRootAbs` (`data/editions`, layout flat OU nested por
 * mês — via `enumerateEditionDirs`) por marcadores de envio local, um por
 * edição. Prefere `_internal/`, com fallback pra raiz (mesma convenção de
 * `edition-paths.ts`). Fail-soft: edição sem NENHUM dos dois marcadores é
 * ignorada (Stage 5 ainda não rodou ali, ou não é uma edição diária).
 */
export function collectLocalEditionMarkers(
  editionsRootAbs: string,
): LocalEditionMarker[] {
  const dirs = enumerateEditionDirs(editionsRootAbs);
  const out: LocalEditionMarker[] = [];
  for (const [aammdd, dirPath] of dirs) {
    const candidates = [
      join(dirPath, "_internal", "05-published.json"),
      join(dirPath, "05-published.json"),
      join(dirPath, "_internal", "newsletter-kit-published.json"),
      join(dirPath, "newsletter-kit-published.json"),
    ];
    let marker: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      marker = readJsonObject(candidate);
      if (marker) break;
    }
    if (!marker) continue;
    out.push({
      aammdd,
      marker: {
        status: typeof marker.status === "string" ? marker.status : null,
        scheduled_at:
          typeof marker.scheduled_at === "string" ? marker.scheduled_at : null,
        published_at:
          typeof marker.published_at === "string" ? marker.published_at : null,
      },
    });
  }
  return out;
}

/**
 * Emite um FreshnessResult em formato JSON pra stdout (#240).
 * Centraliza pra todos os paths de erro emitirem o mesmo schema —
 * orchestrator pode `JSON.parse(stdout)` em qualquer exit code.
 */
function emitJson(
  rawPath: string,
  maxStalenessHours: number,
  reason: string,
): void {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        raw_path: rawPath,
        count: 0,
        most_recent: null,
        age_hours: null,
        max_staleness_hours: maxStalenessHours,
        reason,
      } satisfies FreshnessResult,
      null,
      2,
    ) + "\n",
  );
}

interface CliFlags {
  maxStalenessHours: number;
  rawPath: string;
  now?: string;
  editionsRoot: string;
}

/**
 * Default dinâmico baseado no dia da semana (#675).
 * Segunda: 96h (cobre até a sexta anterior); Terça: 72h; demais: 48h.
 * Evita alarme falso toda segunda-feira quando a newsletter não publica no fim de semana.
 */
export function defaultMaxStalenessHours(now: Date = new Date()): number {
  const dow = now.getUTCDay(); // 0=Dom, 1=Seg, 2=Ter
  if (dow === 1) return 96;
  if (dow === 2) return 72;
  return 48;
}

export function parseArgs(argv: string[]): CliFlags | { error: string } {
  let maxStalenessHours = defaultMaxStalenessHours();
  let rawPath = "data/past-editions-raw.json";
  let now: string | undefined;
  let editionsRoot = "data/editions";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-staleness-hours" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `--max-staleness-hours inválido: ${argv[i + 1]}` };
      }
      maxStalenessHours = n;
      i++;
    } else if (a === "--raw" && argv[i + 1]) {
      rawPath = argv[i + 1];
      i++;
    } else if (a === "--now" && argv[i + 1]) {
      now = argv[i + 1];
      i++;
    } else if (a === "--editions-root" && argv[i + 1]) {
      editionsRoot = argv[i + 1];
      i++;
    }
  }
  return { maxStalenessHours, rawPath, now, editionsRoot };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Defaults conservadores pra error paths que disparam antes do parse.
  const fallbackRaw = "data/past-editions-raw.json";
  const fallbackHours = 48;

  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    emitJson(fallbackRaw, fallbackHours, parsed.error);
    process.exit(2);
  }

  const rawAbs = resolve(ROOT, parsed.rawPath);
  if (!existsSync(rawAbs)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw não existe em ${parsed.rawPath} — rodar npx tsx scripts/refresh-dedup.ts (bootstrap) antes`,
    );
    process.exit(1);
  }

  let posts: RawPost[];
  try {
    posts = JSON.parse(readFileSync(rawAbs, "utf8")) as RawPost[];
  } catch (e) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw inválido (JSON parse falhou): ${(e as Error).message}`,
    );
    process.exit(2);
  }
  if (!Array.isArray(posts!)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw em formato inesperado: esperado array, recebido ${typeof posts}`,
    );
    process.exit(2);
  }

  const nowMs = parsed.now ? Date.parse(parsed.now) : Date.now();
  if (Number.isNaN(nowMs)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `--now inválido: ${parsed.now}`,
    );
    process.exit(2);
  }

  const result = evaluateFreshness(
    posts!,
    nowMs,
    parsed.maxStalenessHours,
    parsed.rawPath,
  );

  // Critério 2 (#8142): sempre roda, mesmo se o critério de idade já falhou
  // — o objeto final reporta os dois motivos possíveis de stale.
  const editionsRootAbs = resolve(ROOT, parsed.editionsRoot);
  const localMarkers = collectLocalEditionMarkers(editionsRootAbs);
  const localCheck = evaluateLocalEditionsUnseen(
    localMarkers,
    result.most_recent,
    nowMs,
  );

  const combined: FreshnessResult = {
    ...result,
    local_editions_checked: localCheck.checked,
    local_editions_unseen: localCheck.unseen,
  };

  if (localCheck.unseen.length > 0) {
    combined.ok = false;
    const localReason = `${localCheck.unseen.length} edição(ões) com marcador de envio local (05-published.json/newsletter-kit-published.json) não vista(s) por ${parsed.rawPath}: ${localCheck.unseen.join(", ")} — publishing.newsletter.read_backend pode estar apontando pro backend errado, ou refresh-dedup.ts pode ter falhado silenciosamente (#8142)`;
    combined.reason = combined.reason ? `${combined.reason} | ${localReason}` : localReason;
  }

  process.stdout.write(JSON.stringify(combined, null, 2) + "\n");
  process.exit(combined.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main();
}
