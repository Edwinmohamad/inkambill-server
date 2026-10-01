'use strict';

const db = require('../config/db');

async function one(sql, params = {}, fallback = {}) {
  try {
    const [rows] = await db.execute(sql, Array.isArray(params) ? params : []);
    return rows[0] || fallback;
  } catch (_) {
    return fallback;
  }
}

async function rows(sql, params = []) {
  try {
    const [out] = await db.execute(sql, params);
    return out || [];
  } catch (_) {
    return [];
  }
}

async function getReconciliationIntelligence() {
  const [matched, unmatched, duplicates, mismatch, orphan, duplicateRows, mismatchRows] = await Promise.all([
    one(`SELECT COUNT(*) total
      FROM payments p JOIN invoices i ON i.id=p.invoice_id
      WHERE p.status='confirmed' AND p.method='cash' AND p.settlement_status='settled'`, [] , {total:0}),
    one(`SELECT COUNT(*) total,COALESCE(SUM(p.amount),0) amount
      FROM payments p JOIN invoices i ON i.id=p.invoice_id
      WHERE p.status='confirmed' AND p.method='cash' AND p.settlement_status='held_by_staff'`, [], {total:0,amount:0}),
    one(`SELECT COUNT(*) total FROM (
      SELECT p.invoice_id,p.amount,DATE(p.paid_at) paid_day
      FROM payments p
      WHERE p.status IN ('pending','confirmed') AND p.paid_at>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)
      GROUP BY p.invoice_id,p.amount,DATE(p.paid_at) HAVING COUNT(*)>1
    ) x`, [], {total:0}),
    one(`SELECT COUNT(*) total,COALESCE(SUM(ABS(difference_amount)),0) amount
      FROM cash_settlements
      WHERE ABS(COALESCE(difference_amount,0))>0
        AND settlement_date>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)`, [], {total:0,amount:0}),
    one(`SELECT COUNT(*) total
      FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id
      WHERE i.id IS NULL`, [], {total:0}),
    rows(`SELECT p.invoice_id,p.amount,DATE(p.paid_at) paid_day,COUNT(*) occurrences,
        MAX(i.invoice_number) invoice_number,MAX(c.name) customer_name
      FROM payments p
      LEFT JOIN invoices i ON i.id=p.invoice_id
      LEFT JOIN customers c ON c.id=i.customer_id
      WHERE p.status IN ('pending','confirmed') AND p.paid_at>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)
      GROUP BY p.invoice_id,p.amount,DATE(p.paid_at)
      HAVING COUNT(*)>1 ORDER BY occurrences DESC,paid_day DESC LIMIT 5`),
    rows(`SELECT cs.id,cs.code,cs.settlement_date,cs.total_amount,cs.handed_amount,cs.difference_amount,
        COALESCE(u.name,'Beberapa collector') collector_name
      FROM cash_settlements cs LEFT JOIN users u ON u.id=cs.collector_user_id
      WHERE ABS(COALESCE(cs.difference_amount,0))>0
        AND cs.settlement_date>=DATE_SUB(CURDATE(),INTERVAL 90 DAY)
      ORDER BY cs.settlement_date DESC,cs.id DESC LIMIT 5`)
  ]);

  const summary = {
    matched: Number(matched.total || 0),
    unmatched: Number(unmatched.total || 0),
    unmatchedAmount: Number(unmatched.amount || 0),
    duplicates: Number(duplicates.total || 0),
    nominalMismatch: Number(mismatch.total || 0),
    mismatchAmount: Number(mismatch.amount || 0),
    orphanPayments: Number(orphan.total || 0),
  };

  const suggestions = [];
  if (summary.unmatched) suggestions.push({
    tone:'warning', title:`${summary.unmatched} pembayaran cash belum direkonsiliasi`,
    detail:'Cocokkan setoran collector dari transaksi tertua terlebih dahulu.',
    href:'/payments/reconciliation#cashHeldTable'
  });
  duplicateRows.forEach(r => suggestions.push({
    tone:'danger', title:`Potensi pembayaran duplikat · ${r.invoice_number || '#'+r.invoice_id}`,
    detail:`${r.customer_name || 'Pelanggan'} · ${r.occurrences} transaksi nominal sama pada ${r.paid_day}.`,
    href:`/payments?q=${encodeURIComponent(r.invoice_number || r.invoice_id)}`
  }));
  mismatchRows.forEach(r => suggestions.push({
    tone:'warning', title:`Selisih setoran ${r.code || '#'+r.id}`,
    detail:`${r.collector_name} · selisih Rp${Number(r.difference_amount || 0).toLocaleString('id-ID')}.`,
    href:'/payments/reconciliation?tab=history'
  }));
  if (summary.orphanPayments) suggestions.push({
    tone:'danger', title:`${summary.orphanPayments} pembayaran tanpa invoice`,
    detail:'Perlu audit integritas relasi pembayaran ke invoice.',
    href:'/payments/reconciliation?tab=history'
  });

  return { summary, suggestions: suggestions.slice(0, 8) };
}

module.exports = { getReconciliationIntelligence };
