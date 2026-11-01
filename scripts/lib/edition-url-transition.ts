/**
 * edition-url-transition.ts (#11751) — marcador de troca de URL da edição em
 * curso, entre `03-social.md` e `_internal/05-edition-url.txt`.
 *
 * `kit-refresh-social-edition-url.ts` (Stage 6) troca a URL nos dois arquivos
 * em duas escritas atômicas separadas, e nenhuma ordem deixa o par sempre
 * coerente: `03-social.md` vai primeiro (a leitura de `05-edition-url.txt`
 * decide o atalho `already_resolved` da próxima chamada, #7405), então uma
 * queda entre as duas deixa o texto com a URL nova e o arquivo de URL com a
 * antiga. A conferência de frescor do Stage 5 (`stage5-freshness.ts`, #11698)
 * reverte a URL de `05-edition-url.txt` para `{edition_url}` antes de
 * comparar com o hash aprovado; com o par incoerente, a reversão não casa e a
 * Etapa 5 para com `diverged`.
 *
 * O marcador registra a transição: gravado ANTES de reescrever
 * `03-social.md`, apagado DEPOIS de gravar `05-edition-url.txt`. Enquanto ele
 * existir, o checker aceita também a reversão pela URL de destino (`to`).
 * Marcador sobrando depois de uma transição completa é inofensivo: `to` é a
 * mesma URL de `05-edition-url.txt`.
 *
 * Leitura fail-soft: marcador ausente, ilegível ou com URL não-https vale
 * `null` — o checker volta ao comportamento sem marcador (falha fechada).
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

export const EDITION_URL_TRANSITION_REL = "_internal/05-edition-url.transition.json";

export interface EditionUrlTransition {
  /** URL que estava em `05-edition-url.txt` antes da troca (null = arquivo ausente). */
  from: string | null;
  /** URL que vai entrar em `03-social.md` e `05-edition-url.txt`. */
  to: string;
}

const HTTPS_URL = /^https:\/\/\S+$/;

export function writeEditionUrlTransition(editionDir: string, t: EditionUrlTransition): void {
  writeFileAtomic(join(editionDir, EDITION_URL_TRANSITION_REL), JSON.stringify(t) + "\n", { encoding: "utf8" });
}

export function clearEditionUrlTransition(editionDir: string): void {
  const p = join(editionDir, EDITION_URL_TRANSITION_REL);
  if (existsSync(p)) unlinkSync(p);
}

export function readEditionUrlTransition(editionDir: string): EditionUrlTransition | null {
  const p = join(editionDir, EDITION_URL_TRANSITION_REL);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { from?: unknown; to?: unknown };
    if (!raw || typeof raw !== "object") return null;
    const to = typeof raw.to === "string" ? raw.to.trim() : "";
    if (!HTTPS_URL.test(to)) return null;
    const from = typeof raw.from === "string" && HTTPS_URL.test(raw.from.trim()) ? raw.from.trim() : null;
    return { from, to };
  } catch {
    return null;
  }
}
