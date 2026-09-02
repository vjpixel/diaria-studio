/**
 * apoio-level-verify.ts (#7030)
 *
 * Verificação "o nível de apoio (apoia.se) associado a este e-mail atende a
 * um limiar mínimo?" — genérico, em `lib/shared/` pelo MESMO motivo de
 * `subscriber-verify.ts` (#4052): extraído pra reuso. Primeiro (e único até
 * aqui) consumidor: `workers/artigos` (gate dos Artigos Especiais, #7030),
 * que precisa de "nível ≥ X", diferente do booleano "é assinante ativo?" que
 * `subscriber-verify.ts` já resolve pro `workers/cursos`.
 *
 * Reusa o MESMO padrão de hash de e-mail de `subscriber-verify.ts`
 * (`sha256Hex`, importado — não reimplementado) e o MESMO KV primário
 * (populado por um sync agendado, aqui `scripts/sync-artigos-apoio-kv.ts`).
 * A diferença é o VALOR guardado sob a chave: `subscriber-verify.ts` grava
 * presença (`"1"`); aqui a chave `apoio:{hash}` grava o NÍVEL
 * (`amigo`/`apoiador`/`mantenedor`/`patrono`) — o mesmo valor que já está no
 * custom field `apoio_nivel` da Beehiiv, mantido por
 * `scripts/sync-apoio-nivel-beehiiv.ts`. Este módulo não deriva apoio a
 * partir do apoia.se/Stripe diretamente — só lê o que já foi sincronizado
 * (mesma divisão de responsabilidade que `subscriber-verify.ts` tem com
 * `sync-cursos-subscribers-kv.ts`).
 *
 * **Carência já embutida na fonte:** o valor de `apoio_nivel` synced na
 * Beehiiv já aplica a carência de 1 mês (`maxLevel(currentLevel,
 * previousLevel)` em `sync-apoio-nivel-beehiiv.ts`, #4436) — este módulo
 * herda essa política por construção, sem reimplementá-la. Se o gate dos
 * Artigos Especiais precisar de uma política DIFERENTE (estrita, ou
 * "apoiou uma vez, acesso permanente" — as outras 2 opções discutidas na
 * #7030), isso exige mudar `sync-artigos-apoio-kv.ts` pra computar um valor
 * próprio em vez de espelhar o campo Beehiiv — decisão do editor, não
 * assumida aqui (ver PR body).
 *
 * Só usa Web Crypto (via `sha256Hex`) — roda idêntico em Node (sync script,
 * teste) e no runtime Cloudflare Workers, sem `nodejs_compat`.
 */
import { sha256Hex } from "./subscriber-verify.ts";
// `import type` é apagado na compilação — não puxa em runtime o módulo
// pesado `sync-apoio-nivel-beehiiv.ts` (que importa `node:fs`/`node:child_process`
// via `studio-apoios.ts`/`apoia-se.ts`) pro bundle do Worker. Mesmo padrão de
// `scripts/lib/apoio-segments-canonical-kit.ts`.
import type { ApoioNivel } from "../../sync-apoio-nivel-beehiiv.ts";

export type { ApoioNivel };

/** Ordinal de faixa — mesma ordem de `sync-apoio-nivel-beehiiv.ts`
 * `LEVEL_RANK`, duplicada aqui de propósito (não importada em runtime, ver
 * nota do `import type` acima) porque é um array de 4 literais estável, sem
 * lógica — o custo de duplicar é menor que o de puxar o módulo pesado. */
const LEVEL_RANK: Record<ApoioNivel, number> = { amigo: 1, apoiador: 2, mantenedor: 3, patrono: 4 };

/** Duplicata pequena e estável de `isApoioNivel` (`sync-apoio-nivel-beehiiv.ts`)
 * pelo mesmo motivo — evita puxar o módulo pesado pro bundle do Worker só
 * por esta checagem de 4 literais. */
export function isApoioNivelValue(v: string): v is ApoioNivel {
  return v === "amigo" || v === "apoiador" || v === "mantenedor" || v === "patrono";
}

/** Chave KV canônica — usada tanto pelo sync (`sync-artigos-apoio-kv.ts`)
 * quanto pelo lookup no worker; divergir os dois quebra a verificação
 * silenciosamente (mesmo cuidado de `subscriberKvKey`). */
export async function apoioLevelKvKey(email: string): Promise<string> {
  return `apoio:${await sha256Hex(email)}`;
}

export type ApoioLevelState = "known" | "unknown";

export interface ApoioLevelLookup {
  /** `"known"` = a chave existe e tem um valor de nível válido.
   * `"unknown"` = chave ausente, OU valor presente mas não reconhecido como
   * `ApoioNivel` (sync desatualizado escrevendo um valor futuro/malformado —
   * tratado como "não sabemos", nunca como confirmação positiva nem
   * negativa forte, mesmo espírito de `SubscriberVerifyState.unknown`). */
  state: ApoioLevelState;
  level: ApoioNivel | null;
}

/**
 * Verificação PRIMÁRIA (única, por ora — sem fallback ao vivo na Beehiiv:
 * diferente de `subscriber-verify.ts`, que tem `verifySubscriberViaBeehiivByEmail`
 * como secundário, aqui não há endpoint dedicado "nível de apoio por e-mail"
 * pra chamar ao vivo — `apoio_nivel` só existe como custom field dentro do
 * corpo completo de uma subscription, mesmo custo de uma chamada `by_email`
 * comum. Se o KV não tiver a chave, o caller trata como `"unknown"` — nunca
 * como confirmação negativa forte (anti-probing do #4052/#7030 aplica aqui
 * do mesmo jeito).
 */
export async function verifyApoioLevelViaKv(kv: KVNamespace, email: string): Promise<ApoioLevelLookup> {
  const key = await apoioLevelKvKey(email);
  const raw = await kv.get(key);
  if (raw === null || raw === "") return { state: "unknown", level: null };
  if (!isApoioNivelValue(raw)) return { state: "unknown", level: null };
  return { state: "known", level: raw };
}

/** Pure: `level` atende a algum limiar dentre `thresholdLevels`? Usa o MENOR
 * ranking do conjunto como piso — ex: `thresholdLevels = ["apoiador",
 * "mantenedor", "patrono"]` aceita qualquer um dos três (e superiores).
 * `level: null` (sem apoio, ou não verificado) nunca atende. */
export function meetsApoioThreshold(level: ApoioNivel | null, thresholdLevels: readonly ApoioNivel[]): boolean {
  if (!level || thresholdLevels.length === 0) return false;
  const minRank = Math.min(...thresholdLevels.map((l) => LEVEL_RANK[l]));
  return LEVEL_RANK[level] >= minRank;
}
