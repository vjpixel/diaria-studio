/**
 * #13314: links citados em 2+ newsletters DISTINTAS, para o gate 4 (informativo, nunca bloqueia).
 * "Distinta" = mesmo critério do bônus (#9365): remetente (e-mail do From, minúsculo); duas
 * edições da mesma newsletter contam 1. Só a mesma URL normalizada (`joinKey`) agrupa.
 */
import { senderKey } from "./newsletter-senders.ts";

export interface MultiCitedInput { url: string; title: string; score: number | null; newsletter: string; destino: string }
export interface MultiCitedLink {
  url: string; title: string; score: number | null; destino: string;
  /** Nº de newsletters distintas (== `newsletters.length`). */
  count: number;
  /** Nomes de exibição, ordem alfabética. */
  newsletters: string[];
}

/** Nome de exibição do `From`: `Nome <e-mail>` → `Nome`; sem nome, o próprio e-mail. */
export function senderDisplayName(sender: string): string {
  const name = sender.replace(/<[^>]*>/, "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
  return name || senderKey(sender);
}

const cell = (value: unknown) => String(value).replace(/[\r\n|]/g, " ");

/** `keyOf` = chave de junção da URL (`joinKey` do audit). Ordem: nº desc, score desc, URL. */
export function buildMultiCited(links: MultiCitedInput[], keyOf: (url: string) => string): MultiCitedLink[] {
  const groups = new Map<string, {link: MultiCitedInput; senders: Map<string, string>}>();
  for (const l of links) {
    const key = keyOf(l.url);
    const group = groups.get(key) ?? {link: l, senders: new Map<string, string>()};
    // A linha com score/título preenchidos representa o grupo; "destaque" não é rebaixado por outra linha.
    if (group.link.score === null && l.score !== null) group.link = l;
    group.senders.set(senderKey(l.newsletter), senderDisplayName(l.newsletter));
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.senders.size >= 2)
    .map(({link, senders}) => ({url: link.url, title: link.title, score: link.score, destino: link.destino,
      count: senders.size, newsletters: [...senders.values()].sort((a, b) => a.localeCompare(b))}))
    .sort((a, b) => b.count - a.count || (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.url.localeCompare(b.url));
}

/** Seção markdown do topo de `newsletter-intake-gate.md`. */
export function renderMultiCitedSection(items: MultiCitedLink[]): string[] {
  if (!items.length) return ["## Citados em 2+ newsletters", "Nenhum link citado por 2 ou mais newsletters distintas.", ""];
  return ["## Citados em 2+ newsletters (informativo, não bloqueia)",
    "| Nº | Título | Newsletters | Destino | Score | URL |", "| --- | --- | --- | --- | --- | --- |",
    ...items.map((i) => `| ${i.count} | ${cell(i.title)} | ${cell(i.newsletters.join(", "))} | ${cell(i.destino)} | ${i.score ?? "PENDENTE"} | ${cell(i.url)} |`), ""];
}
