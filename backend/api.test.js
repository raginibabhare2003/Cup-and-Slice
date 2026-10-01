const test = require('node:test'), assert = require('node:assert');
process.env.ADMIN_USER = 'boss';
const server = require('./server');
let base; test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());
const api = (p, o = {}, t) => fetch(base + p, { method: o.body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(t && { Authorization: 'Bearer ' + t }) }, ...o }).then(async r => ({ s: r.status, j: await r.json() }));

test('menu is seeded', async () => assert.ok((await api('/api/menu')).j.length >= 17));
test('register, order with server-side price, list orders', async () => {
  const u = 'user' + Date.now(), reg = await api('/api/auth/register', { body: JSON.stringify({ username: u, password: 'password123' }) });
  assert.equal(reg.s, 201);
  const o = await api('/api/orders', { body: JSON.stringify({ item: 'Latte', qty: 2, price: 1, address: '123 Main Street', customerName: 'Test User' }) }, reg.j.token);
  assert.equal(Number(o.j.order.total), 312.9);
  assert.equal((await api('/api/orders', {}, reg.j.token)).j.length, 1);
  assert.equal((await api('/api/admin/orders', {}, reg.j.token)).s, 403);
});
test('rejects bad input and bad login', async () => {
  assert.equal((await api('/api/orders', { body: JSON.stringify({ item: 'Latte', qty: -1 }) })).s, 401);
  assert.equal((await api('/api/auth/login', { body: JSON.stringify({ username: 'nobody', password: 'x' }) })).s, 401);
});
test('reservation saved', async () => assert.equal((await api('/api/reservations', { body: JSON.stringify({ name: 'Ragini', people: 4, at: '2026-10-10T19:00', message: 'Window seat' }) })).s, 201));
