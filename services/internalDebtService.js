// v1.30 -- Hutang Internal (karyawan/teknisi) untuk Closing & PDF.
//
// Murni INFORMASI: hasil fungsi ini tidak pernah dimasukkan ke buildClosingCalculation,
// jadi tidak bisa mengubah Pendapatan/Pengeluaran/Bersih (sama seperti "Pelanggan belum
// lunas"). Tujuannya supaya saat closing kelihatan jelas: teknisi mana yang masih punya
// hutang ke kantor, berapa yang baru dipinjam di periode ini, berapa yang sudah dicicil,
// dan rincian barang/keperluannya.
const db = require('../config/db');

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : 0; };
const JKT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
// mysql2 (timezone +07:00) mengembalikan kolom DATE sebagai Date tengah malam WIB;
// diformat ulang di zona Asia/Jakarta supaya tidak mundur sehari di server ber-TZ UTC.
const dk = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : JKT.format(d);
};

/**
 * @param {{start:string,end:string,sites?:string[]}} opts
 *   sites -- site_code yang boleh tampil (mis. ['KBG'] untuk PDF Mang Ali). Default semua.
 */
async function loadInternalDebtSummary({ start, end, sites = null }) {
  const empty = { people: [], summary: { people: 0, records: 0, receivableBalance: 0, debtBalance: 0, newInPeriod: 0, paidInPeriod: 0 } };
  try {
    const params = [end];
    let siteSql = '';
    if (Array.isArray(sites) && sites.length) { siteSql = ` AND d.site_code IN (${sites.map(() => '?').join(',')})`; params.push(...sites); }
    const [records] = await db.execute(`SELECT d.id,d.record_type,d.party_name,d.employee_id,d.user_id,d.purpose,d.site_code,d.principal_amount,
        d.issue_date,d.due_date,d.payment_method,d.installment_months,d.status,d.notes,
        e.name employee_name,e.employee_code,p.name position_name,u.username
      FROM finance_debts d
      LEFT JOIN employees e ON e.id=d.employee_id
      LEFT JOIN positions p ON p.id=e.position_id
      LEFT JOIN users u ON u.id=d.user_id
      WHERE d.scope='INTERNAL' AND d.status<>'ARCHIVED' AND d.issue_date<=?${siteSql}
      ORDER BY d.issue_date,d.id`, params);
    if (!records.length) return empty;
    const ids = records.map((r) => Number(r.id));
    const ph = ids.map(() => '?').join(',');
    const [payments] = await db.execute(`SELECT id,debt_id,payment_date,amount,payment_method,notes FROM finance_debt_payments WHERE debt_id IN (${ph}) AND payment_date<=? ORDER BY payment_date,id`, [...ids, end]);
    const [items] = await db.execute(`SELECT debt_id,item_name,quantity,unit_price,notes FROM finance_debt_items WHERE debt_id IN (${ph}) ORDER BY debt_id,id`, ids);
    const payBy = new Map(); payments.forEach((p) => { const k = Number(p.debt_id); if (!payBy.has(k)) payBy.set(k, []); payBy.get(k).push(p); });
    const itemBy = new Map(); items.forEach((i) => { const k = Number(i.debt_id); if (!itemBy.has(k)) itemBy.set(k, []); itemBy.get(k).push(i); });

    const people = new Map();
    const summary = { ...empty.summary };
    records.forEach((r) => {
      const principal = n(r.principal_amount);
      const issue = dk(r.issue_date);
      const pays = (payBy.get(Number(r.id)) || []).map((p) => ({ date: dk(p.payment_date), amount: n(p.amount), method: p.payment_method || 'cash', notes: p.notes || '' }));
      const paidBefore = pays.filter((p) => p.date < start).reduce((a, p) => a + p.amount, 0);
      const periodPays = pays.filter((p) => p.date >= start && p.date <= end);
      const paidInPeriod = periodPays.reduce((a, p) => a + p.amount, 0);
      const isNew = issue >= start && issue <= end;
      const opening = isNew ? 0 : Math.max(0, principal - paidBefore);
      const newAmount = isNew ? principal : 0;
      const balance = Math.max(0, principal - paidBefore - paidInPeriod);
      // Hutang yang sudah lunas sebelum periode ini & tidak ada aktivitas -> tidak perlu tampil.
      if (!balance && !isNew && !paidInPeriod) return;
      const key = r.employee_id ? `e${r.employee_id}` : `n${String(r.party_name || '').trim().toLowerCase()}`;
      if (!people.has(key)) people.set(key, {
        key, employeeId: r.employee_id || null, name: r.employee_name || r.party_name, code: r.employee_code || '', position: r.position_name || '', username: r.username || '',
        records: [], opening: 0, newAmount: 0, paidInPeriod: 0, balance: 0, owedToOffice: 0, owedByOffice: 0
      });
      const person = people.get(key);
      const direction = r.record_type === 'RECEIVABLE' ? 'TO_OFFICE' : 'BY_OFFICE';
      person.records.push({
        id: r.id, direction, purpose: r.purpose, site: r.site_code, issueDate: issue, dueDate: dk(r.due_date),
        method: r.payment_method, months: Number(r.installment_months || 1), notes: r.notes || '',
        principal, opening, newAmount, paidInPeriod, balance, isNew,
        overdue: balance > 0 && r.due_date && dk(r.due_date) < end,
        items: (itemBy.get(Number(r.id)) || []).map((i) => ({ name: i.item_name, qty: Number(i.quantity), price: n(i.unit_price), subtotal: Math.round(Number(i.quantity) * Number(i.unit_price)), notes: i.notes || '' })),
        payments: periodPays
      });
      person.opening += opening; person.newAmount += newAmount; person.paidInPeriod += paidInPeriod; person.balance += balance;
      if (direction === 'TO_OFFICE') person.owedToOffice += balance; else person.owedByOffice += balance;
      summary.records += 1; summary.newInPeriod += newAmount; summary.paidInPeriod += paidInPeriod;
      if (direction === 'TO_OFFICE') summary.receivableBalance += balance; else summary.debtBalance += balance;
    });
    const list = [...people.values()].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    summary.people = list.length;
    return { people: list, summary };
  } catch (err) {
    console.error('Gagal memuat hutang internal untuk Closing:', err.message);
    return empty;
  }
}

// Baris datar untuk PDF: satu baris per rincian (item / pembayaran), dikelompokkan per teknisi.
function buildInternalDebtPdfRows(internal) {
  return (internal?.people || []).map((person) => ({
    name: person.name,
    meta: [person.code, person.position].filter(Boolean).join(' · '),
    opening: person.opening, newAmount: person.newAmount, paidInPeriod: person.paidInPeriod, balance: person.balance,
    owedToOffice: person.owedToOffice, owedByOffice: person.owedByOffice,
    records: person.records
  }));
}

module.exports = { loadInternalDebtSummary, buildInternalDebtPdfRows };
