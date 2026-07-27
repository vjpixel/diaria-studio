// Fixture usada por test/run-clarice-sync-daily-log-resilience.test.ts (#4047):
// substitui clarice-sync-brevo.ts/clarice-db-summary.ts para simular um passo
// que sempre sucede, sem precisar de credenciais reais nem do junction data/.
console.error("noop ok");
process.exit(0);
