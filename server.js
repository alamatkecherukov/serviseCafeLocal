import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import http from 'http';
import os from 'os';
import db from './db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const PORT = 3000;
const HOST = getLocalIP();

const PINS = { admin: '1111', kitchen: '2222', waiter: '3333' };
const checkPin = (role, pin) => PINS[role] && PINS[role] === pin;

// ---------- helpers ----------
const getOpenShift = () =>
  db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();

function ensureOpenShift() {
  let s = getOpenShift();
  if (!s) {
    const r = db.prepare("INSERT INTO shifts DEFAULT VALUES").run();
    s = db.prepare("SELECT * FROM shifts WHERE id = ?").get(r.lastInsertRowid);
  }
  return s;
}

function recalcShift(shiftId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(oi.price * oi.qty),0) AS total,
           COUNT(DISTINCT o.id) AS cnt
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.shift_id = ? AND o.status != 'cancelled'
  `).get(shiftId);
  db.prepare("UPDATE shifts SET total_sum = ?, orders_count = ? WHERE id = ?")
    .run(row.total, row.cnt, shiftId);
}

// ---------- ШАПКА ----------
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ---------- ЗАЛЫ ----------
app.get('/api/halls', (_, res) => res.json(db.prepare('SELECT * FROM halls').all()));
app.post('/api/halls', (req, res) => {
  const { name } = req.body;
  const r = db.prepare('INSERT INTO halls(name) VALUES (?)').run(name);
  res.json({ id: r.lastInsertRowid });
});

// ---------- СТОЛЫ ----------
app.get('/api/tables', (_, res) => res.json(db.prepare('SELECT * FROM tables').all()));
app.post('/api/tables', (req, res) => {
  const { hall_id, number } = req.body;
  const r = db.prepare('INSERT INTO tables(hall_id, number) VALUES (?, ?)').run(hall_id, number);
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/tables/active', (_, res) => {
  const rows = db.prepare(`
    SELECT t.number AS table_number,
           COUNT(DISTINCT o.id) AS orders_count,
           COALESCE(SUM(oi.price * oi.qty),0) AS total
    FROM tables t
    JOIN orders o ON o.table_id = t.id AND o.status NOT IN ('closed','cancelled')
    LEFT JOIN order_items oi ON oi.order_id = o.id
    GROUP BY t.id
  `).all();
  res.json(rows);
});

// ---------- QR ----------
app.get('/api/qr/:tableId', async (req, res) => {
  const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.tableId);
  if (!t) return res.status(404).send('not found');
  const url = `http://${HOST}:${PORT}/menu.html?table=${t.number}`;
  const png = await QRCode.toBuffer(url, { width: 400 });
  res.type('png').send(png);
});

