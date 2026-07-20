/**
 * scripts/studio-ui/gh-run.ts (#3783)
 *
 * Wrapper único sobre `spawnSync("gh", ...)` compartilhado por
 * `studio-wave-fire.ts` e `studio-issues.ts`. Extraído do primeiro (#3773
 * introduziu `spawnGhSync` com `timeout` ali, corrigindo um `spawnSync` sem
 * teto que pendurava o event loop indefinidamente se `gh` travasse — token
 * expirado, API do GitHub lenta/rate-limited) porque `studio-issues.ts` tinha
 * exatamente o mesmo gap em `defaultGhRun`, nunca migrado pro fix (#3783).
 *
 * A duplicação era pior no lado de `studio-issues.ts`: `defaultGhRun`
 * alimenta `fetchTriageData`, chamada por `GET /api/issues`/`GET /api/waves`
 * — rotas de USO NORMAL do Studio (Triagem), não gateadas por env var como o
 * wave-fire. Um `gh auth` expirado ou GitHub degradado enquanto o editor
 * navega o Studio travava `spawnSync` (bloqueante) sem teto, e como o
 * studio-server é um único processo Node, qualquer outra rota HTTP
 * concorrente (chat drawer, autosave do painel de revisão) travava junto —
 * viola CLAUDE.md #738 ("Stall silencioso > 60s é inaceitável").
 *
 * `bin`/`timeoutMs` são parametrizados (produção sempre usa `"gh"` +
 * `GH_SPAWN_TIMEOUT_MS`) só pra permitir testar com um binário genuinamente
 * lento (`process.execPath` com um `setTimeout` maior que o timeout dado) e
 * um timeout curto — provando que `spawnSync` mata o processo pendurado em
 * vez de bloquear o event loop indefinidamente, sem precisar de `gh`
 * instalado nem esperar os 10s reais de produção.
 */
import { spawnSync } from "node:child_process";

export interface GhSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GhSpawnRunFn = (args: string[], cwd: string) => GhSpawnResult;

/** Teto de tempo pra cada `spawnSync("gh", ...)` — ver doc-comment do módulo.
 * 10s é generoso pra latência normal do `gh` mas BOUNDED em vez de
 * indefinido. Quando `spawnSync` estoura o timeout, `result.status` vem
 * `null` (processo morto via SIGTERM) — os callers já tratam `status !== 0`
 * como falha, então isso nunca vira sucesso silencioso. */
export const GH_SPAWN_TIMEOUT_MS = 10_000;

export function spawnGhSync(
  args: string[],
  cwd: string,
  timeoutMs: number = GH_SPAWN_TIMEOUT_MS,
  bin: string = "gh",
): GhSpawnResult {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
