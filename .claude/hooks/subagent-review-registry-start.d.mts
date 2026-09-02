// Declaração de tipos para o companheiro `.mjs` (#6956) — TS não faz type
// stripping/checking de `.mjs` puro (sem `allowJs`+`checkJs` no
// `tsconfig.json` raiz, que este repo não liga — decisão intencional
// documentada em `tsconfig.json`), então module resolution "Bundler" cai em
// TS7016 (implicit any) ao importar um `.mjs` sem uma `.d.mts` companheira.
// Precedente do MESMO padrão de erro tolerado via baseline em
// `test/pr-create-review-hook.test.ts::TS7016` e
// `test/block-gh-pr-merge-subagent-hook.test.ts::TS7016` — mas
// `typecheck-ratchet.ts` só tolera chaves JÁ na baseline; uma chave NOVA
// (este arquivo de teste) reprova o CI. Em vez de herdar a mesma lacuna via
// `--update-baseline`, este stub tipa de verdade a superfície que o teste
// consome — mais estreito que o `.mjs` inteiro, mas suficiente e sincronizado
// manualmente com as assinaturas reais (nenhuma automação garante isso, do
// mesmo jeito que os hooks duplicam constantes de `.ts` deliberadamente —
// ver docblock do `.mjs` sobre por que ele nunca importa `.ts`).

export declare const REVIEW_AGENT_TYPES: Set<string>;

export declare function registryDir(repoRoot: string): string;

export declare function resolveRepoRoot(execFn?: (...args: unknown[]) => string): string;

export declare function resolveHeadSha(
  repoRoot: string,
  execFn?: (...args: unknown[]) => string,
): string | null;

export interface SubagentReviewStartRecord {
  nonce: string;
  agent_id: string;
  agent_type: string;
  session_id: string | null;
  at: string;
  head_sha: string | null;
  status: "started";
}

export declare function buildStartRecord(
  payload: unknown,
  opts?: {
    repoRoot?: string;
    execFn?: (...args: unknown[]) => string;
    nonceFn?: () => string;
  },
): SubagentReviewStartRecord | null;

export declare function writeStartRecord(
  repoRoot: string,
  record: SubagentReviewStartRecord | null,
): boolean;

export declare function generateNonce(): string;
