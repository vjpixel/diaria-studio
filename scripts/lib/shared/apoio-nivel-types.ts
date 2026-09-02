/**
 * apoio-nivel-types.ts (#7030 hotfix)
 *
 * `ApoioNivel` (a união de 4 literais amigo/apoiador/mantenedor/patrono) +
 * `isApoioNivel` extraídos de `scripts/sync-apoio-nivel-beehiiv.ts` pra um
 * módulo PURO em `lib/shared/` — zero imports, zero `fileURLToPath`.
 *
 * Por quê: `scripts/lib/shared/apoio-level-verify.ts` (consumido por
 * `workers/artigos/src/apoio-gate.ts`, #7030) só precisava do TIPO
 * `ApoioNivel`, e usava `import type { ApoioNivel } from
 * "../../sync-apoio-nivel-beehiiv.ts"` assumindo que `import type` seria
 * apagado na compilação e nunca puxaria o módulo pesado (`env-loader.ts`,
 * `beehiiv-config.ts`, `cli-args.ts`, `apoia-se.ts`,
 * `sync-cursos-subscribers-kv.ts` — todos chamando `fileURLToPath` sobre
 * `import.meta.url` no top-level) pro bundle do Worker. Isso é verdade em RUNTIME (esbuild/tsc
 * elidem `import type`), mas o guard estático `test/worker-bundle-node-only-imports.test.ts`
 * (#4318) faz scan de TEXTO/regex, não resolução real de tipos — não
 * distingue `import type` de `import` comum, então seguiu a cadeia inteira
 * e acusou 6 violações (hotfix de master vermelho pós-#7030, commit
 * c8fcdc9b).
 *
 * Fix na direção certa (não relaxar o guard, que é intencionalmente cego a
 * `import type` — casar a regex certo dependeria de um parser TS real, caro
 * pra um scan estático): mover o TIPO pra um arquivo que genuinamente não
 * alcança nada Node-only, cortando a cadeia na raiz. Mesmo padrão que
 * `scripts/lib/shared/subscriber-verify.ts` já usa pro par
 * assinante-ativo/`workers/cursos` (#4052).
 *
 * `sync-apoio-nivel-beehiiv.ts` reexporta os dois símbolos daqui — os
 * consumidores existentes (`kit-gmail-warmup-ramp.ts`,
 * `sync-artigos-apoio-kv.ts`, etc.) continuam importando de
 * `./sync-apoio-nivel-beehiiv.ts` sem nenhuma mudança.
 */

export type ApoioNivel = "amigo" | "apoiador" | "mantenedor" | "patrono";

const LEVEL_VALUES: readonly ApoioNivel[] = ["amigo", "apoiador", "mantenedor", "patrono"];

export function isApoioNivel(v: string): v is ApoioNivel {
  return (LEVEL_VALUES as readonly string[]).includes(v);
}
