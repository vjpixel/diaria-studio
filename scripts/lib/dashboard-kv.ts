/**
 * dashboard-kv.ts — constantes do KV do dashboard Brevo/Clarice.
 *
 * Módulo SEM efeitos colaterais (nenhum `loadProjectEnv()` ou I/O no top-level):
 * importar daqui não polui `process.env` nem toca disco. Extraído de
 * `clarice-mv-status.ts` (#2743) — aquele arquivo roda `loadProjectEnv()` no
 * nível de módulo, então importar a constante de lá vazava o `.env.local` pra
 * qualquer consumidor (inclusive testes), quebrando o isolamento.
 *
 * Namespace KV único compartilhado por todas as chaves do dashboard
 * (`mv:status`, `coupons:usage`, cohorts, contacts:summary, etc.).
 */
export const DASHBOARD_KV_NAMESPACE_ID = "2f87d65d735c499ab8f465774d0167e2";
