/**
 * annual-social-plan.ts — Etapa 6 da `/diaria-anual` (posts em mídias sociais).
 *
 * Cada tema da retrospectiva (N variável, 3–7) e as previsões viram um post
 * nas mesmas redes da diária. Os publicadores da diária (`publish-linkedin.ts`,
 * `publish-facebook.ts`, `publish-instagram.ts`, `publish-threads.ts`,
 * `prep-twitter-posts.ts`) trabalham sobre um diretório de EDIÇÃO com 2–3
 * destaques (`## d1..d3`) e datam o post pelo AAMMDD do nome do diretório.
 * Em vez de ensinar a anual a cada publicador, este módulo reparte os posts em
 * DIAS de 2–3 posts e monta, para cada dia, um diretório com a mesma forma de
 * uma edição diária — aí os publicadores rodam sem modificação.
 *
 * Puro, sem I/O. O CLI é `scripts/prep-annual-social.ts`.
 */

/** Chave da seção em `social/03-social.md`: `t1..tN` (temas) e `previsoes`. */
export type AnnualSocialKey = `t${number}` | "previsoes";

export interface AnnualSocialTexts {
  /** `# Social` — texto único de LinkedIn/Facebook/Instagram (carrossel). */
  social: Record<string, string>;
  /** `# Curto` — X e Threads (≤280). */
  curto: Record<string, string>;
  /** `# Pixel` → `## post_pixel` — post pessoal no LinkedIn do editor (manual). */
  pixel?: string;
  /**
   * `# Capas` (opcional) — título da capa por post. Sem ele a capa usa o
   * título do tema no draft. Existe porque o título do tema é escrito para a
   * edição, e na capa solta no feed o post precisa se ligar à série ("Em um
   * ano, …") — decisão do editor, 12/09/2026.
   */
  capas: Record<string, string>;
}

export interface AnnualSocialDay {
  /** AAMMDD — nome do diretório (data do 1º post do lote). */
  date: string;
  keys: AnnualSocialKey[];
  /**
   * Data e hora de cada post do lote (`d1..d3` → `AAAA-MM-DDTHH:MM`, fuso da
   * config social). Vai para `_internal/social-slots.json`, lido pelos
   * publicadores via `DIARIA_SOCIAL_SLOTS_FILE` (`compute-social-schedule.ts`).
   */
  slots: Record<string, string>;
}

/** Quebra um markdown em `{ "## chave": corpo }` (corpo sem as bordas em branco). */
function sections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of md.split(/^## /m).slice(1)) {
    const [head, ...rest] = block.split(/\r?\n/);
    out[head.trim()] = rest.join("\n").trim();
  }
  return out;
}

/**
 * Lê `social/03-social.md` da anual: blocos `# Social`, `# Curto` e,
 * opcional, `# Pixel`. Lança se faltar texto curto para algum post — sem ele
 * X e Threads ficariam sem post daquele tema, em silêncio.
 */
export function parseAnnualSocialMd(md: string): AnnualSocialTexts {
  const parts = md.split(/^# (Social|Curto|Pixel|Capas)\s*$/m);
  const byName: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) byName[parts[i]] = parts[i + 1] ?? "";
  const social = sections(byName.Social ?? "");
  const curto = sections(byName.Curto ?? "");
  if (Object.keys(social).length === 0) throw new Error("03-social.md sem posts em `# Social`");
  const semCurto = Object.keys(social).filter((k) => !curto[k]);
  if (semCurto.length) throw new Error(`sem texto em \`# Curto\` para: ${semCurto.join(", ")}`);
  const pixel = sections(byName.Pixel ?? "").post_pixel;
  const capas = sections(byName.Capas ?? "");
  const capaSobrando = Object.keys(capas).filter((k) => !social[k]);
  if (capaSobrando.length) throw new Error(`capa sem post correspondente em \`# Social\`: ${capaSobrando.join(", ")}`);
  return { social, curto, capas, ...(pixel ? { pixel } : {}) };
}

/**
 * `_internal/social-cover.json` do lote: por destaque, a linha da série que a
 * capa leva acima do título. A capa de série sai sem data (decisão do editor,
 * 12/09/2026). `total` = número de temas (as previsões não contam).
 */
export function buildDayCoverJson(day: AnnualSocialDay, total: number, serie = "Retrospectiva de 1 ano"): string {
  const out: Record<string, { kicker: string }> = {};
  day.keys.forEach((k, i) => {
    const parte = k === "previsoes" ? "previsões" : `tema ${k.slice(1)} de ${total}`;
    out[`d${i + 1}`] = { kicker: `${serie} · ${parte}` };
  });
  return JSON.stringify(out, null, 2);
}

/** Ordem de publicação: temas em ordem numérica, previsões por último. */
export function orderAnnualSocialKeys(keys: string[]): AnnualSocialKey[] {
  const temas = keys
    .filter((k) => /^t\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) as AnnualSocialKey[];
  const desconhecidas = keys.filter((k) => !/^t\d+$/.test(k) && k !== "previsoes");
  if (desconhecidas.length) throw new Error(`seção desconhecida em \`# Social\`: ${desconhecidas.join(", ")}`);
  return keys.includes("previsoes") ? [...temas, "previsoes"] : temas;
}

