/**
 * reserved-destaques.ts (#13331) — destaque pronto reservado para OUTRA edição.
 *
 * Caso de origem (gate 4 da 261117): o editor pediu "mover 'Brasil vai
 * precisar de licença dos EUA para chips' para ser o D1 de 261118". Não havia
 * comando para isso; o único pedido de destaque que o pipeline entende é o
 * e-mail ao inbox com "d1" (`editor_destaque_request`, #12193).
 *
 * Mecanismo, em duas pontas:
 *   1. `scripts/reserve-destaque.ts` copia o pacote do destaque (texto,
 *      social, imagens, fontes) para `_internal/reserved-destaques/` da edição
 *      de destino (criando a pasta se ela ainda não existe) e grava a reserva
 *      em `_internal/reserved-destaques.json` dela.
 *   2. `scripts/inject-inbox-urls.ts` (Stage 1, passo 1h, o mesmo que injeta
 *      os pedidos do inbox) lê esse arquivo e injeta cada reserva no pool
 *      (`tmp-articles-raw.json`) com `editor_destaque_request` = posição
 *      pedida. A reserva não pode ir direto no pool: o 1g-ter
 *      (`assemble-research-pool.ts`) recria `tmp-articles-raw.json` do zero.
 *      Daí em diante vale o caminho do #12193: o invariante
 *      `editor-destaque-request` avisa no gate 4 se o link não saiu na
 *      posição pedida.
 *
 * Funções puras + leitura do arquivo de reservas. Sem escrita aqui: quem
 * grava é o CLI.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";
import { DESTAQUE_REQUEST_FIELD } from "./destaque-upgrade.ts";

/** Arquivo de reservas, dentro de `{edição}/_internal/`. */
export const RESERVED_DESTAQUES_FILE = "reserved-destaques.json";

/** Pasta dos pacotes copiados, dentro de `{edição}/_internal/`. */
export const RESERVED_PACKAGES_DIR = "reserved-destaques";

export type DestaqueSlot = "d1" | "d2" | "d3";

export interface ReservedDestaque {
  url: string;
  title: string;
  /** Posição pedida na edição de destino. */
  request: DestaqueSlot;
  /** Edição de origem (AAMMDD). */
  from_edition: string;
  /** Posição do destaque na edição de origem. */
  from_destaque: DestaqueSlot;
  /** Pasta do pacote, relativa à pasta da edição de destino. */
  package_dir: string;
  reserved_at: string;
  category?: string;
}

/** `"d2"`, `"D2"` ou `"2"` → `"d2"`; `null` fora de 1..3. */
export function parseDestaqueSlot(value: string | undefined): DestaqueSlot | null {
  if (!value) return null;
  const m = /^d?([123])$/i.exec(value.trim());
  return m ? (`d${m[1]}` as DestaqueSlot) : null;
}

function isReservation(x: unknown): x is ReservedDestaque {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.url === "string" &&
    r.url.length > 0 &&
    typeof r.request === "string" &&
    parseDestaqueSlot(r.request) !== null
  );
}

/**
 * Lê `{internalDir}/reserved-destaques.json`. Ausente → `[]`. JSON ilegível ou
 * fora do formato → lança: reserva perdida em silêncio é exatamente a falha
 * que o #13331 existe para evitar (o pedido do editor some e ninguém avisa).
 */
export function readReservedDestaques(internalDir: string): ReservedDestaque[] {
  const path = resolve(internalDir, RESERVED_DESTAQUES_FILE);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: JSON ilegível (${(e as Error).message}). Corrija ou apague a reserva (#13331).`);
  }
  const list = (parsed as { reservations?: unknown } | null)?.reservations;
  if (!Array.isArray(list)) {
    throw new Error(`${path}: esperado { "reservations": [...] } (#13331).`);
  }
  const bad = list.filter((r) => !isReservation(r));
  if (bad.length > 0) {
    throw new Error(`${path}: ${bad.length} reserva(s) sem url/request válidos (#13331).`);
  }
  return list as ReservedDestaque[];
}

/**
 * Pure: acrescenta (ou substitui) a reserva. Mesma URL canônica = mesma
 * reserva; a nova vence (o editor mudou de ideia sobre a posição). Não muta.
 */
export function upsertReservation(
  list: ReservedDestaque[],
  entry: ReservedDestaque,
): ReservedDestaque[] {
  const canon = canonicalize(entry.url);
  return [...list.filter((r) => canonicalize(r.url) !== canon), entry];
}

/**
 * Pure: reservas que pedem a mesma posição que `entry`, com outra URL. Dois
 * pedidos de D1 para a mesma edição não se resolvem sozinhos; o CLI recusa.
 */
