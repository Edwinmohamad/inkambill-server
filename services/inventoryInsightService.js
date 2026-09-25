// v1.26 — Stock Monitoring Insights. Satu sumber perhitungan untuk halaman Stock Barang, Analitik Gudang,
// Saran Pembelian, Layar Gudang (TV), widget Dashboard, dan ringkasan WhatsApp harian, supaya angka
// "estimasi habis", "dead stock", dan status low/critical selalu sama di mana pun ditampilkan.
//
// Definisi:
// - Pemakaian harian = total movement 'out' 30 hari terakhir / 30 (pemakaian material juga membuat
//   movement 'out', jadi tidak dihitung dua kali).
// - Estimasi habis  = qty / pemakaian harian (null bila tidak ada pemakaian 30 hari).
// - Dead stock      = qty > 0 dan tidak ada pergerakan selama DEAD_DAYS hari.
// - Tren (sparkline)= saldo akhir harian 30 hari, direkonstruksi mundur dari qty saat ini.
const db = require('../config/db');

const USAGE_WINDOW = 30;
const DEAD_DAYS = 90;
const SOON_DAYS = 14;
const SPARK_DAYS = 30;

const n = v => Number(v || 0);
const r2 = v => Math.round(v * 100) / 100;

function jakartaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function dayKeys(days) {
  const keys = [];
  const today = new Date(`${jakartaDateKey()}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  return keys;
}

function stockStatus(qty, min) {
  const low = min > 0 && qty <= min;
  const critical = low && qty <= Math.max(1, min * 0.5);
  return critical ? 'critical' : low ? 'low' : 'ready';
}

// Inline SVG sparkline (tanpa library) — dipakai langsung di tabel/kartu.
function sparkSvg(points, { width = 96, height = 26, tone = 'var(--brand)' } = {}) {
  if (!points || points.length < 2) return '';
  const max = Math.max(...points), min = Math.min(...points), span = max - min || 1;
  const step = width / (points.length - 1);
  const xy = points.map((v, i) => [r2(i * step), r2(height - 3 - ((v - min) / span) * (height - 6))]);
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const last = xy[xy.length - 1];
  return `<svg class="inv-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" fill="${tone}" opacity=".12"/><path d="${line}" fill="none" stroke="${tone}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${tone}"/></svg>`;
}

function relativeDays(dateKey) {
  if (!dateKey) return { days: null, label: 'Belum pernah' };
  const days = Math.max(0, Math.round((new Date(`${jakartaDateKey()}T00:00:00Z`) - new Date(`${String(dateKey).slice(0, 10)}T00:00:00Z`)) / 86400000));
  return { days, label: days === 0 ? 'Hari ini' : days === 1 ? 'Kemarin' : days < 30 ? `${days} hari lalu` : days < 365 ? `${Math.floor(days / 30)} bln lalu` : `${Math.floor(days / 365)} thn lalu` };
}

async function loadItems({ site = '' } = {}) {
  let sql = `SELECT i.*,COALESCE(ic.name,i.category) category_name,s.code site_code,s.name site_name,sp.name supplier_name
    FROM inventory_items i LEFT JOIN inventory_categories ic ON ic.id=i.category_id LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id
    WHERE i.is_active=1 AND i.deleted_at IS NULL`;
  const params = [];
  if (site) { sql += ` AND s.code=?`; params.push(site); }
  sql += ` ORDER BY i.name`;
  const [rows] = await db.execute(sql, params);
  return rows;
}

// Hitung metrik per item. `items` boleh sudah difilter site; movement diambil hanya untuk id tersebut.
async function enrichItems(items) {
  if (!items.length) return [];
  const ids = items.map(i => i.id);
  const ph = ids.map(() => '?').join(',');
  const [daily] = await db.query(`SELECT item_id,DATE_FORMAT(created_at,'%Y-%m-%d') d,
      SUM(CASE WHEN movement_type='out' THEN qty ELSE 0 END) out_qty,
      SUM(CASE WHEN movement_type<>'out' THEN qty ELSE 0 END) in_qty
    FROM inventory_movements WHERE item_id IN (${ph}) AND created_at>=DATE_SUB(CURDATE(),INTERVAL ${Math.max(USAGE_WINDOW, SPARK_DAYS) - 1} DAY)
    GROUP BY item_id,d`, ids);
  const [last] = await db.query(`SELECT item_id,DATE_FORMAT(MAX(created_at),'%Y-%m-%d') last_day,MAX(created_at) last_at FROM inventory_movements WHERE item_id IN (${ph}) GROUP BY item_id`, ids);
  const lastMap = new Map(last.map(r => [r.item_id, r]));
  const byItem = new Map();
  for (const row of daily) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, new Map());
    byItem.get(row.item_id).set(row.d, { out: n(row.out_qty), in: n(row.in_qty) });
  }
  const keys = dayKeys(SPARK_DAYS);
  const usageKeys = new Set(dayKeys(USAGE_WINDOW));
  return items.map(item => {
    const qty = n(item.qty), min = n(item.min_stock), price = n(item.purchase_price);
    const days = byItem.get(item.id) || new Map();
    let usage30 = 0, in30 = 0;
    for (const [d, v] of days) if (usageKeys.has(d)) { usage30 += v.out; in30 += v.in; }
    // Rekonstruksi saldo akhir hari mundur dari qty sekarang.
    const spark = new Array(keys.length);
    let bal = qty;
    for (let i = keys.length - 1; i >= 0; i--) {
      spark[i] = r2(bal);
      const v = days.get(keys[i]);
      if (v) bal = bal - v.in + v.out;
    }
    const avgDaily = usage30 / USAGE_WINDOW;
    const daysLeft = avgDaily > 0 ? qty / avgDaily : null;
    const lm = lastMap.get(item.id);
    const lastMove = relativeDays(lm?.last_day);
    const status = stockStatus(qty, min);
    const dead = qty > 0 && (lastMove.days == null || lastMove.days >= DEAD_DAYS);
    const soon = daysLeft != null && daysLeft <= SOON_DAYS;
    // Rasio untuk bar: 100% = 2× minimum stock (atau qty sendiri bila tanpa minimum).
    const barMax = min > 0 ? min * 2 : Math.max(qty, 1);
    const barPct = Math.max(2, Math.min(100, Math.round((qty / barMax) * 100)));
    const trend = spark[0] === spark[spark.length - 1] ? 'flat' : spark[spark.length - 1] > spark[0] ? 'up' : 'down';
    let urgency = 0;
    if (status === 'critical') urgency += 300; else if (status === 'low') urgency += 200;
    if (daysLeft != null) urgency += Math.max(0, 100 - daysLeft * 5);
    if (qty <= 0) urgency += 100;
    return {
      ...item, qty, min_stock: min, purchase_price: price, value: qty * price,
      usage30: r2(usage30), in30: r2(in30), avgDaily: r2(avgDaily), daysLeft: daysLeft == null ? null : Math.floor(daysLeft),
      status, dead, soon, spark, trend, barPct, lastMoveDays: lastMove.days, lastMoveLabel: lastMove.label, lastMoveAt: lm?.last_at || null,
      urgency, needsAction: status !== 'ready' || soon
    };
  });
}

function daysLeftLabel(item) {
  if (item.qty <= 0) return 'Habis';
  if (item.daysLeft == null) return 'Tidak ada pemakaian';
  if (item.daysLeft < 1) return '< 1 hari';
  return `± ${item.daysLeft} hari`;
}

function summarize(items) {
  const total = items.length;
  const counts = { all: total, ready: 0, low: 0, critical: 0, soon: 0, dead: 0, empty: 0 };
  let value = 0, units = 0, deadValue = 0;
  for (const i of items) {
    counts[i.status]++;
    if (i.soon) counts.soon++;
    if (i.dead) { counts.dead++; deadValue += i.value; }
    if (i.qty <= 0) counts.empty++;
    value += i.value; units += i.qty;
  }
  const health = total ? Math.round((counts.ready / total) * 100) : 100;
  const actionList = items.filter(i => i.needsAction).sort((a, b) => b.urgency - a.urgency);
  counts.action = actionList.length;
  return { counts, value, units, deadValue, health, actionList };
}

function reorderSuggestions(items, coverDays = 30) {
  const cover = Math.max(1, Math.min(180, Number(coverDays) || 30));
  const rows = [];
  for (const i of items) {
    const target = i.min_stock + i.avgDaily * cover;
    const suggest = Math.ceil(target - i.qty);
    const inScope = i.status !== 'ready' || (i.daysLeft != null && i.daysLeft <= cover);
    if (suggest > 0 && inScope) rows.push({ ...i, target: r2(target), suggest, cost: suggest * i.purchase_price });
  }
  rows.sort((a, b) => b.urgency - a.urgency);
  const groups = new Map();
  for (const row of rows) {
    const key = row.supplier_name || 'Tanpa Supplier';
    if (!groups.has(key)) groups.set(key, { supplier: key, rows: [], cost: 0 });
    const g = groups.get(key); g.rows.push(row); g.cost += row.cost;
  }
  return { cover, rows, groups: [...groups.values()].sort((a, b) => b.cost - a.cost), totalCost: rows.reduce((s, r) => s + r.cost, 0) };
}

async function recentActivity(limit = 15, { site = '' } = {}) {
  const params = [];
  let sql = `SELECT m.id,m.item_id,m.movement_type,m.qty,m.reference,m.notes,m.created_at,i.name item_name,i.unit,u.name user_name
    FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.user_id LEFT JOIN sites s ON s.id=i.site_id WHERE 1=1`;
  if (site) { sql += ` AND s.code=?`; params.push(site); }
  sql += ` ORDER BY m.id DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 15))}`;
  const [rows] = await db.query(sql, params);
  return rows;
}

async function analytics(items, { site = '' } = {}) {
  const siteSql = site ? ' AND s.code=?' : '';
  const siteParams = site ? [site] : [];
  // Nilai stock per kategori
  const catMap = new Map();
  for (const i of items) {
    const k = i.category_name || 'Tanpa Kategori';
    const c = catMap.get(k) || { name: k, value: 0, qty: 0, items: 0, low: 0 };
    c.value += i.value; c.qty += i.qty; c.items++; if (i.status !== 'ready') c.low++;
    catMap.set(k, c);
  }
  const categories = [...catMap.values()].sort((a, b) => b.value - a.value);
  // Heatmap site × kategori
  const siteNames = [...new Set(items.map(i => i.site_code || 'GLOBAL'))].sort();
  const catNames = categories.map(c => c.name);
  const cells = {};
  const rank = { ready: 0, low: 1, critical: 2 };
  for (const i of items) {
    const key = `${i.site_code || 'GLOBAL'}|${i.category_name || 'Tanpa Kategori'}`;
    const c = cells[key] || { items: 0, low: 0, qty: 0, worst: 'ready', names: [] };
    c.items++; c.qty += i.qty; if (i.status !== 'ready') { c.low++; c.names.push(i.name); }
    if (rank[i.status] > rank[c.worst]) c.worst = i.status;
    cells[key] = c;
  }
  // Tren mingguan 12 minggu
  const [weekly] = await db.query(`SELECT YEARWEEK(m.created_at,3) yw,DATE_FORMAT(MIN(m.created_at),'%d %b') label,
      SUM(CASE WHEN m.movement_type='out' THEN m.qty ELSE 0 END) out_qty,SUM(CASE WHEN m.movement_type<>'out' THEN m.qty ELSE 0 END) in_qty
    FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN sites s ON s.id=i.site_id
    WHERE m.created_at>=DATE_SUB(CURDATE(),INTERVAL 12 WEEK)${siteSql} GROUP BY yw ORDER BY yw`, siteParams);
  // Top 10 dipakai (30 hari)
  const topUsed = [...items].filter(i => i.usage30 > 0).sort((a, b) => b.usage30 - a.usage30).slice(0, 10);
  // Pemakaian per site & tujuan (90 hari)
  const [bySite] = await db.query(`SELECT COALESCE(s.code,'-') site_code,COUNT(*) entries,SUM(mu.qty) qty,SUM(mu.qty*i.purchase_price) value
    FROM material_usages mu JOIN inventory_items i ON i.id=mu.item_id LEFT JOIN sites s ON s.id=mu.site_id
    WHERE mu.used_at>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)${siteSql} GROUP BY site_code ORDER BY value DESC`, siteParams);
  const [byPurpose] = await db.query(`SELECT COALESCE(mu.purpose,'operasional') purpose,COUNT(*) entries,SUM(mu.qty) qty,SUM(mu.qty*i.purchase_price) value
    FROM material_usages mu JOIN inventory_items i ON i.id=mu.item_id LEFT JOIN sites s ON s.id=mu.site_id
    WHERE mu.used_at>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)${siteSql} GROUP BY purpose ORDER BY value DESC`, siteParams);
  const anomalies = await findAnomalies(items, { site });
  return {
    categories, heatmap: { sites: siteNames, categories: catNames, cells },
    weekly: { labels: weekly.map(w => w.label), in: weekly.map(w => n(w.in_qty)), out: weekly.map(w => n(w.out_qty)) },
    topUsed, bySite, byPurpose, anomalies,
    dead: items.filter(i => i.dead).sort((a, b) => b.value - a.value)
  };
}

// Anomali 30 hari: (1) stock keluar tanpa referensi, (2) pergerakan jauh di atas pola biasa
// (≥10 unit dan ≥3× pemakaian mingguan rata-rata), di luar pencatatan pemakaian material.
async function findAnomalies(items, { site = '' } = {}) {
  const avg = new Map(items.map(i => [i.id, i.avgDaily]));
  const params = [];
  let sql = `SELECT m.id,m.item_id,m.movement_type,m.qty,m.reference,m.notes,m.created_at,i.name item_name,i.unit,u.name user_name
    FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.user_id LEFT JOIN sites s ON s.id=i.site_id
    WHERE m.created_at>=DATE_SUB(CURDATE(),INTERVAL 30 DAY) AND (m.reference IS NULL OR m.reference NOT IN ('OPENING-STOCK'))`;
  if (site) { sql += ` AND s.code=?`; params.push(site); }
  sql += ` ORDER BY m.id DESC LIMIT 500`;
  const [rows] = await db.query(sql, params);
  const out = [];
  for (const m of rows) {
    const ref = String(m.reference || '').trim();
    const qty = n(m.qty);
    const weekly = (avg.get(m.item_id) || 0) * 7;
    if (m.movement_type === 'out' && !ref) out.push({ ...m, reason: 'Stock keluar tanpa referensi' });
    else if (m.movement_type !== 'in' && !ref.startsWith('USAGE-') && qty >= 10 && qty >= weekly * 3) out.push({ ...m, reason: m.movement_type === 'adjustment' ? 'Penyesuaian jumlah besar' : 'Stock keluar jauh di atas rata-rata' });
  }
  return out.slice(0, 50);
}

async function itemHistory(itemId, days = 90) {
  const [[item]] = await db.query(`SELECT i.*,COALESCE(ic.name,i.category) category_name,s.code site_code,sp.name supplier_name FROM inventory_items i LEFT JOIN inventory_categories ic ON ic.id=i.category_id LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id WHERE i.id=? AND i.deleted_at IS NULL LIMIT 1`, [itemId]);
  if (!item) return null;
  const [enriched] = await enrichItems([item]);
  const [daily] = await db.query(`SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d,SUM(CASE WHEN movement_type='out' THEN qty ELSE 0 END) out_qty,SUM(CASE WHEN movement_type<>'out' THEN qty ELSE 0 END) in_qty FROM inventory_movements WHERE item_id=? AND created_at>=DATE_SUB(CURDATE(),INTERVAL ${days - 1} DAY) GROUP BY d`, [itemId]);
  const map = new Map(daily.map(r => [r.d, r]));
  const keys = dayKeys(days);
  const balance = new Array(keys.length), ins = [], outs = [];
  let bal = n(item.qty);
  for (let i = keys.length - 1; i >= 0; i--) {
    balance[i] = r2(bal);
    const v = map.get(keys[i]);
    if (v) bal = bal - n(v.in_qty) + n(v.out_qty);
  }
  keys.forEach(k => { const v = map.get(k); ins.push(n(v?.in_qty)); outs.push(n(v?.out_qty)); });
  const [movements] = await db.query(`SELECT m.*,u.name user_name FROM inventory_movements m LEFT JOIN users u ON u.id=m.user_id WHERE m.item_id=? ORDER BY m.id DESC LIMIT 100`, [itemId]);
  const [usages] = await db.query(`SELECT mu.*,c.name customer_name,t.ticket_code,s.code site_code,u.name used_by_name FROM material_usages mu LEFT JOIN customers c ON c.id=mu.customer_id LEFT JOIN tickets t ON t.id=mu.ticket_id LEFT JOIN sites s ON s.id=mu.site_id LEFT JOIN users u ON u.id=mu.used_by WHERE mu.item_id=? ORDER BY mu.id DESC LIMIT 50`, [itemId]);
  return { item: enriched, chart: { labels: keys.map(k => k.slice(5)), balance, ins, outs }, movements, usages };
}

// Ringkasan WhatsApp harian untuk tim gudang.
async function buildDigest() {
  const items = await enrichItems(await loadItems());
  const sum = summarize(items);
  const lines = sum.actionList.slice(0, 12).map((i, idx) => `${idx + 1}. ${i.status === 'critical' ? '🔴' : i.status === 'low' ? '🟠' : '🟡'} ${i.name}${i.site_code ? ` (${i.site_code})` : ''} — sisa *${i.qty} ${i.unit || ''}*${i.min_stock ? ` / min ${i.min_stock}` : ''} · ${daysLeftLabel(i)}`);
  const WEB_URL = String(process.env.APP_URL || '').replace(/\/+$/, '');
  const message = `📦 *RINGKASAN STOCK GUDANG*\n${new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' }).format(new Date())}\n\n• Kesehatan stock: *${sum.health}%*\n• Critical: *${sum.counts.critical}* · Low: *${sum.counts.low}* · Akan habis ≤${SOON_DAYS} hari: *${sum.counts.soon}*\n• Dead stock: *${sum.counts.dead}* item\n${lines.length ? `\n*Perlu tindakan:*\n${lines.join('\n')}${sum.actionList.length > 12 ? `\n… +${sum.actionList.length - 12} item lain` : ''}\n` : '\n✅ Semua stock aman.\n'}${WEB_URL ? `\nSaran pembelian:\n${WEB_URL}/inventory/reorder` : ''}`;
  return { message, summary: sum };
}