function toAAMMDD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function parseAAMMDD(s: string): Date {
  if (!/^\d{6}$/.test(s)) throw new Error(`data inválida "${s}" — use AAMMDD`);
  const d = new Date(Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6))));
  if (toAAMMDD(d) !== s) throw new Error(`data inexistente "${s}"`);
  return d;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Um post por dia, todos no mesmo horário, a partir de `start` (inclusive) —
 * decisão do editor (12/09/2026): a série sai em dias seguidos, na ordem dos
 * temas, com as previsões no último dia, sempre às `time` (default 09:00,
 * antes da grade da diária: 10:00 / 12:30 / 17:30).
 *
 * Os publicadores da diária só aceitam diretório com 2 ou 3 destaques
 * (`readDestaqueCount`), então os posts são agrupados em LOTES de 2–3
 * (equilibrados, os maiores primeiro: 7 → 3/2/2). O lote é só a unidade de
 * arquivo; a data de cada post vem de `slots`, um dia por post.
 */
export function planAnnualSocialDays(keys: AnnualSocialKey[], start: Date, time = "09:00"): AnnualSocialDay[] {
  if (keys.length < 2) throw new Error(`${keys.length} post(s) — cada lote precisa de 2 ou 3`);
  if (!HHMM.test(time)) throw new Error(`horário inválido "${time}" — use HH:MM`);
  const nLotes = Math.ceil(keys.length / 3);
  const base = Math.floor(keys.length / nLotes);
  const extra = keys.length % nLotes;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lotes: AnnualSocialDay[] = [];
  const d = new Date(start.getTime());
  let i = 0;
  for (let n = 0; n < nLotes; n++) {
    const size = base + (n < extra ? 1 : 0);
    const lote: AnnualSocialDay = { date: toAAMMDD(d), keys: keys.slice(i, i + size), slots: {} };
    for (let j = 0; j < size; j++) {
      lote.slots[`d${j + 1}`] = `${iso(d)}T${time}`;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    lotes.push(lote);
    i += size;
  }
  return lotes;
}

/**
 * Nome do arquivo 2:1 do tema `index`, a partir do `_internal/public-images.json`
 * da anual (`URL → arquivo`). O índice do TEMA vem da URL (`-04-d{N}-2x1-`), não
 * do nome do arquivo: quando o editor reordena os temas no gate, o arquivo
 * `04-dN` deixa de bater com o tema N, e é a URL que o e-mail já usa.
 */
export function themeImageFile(publicImages: Record<string, string>, index: number): string | null {
  for (const [url, file] of Object.entries(publicImages)) {
    const m = url.match(/-04-d(\d+)-2x1-/);
    if (m && Number(m[1]) === index) return file;
  }
  return null;
}

/**
 * `02-reviewed.md` mínimo do dia — só o que `gen-social-card-4x5.ts` lê (título
 * e categoria de cada destaque, na forma `**DESTAQUE N | CATEGORIA**`).
 */
export function buildDayReviewedMd(titles: string[], category = "RETROSPECTIVA DE ANIVERSÁRIO"): string {
  return titles.map((t, i) => `**DESTAQUE ${i + 1} | ${category}**\n\n${t}\n`).join("\n---\n\n");
}

/**
 * Categoria da capa: só a rodada de agosto é "de aniversário" — a de janeiro
 * cobre o ano civil e não leva esse enquadramento.
 */
export function socialCardCategory(tipo: "aniversario" | "janeiro", ano: string): string {
  return tipo === "aniversario" ? "RETROSPECTIVA DE ANIVERSÁRIO" : `RETROSPECTIVA ${ano}`;
}

/**
 * `_internal/01-approved-capped.json` mínimo do dia. Os scripts da diária o
 * leem para duas coisas, e sem ele quebram: `readDestaqueCount` assume 3
 * destaques (num dia de 2 posts, `upload-images-public.ts` aborta por falta
 * da imagem do d3) e `publish-linkedin.ts` aborta sem `outros_count`. Aqui
 * `highlights` tem um item por post e os demais baldes ficam vazios.
 */
export function buildDayApprovedStub(titles: string[]): string {
  return JSON.stringify(
    { highlights: titles.map((title) => ({ title })), lancamento: [], radar: [], use_melhor: [], video: [] },
    null,
    2,
  );
}

/** `03-social.md` do dia, com as chaves renumeradas para `d1..d3`. */
export function buildDaySocialMd(day: AnnualSocialDay, texts: AnnualSocialTexts): string {
  const block = (src: Record<string, string>) => day.keys.map((k, i) => `## d${i + 1}\n${src[k]}\n`).join("\n");
  return `# Social\n\n${block(texts.social)}\n# Curto\n\n${block(texts.curto)}`;
}