export function findSlotConflicts(
  list: ReservedDestaque[],
  entry: Pick<ReservedDestaque, "url" | "request">,
): ReservedDestaque[] {
  const canon = canonicalize(entry.url);
  return list.filter((r) => r.request === entry.request && canonicalize(r.url) !== canon);
}

/** Artigo injetado no pool. Compatível com `SyntheticInboxArticle`. */
export interface ReservedPoolArticle {
  url: string;
  source: string;
  title: string;
  flag: "editor_submitted";
  submitted_at: string;
  submitted_via: string;
  editor_destaque_request: DestaqueSlot;
  reserved_from: string;
}

/** Pure: reserva → artigo do pool com o pedido de destaque. */
export function reservationToPoolArticle(r: ReservedDestaque): ReservedPoolArticle {
  return {
    url: canonicalize(r.url),
    source: "reserva",
    title: r.title || "(reserva)",
    flag: "editor_submitted",
    submitted_at: r.reserved_at,
    submitted_via: "reserve-destaque",
    [DESTAQUE_REQUEST_FIELD]: parseDestaqueSlot(r.request) as DestaqueSlot,
    reserved_from: `${r.from_edition}/${r.from_destaque}`,
  };
}

/**
 * Pure: junta as reservas à lista de artigos injetados do inbox. URL que o
 * inbox também trouxe não duplica: o pedido da reserva vai para o artigo do
 * inbox (sobrescreve, porque a reserva foi feita com a edição e a posição
 * explícitas, e o e-mail pode ser genérico). Não muta a entrada.
 */
export function mergeReservationsIntoInjected<T extends { url: string }>(
  injected: T[],
  reservations: ReservedDestaque[],
): { injected: Array<T | ReservedPoolArticle>; added: number; annotated: number } {
  const out: Array<T | ReservedPoolArticle> = injected.slice();
  const indexByCanon = new Map<string, number>();
  out.forEach((a, i) => {
    const key = canonicalize(a.url);
    if (!indexByCanon.has(key)) indexByCanon.set(key, i);
  });
  let added = 0;
  let annotated = 0;
  for (const r of reservations) {
    const art = reservationToPoolArticle(r);
    const key = canonicalize(art.url);
    const idx = indexByCanon.get(key);
    if (idx === undefined) {
      indexByCanon.set(key, out.length);
      out.push(art);
      added++;
      continue;
    }
    out[idx] = {
      ...out[idx],
      [DESTAQUE_REQUEST_FIELD]: art.editor_destaque_request,
      reserved_from: art.reserved_from,
    };
    annotated++;
  }
  return { injected: out, added, annotated };
}

/**
 * Pure: o bloco `DESTAQUE N | ...` cru de `02-reviewed.md` (do cabeçalho até
 * o `---` seguinte), ou `null`. Mesmo recorte de `parseDestaques`.
 */
export function extractRawDestaqueBlock(reviewedMd: string, n: 1 | 2 | 3): string | null {
  const sections = reviewedMd.replace(/\r\n/g, "\n").split(/^---$/m);
  const header = new RegExp(`^(?:\\*\\*)?DESTAQUE\\s+${n}\\s*\\|`, "m");
  for (const s of sections) {
    if (header.test(s)) return s.trim() + "\n";
  }
  return null;
}

/**
 * Pure: os blocos `## dN` e `## dN-cards` de cada seção `# ...` de
 * `03-social.md`, remontados com os cabeçalhos. `null` se nenhum existe.
 */
export function extractSocialPackage(socialMd: string, slot: DestaqueSlot): string | null {
  const normalized = socialMd.replace(/\r\n/g, "\n");
  const parts: string[] = [];
  const sectionRe = /(?:^|\n)# ([^\n]+)\n([\s\S]*?)(?=\n# |$)/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(normalized)) !== null) {
    const title = m[1].trim();
    const body = m[2];
    const blocks: string[] = [];
    for (const id of [slot, `${slot}-cards`]) {
      const re = new RegExp(`(?:^|\\n)## ${id}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "i");
      const b = body.match(re);
      if (b && b[1].trim()) blocks.push(`## ${id}\n${b[1].trim()}\n`);
    }
    if (blocks.length > 0) parts.push(`# ${title}\n\n${blocks.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Pure: arquivo da edição que pertence ao destaque (`04-d2-2x1.jpg`, `04-d2-sd-prompt.json`...). */
export function isDestaqueAssetName(name: string, slot: DestaqueSlot): boolean {
  return new RegExp(`^04-${slot}([-.]|$)`, "i").test(name);
}