// ---------- КАТЕГОРИИ / БЛЮДА ----------
app.get('/api/categories', (_, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort').all()));
app.post('/api/categories', (req, res) => {
  const { name, sort = 0 } = req.body;
  const r = db.prepare('INSERT INTO categories(name, sort) VALUES (?, ?)').run(name, sort);
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/dishes', (_, res) => res.json(db.prepare('SELECT * FROM dishes WHERE available = 1').all()));
app.get('/api/dishes/all', (_, res) => res.json(db.prepare('SELECT * FROM dishes').all()));
app.post('/api/dishes', (req, res) => {
  const { category_id, name, price, description = '' } = req.body;
  const r = db.prepare('INSERT INTO dishes(category_id, name, price, description) VALUES (?,?,?,?)')
    .run(category_id, name, price, description);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/dishes/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM dishes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const price = req.body.price !== undefined ? req.body.price : d.price;
  const available = req.body.available !== undefined ? (req.body.available ? 1 : 0) : d.available;
  db.prepare('UPDATE dishes SET price = ?, available = ? WHERE id = ?').run(price, available, req.params.id);
  res.json({ ok: true });
});

// ---------- ЗАКАЗЫ ----------
app.post('/api/orders', (req, res) => {
  const { tableNumber, source = 'qr', note = '', items } = req.body;
  const table = db.prepare('SELECT * FROM tables WHERE number = ?').get(tableNumber);
  if (!table) return res.status(400).json({ error: 'table not found' });
  const shift = ensureOpenShift();

  const tx = db.transaction(() => {
    const maxNo = db.prepare("SELECT COALESCE(MAX(order_no),0) AS m FROM orders WHERE shift_id = ?").get(shift.id).m;
    const orderNo = maxNo + 1;
    const o = db.prepare(
      'INSERT INTO orders(table_id, source, note, shift_id, order_no) VALUES (?,?,?,?,?)'
    ).run(table.id, source, note, shift.id, orderNo);
    const orderId = o.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO order_items(order_id, dish_id, qty, price, note) VALUES (?,?,?,?,?)'
    );
    for (const it of items) {
      const dish = db.prepare('SELECT * FROM dishes WHERE id = ?').get(it.dishId);
      if (!dish) throw new Error('dish not found ' + it.dishId);
      ins.run(orderId, dish.id, it.qty || 1, dish.price, it.note || '');
    }
    recalcShift(shift.id);
    return { orderId, orderNo };
  });

  try {
    const { orderId, orderNo } = tx();
    broadcast({ type: 'order_new', orderId, orderNo });
    res.json({ orderId, orderNo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/orders', (req, res) => {
  const { status, shift } = req.query;
  const conds = [];
  const args = [];
  if (status) { conds.push('o.status = ?'); args.push(status); }
  if (shift === 'current') {
    const s = getOpenShift();
    if (s) { conds.push('o.shift_id = ?'); args.push(s.id); }
    else { conds.push('1=0'); }
  } else if (shift) {
    conds.push('o.shift_id = ?'); args.push(Number(shift));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const orders = db.prepare(`
    SELECT o.*, t.number AS table_number
    FROM orders o JOIN tables t ON t.id = o.table_id
    ${where} ORDER BY o.id DESC
  `).all(...args);
  const getItems = db.prepare(`
    SELECT oi.*, d.name FROM order_items oi
    JOIN dishes d ON d.id = oi.dish_id WHERE oi.order_id = ?
  `);
  res.json(orders.map(o => ({ ...o, items: getItems.all(o.id) })));
});

app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  const isClosing = status === 'closed' && order.status !== 'closed';
  db.prepare('UPDATE orders SET status = ?, closed_at = CASE WHEN ? = \'closed\' THEN datetime(\'now\') ELSE closed_at END WHERE id = ?')
    .run(status, status, req.params.id);
  if (isClosing) recalcShift(order.shift_id);
  broadcast({ type: 'order_updated', orderId: Number(req.params.id), status });
  res.json({ ok: true });
});

// ---------- СМЕНЫ ----------
app.get('/api/shifts/current', (_, res) => {
  const s = ensureOpenShift();
  recalcShift(s.id);
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id));
});

app.get('/api/shifts/archive', (_, res) => {
  res.json(db.prepare("SELECT * FROM shifts WHERE status = 'closed' ORDER BY closed_at DESC").all());
});

app.get('/api/shifts/:id/orders', (req, res) => {
  const shiftId = Number(req.params.id);
  const orders = db.prepare(`
    SELECT o.*, t.number AS table_number
    FROM orders o JOIN tables t ON t.id = o.table_id
    WHERE o.shift_id = ? ORDER BY o.id ASC
  `).all(shiftId);
  const getItems = db.prepare(`
    SELECT oi.*, d.name FROM order_items oi
    JOIN dishes d ON d.id = oi.dish_id WHERE oi.order_id = ?
  `);
  res.json(orders.map(o => ({ ...o, items: getItems.all(o.id) })));
});

app.post('/api/shifts/close', (_, res) => {
  const s = getOpenShift();
  if (!s) return res.status(400).json({ error: 'no open shift' });
  recalcShift(s.id);
  const fresh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  db.prepare("UPDATE shifts SET status='closed', closed_at=datetime('now') WHERE id = ?").run(s.id);
  const newShift = db.prepare("INSERT INTO shifts DEFAULT VALUES").run();
  broadcast({ type: 'shift_closed', shiftId: s.id });
  res.json({
    closedShift: { ...fresh, status: 'closed' },
    newShiftId: newShift.lastInsertRowid
  });
});

// ---------- ЛОГИН ----------
app.post('/api/login', (req, res) => {
  const { role, pin } = req.body;
  if (checkPin(role, pin)) res.json({ ok: true, role });
  else res.status(401).json({ ok: false, error: 'wrong pin' });
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер:   http://${HOST}:${PORT}`);
  console.log(`Админ:    http://${HOST}:${PORT}/admin.html     (PIN 1111)`);
  console.log(`Кухня:    http://${HOST}:${PORT}/kitchen.html   (PIN 2222)`);
  console.log(`Официант: http://${HOST}:${PORT}/waiter.html    (PIN 3333)`);
});