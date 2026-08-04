// Fixture usada por test/run-evaluate-brevo-diaria-ps1.test.ts (#4552 review):
// substitui evaluate-brevo-diaria.ts para simular um passo que sempre falha,
// sem precisar de credenciais reais nem do junction data/.
//
// Mora em test-fixtures/ (raiz do repo), NÃO em test/fixtures/: `node --test`
// varre por padrão qualquer .ts/.js/.mjs/.cjs dentro de um diretório chamado
// "test" a qualquer profundidade, mesmo sem casar *.test.ts — colocado sob
// test/fixtures/ este script vira um "teste" próprio, e como sai com exit 1
// o runner reporta 1 teste falho na suíte inteira (achado da CI da PR #4552,
// que expôs o mesmo problema latente no irmão noop-exit0.ts — só não
// aparecia porque sai 0). Não mover de volta pra test/fixtures/.
console.error("noop fail");
process.exit(1);