function digestRecipients() {
  const raw = String(process.env.WA_OP_WAREHOUSE_PHONE || process.env.WA_OP_SPV_PHONE || '');
  return [...new Set(raw.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean))];
}

async function sendStockDigest({ force = false } = {}) {
  const recipients = digestRecipients();
  if (!recipients.length) return { sent: 0, reason: 'Nomor WA_OP_WAREHOUSE_PHONE / WA_OP_SPV_PHONE belum diisi di .env' };
  const { message, summary } = await buildDigest();
  if (!force && !summary.actionList.length) return { sent: 0, reason: 'Tidak ada stock yang perlu tindakan' };
  const { enqueueWaMessage } = require('./whatsappGatewayService');
  let sent = 0;
  for (const phone of recipients) {
    const result = await enqueueWaMessage({ phone, message, type: 'manual' });
    if (result?.status !== 'failed') sent++;
  }
  return { sent, recipients: recipients.length };
}

async function dashboardWidget() {
  const items = await enrichItems(await loadItems());
  const sum = summarize(items);
  const [[week]] = await db.query(`SELECT COALESCE(SUM(qty),0) qty,COUNT(*) entries FROM material_usages WHERE used_at>=DATE_SUB(CURDATE(),INTERVAL 6 DAY)`);
  return { health: sum.health, counts: sum.counts, value: sum.value, top: sum.actionList.slice(0, 3).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, status: i.status, label: daysLeftLabel(i) })), weekUsage: n(week?.qty), weekEntries: n(week?.entries) };
}

module.exports = {
  USAGE_WINDOW, DEAD_DAYS, SOON_DAYS,
  loadItems, enrichItems, summarize, reorderSuggestions, recentActivity, analytics, findAnomalies, itemHistory,
  sparkSvg, daysLeftLabel, stockStatus, buildDigest, sendStockDigest, dashboardWidget
};
