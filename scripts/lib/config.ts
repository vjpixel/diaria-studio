/**
 * config.ts — constantes de configuração centralizadas.
 * Substituem magic numbers espalhados pelos scripts.
 */
export const CONFIG = {
  timeouts: {
    /** verify-accessibility: HEAD/GET request timeout (ms) */
    verify: 8_000,
    /** fetch genérico (inbox title resolution, aggregator expansion) */
    fetch: 8_000,
    /** Google Drive API calls */
    drive: 30_000,
    /** Gemini API (translation via gemini.translate_model em platform.config.json) */
    gemini: 10_000,
    /** Wikimedia API (eia-compose: lang-link lookup) */
    wikimedia: 5_000,
    /** Wikimedia download (eia-compose: image download) */
    wikimediaDownload: 30_000,
    /** Make.com webhook (publish-linkedin) */
    makeWebhook: 15_000,
    /** Graph API (publish-facebook) */
    graphApi: 30_000,
  },
  dedup: {
    /** Threshold de similaridade de título para dedup dentro da lista (0-1) */
    titleThreshold: 0.85,
    /** Threshold mais permissivo para dedup vs títulos de edições passadas (0-1) */
    titleVsPastThreshold: 0.70,
    /** Concorrência máxima para resolveInboxTitles */
    titleResolutionConcurrency: 15,
  },
  eiaCompose: {
    /** Máximo de tentativas de POTD no eligibility loop */
    maxWikiAttempts: 7,
  },
  inboxAggregator: {
    /** Máximo de links primários extraídos por agregador */
    maxPrimaryLinks: 10,
  },
  driveSync: {
    /** Máximo de retries em falha de upload/download */
    maxRetries: 3,
    /** Base de backoff exponencial em ms (1s, 2s, 4s + jitter) */
    backoffBaseMs: 1_000,
  },
} as const;
