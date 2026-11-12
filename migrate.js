import db from './db.js';

// --- 1. Смены ---
db.exec(`
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    total_sum REAL NOT NULL DEFAULT 0,
    orders_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open'
  );
`);

// --- 2. Колонки в orders ---
const cols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!cols.includes('shift_id')) db.exec(`ALTER TABLE orders ADD COLUMN shift_id INTEGER`);
if (!cols.includes('order_no')) db.exec(`ALTER TABLE orders ADD COLUMN order_no INTEGER`);
if (!cols.includes('closed_at')) db.exec(`ALTER TABLE orders ADD COLUMN closed_at TEXT`);

// --- 3. Открываем смену, если нет ни одной открытой ---
let openShift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
if (!openShift) {
  const r = db.prepare("INSERT INTO shifts DEFAULT VALUES").run();
  openShift = db.prepare("SELECT * FROM shifts WHERE id = ?").get(r.lastInsertRowid);
  console.log('Открыта смена #' + openShift.id);
} else {
  console.log('Уже есть открытая смена #' + openShift.id);
}

// --- 4. Подтягиваем shift_id к старым заказам, если не заполнено ---
db.prepare("UPDATE orders SET shift_id = ? WHERE shift_id IS NULL").run(openShift.id);

// --- 5. Проставляем order_no существующим заказам (по порядку id) ---
const orders = db.prepare("SELECT id FROM orders WHERE order_no IS NULL ORDER BY id").all();
let n = db.prepare("SELECT COALESCE(MAX(order_no),0) AS m FROM orders WHERE shift_id = ?").get(openShift.id).m;
const upd = db.prepare("UPDATE orders SET order_no = ? WHERE id = ?");
for (const o of orders) { n++; upd.run(n, o.id); }

console.log('Миграция завершена.');