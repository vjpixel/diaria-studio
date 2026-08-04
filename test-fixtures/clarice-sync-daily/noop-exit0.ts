// Fixture usada por test/run-clarice-sync-daily-log-resilience.test.ts (#4047):
// substitui clarice-sync-brevo.ts/clarice-db-summary.ts para simular um passo
// que sempre sucede, sem precisar de credenciais reais nem do junction data/.
//
// Mora em test-fixtures/ (raiz do repo), NÃO em test/fixtures/ (#4552 review):
// `node --test` varre por padrão qualquer .ts/.js/.mjs/.cjs dentro de UM
// DIRETÓRIO CHAMADO "test" a qualquer profundidade (**/test/**/*.{ts,js,...}),
// mesmo sem casar *.test.ts — um script executável aqui dentro de test/
// vira "teste" próprio, com exit code decidindo pass/fail. Este arquivo
// sai 0 (passa silenciosamente, some no ruído); o irmão noop-exit1.ts
// sairia 1 e quebraria a suíte por engano. Não mover de volta pra
// test/fixtures/.
console.error("noop ok");
process.exit(0);
