// Fixture usada por test/run-evaluate-brevo-diaria-ps1.test.ts (#4552 review):
// substitui evaluate-brevo-diaria.ts para simular um passo que sempre falha,
// sem precisar de credenciais reais nem do junction data/.
console.error("noop fail");
process.exit(1);
