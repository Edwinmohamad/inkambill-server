const { money, siteBlock, locationText, isPsbRevenue } = require('./closingCalculator');

// Amounts are cash actually included in Closing, never invoice face values.
// Receivables are shown separately and cannot enter the revenue total.
function buildRevenueSummaryRows(lineItems, unpaidCustomers, allowedBlocks) {
  const groups = new Map();
  for (const row of lineItems || []) {
    if (row.entry_type !== 'INCOME' || row.excluded_at || !allowedBlocks.has(siteBlock(row.site_code, row.cluster_name))) continue;
    const category = row.payment_id && !isPsbRevenue(row.cash_category || row.category)
      ? (row.invoice_status === 'paid' ? 'Pembayaran Pelanggan Lunas' : 'Pembayaran Pelanggan Sebagian')
      : String(row.cash_category || row.category || 'Lain-lain').trim();
    const location = locationText(row);
    const key = JSON.stringify([location, category]);
    if (!groups.has(key)) groups.set(key, { location, category, amount: 0, count: 0, kind: 'income' });
    const group = groups.get(key);
    group.amount += money(row.amount);
    group.count++;
  }
  const rows = [...groups.values()].sort((a, b) => a.location.localeCompare(b.location) || a.category.localeCompare(b.category, 'id'));
  rows.push({ category: 'Total Pendapatan Closing', location: 'Semua lokasi terpilih', amount: rows.reduce((sum, row) => sum + row.amount, 0), kind: 'total' });
  const pending = (unpaidCustomers || []).filter(row => allowedBlocks.has(siteBlock(row.site_code, row.cluster_name)));
  rows.push({ category: 'Pendingan Pelanggan Belum Lunas', location: 'Piutang jatuh tempo s/d akhir periode', amount: pending.reduce((sum, row) => sum + money(row.outstanding), 0), kind: 'receivable', count: pending.length });
  return rows;
}

module.exports = { buildRevenueSummaryRows };
