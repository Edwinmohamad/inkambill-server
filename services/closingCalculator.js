const money = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
};

const personKey = (value) => {
  const name = String(value || '').trim().toLowerCase();
  if (name.includes('edwin')) return 'edwin';
  if (name.includes('jon') || name.includes('roni')) return 'jon';
  if (name.includes('bopung') || name.includes('eko')) return 'bopung';
  if (name.includes('ali')) return 'mang ali';
  return name;
};

const siteBlock = (...parts) => {
  const values = parts.map((part) => String(part || '').trim().toUpperCase());
  if (values.some((value) => value === 'KBG' || value.includes('KUBANG'))) return 'kbg';
  if (values.some((value) => value === 'CDS' || value === 'KRW' || value === 'CLM' || value.includes('CENTRAL DIGITAL'))) return 'krwclm';
  return 'other';
};

const clusterKey = (value) => {
  const cluster = String(value || '').trim().toUpperCase();
  return cluster === 'KRW' || cluster === 'CLM' ? cluster : 'LAINNYA';
};

const locationText = (row) => {
  let site = String(row.site_code || row.site_name || '-').trim().toUpperCase();
  if (site === 'KRW' || site === 'CLM') site = 'CDS';
  if (site === 'KUBANG' || site.includes('KUBANG')) site = 'KBG';
  if (site.includes('CENTRAL DIGITAL')) site = 'CDS';
  const cluster = String(row.cluster_name || '').trim();
  return cluster && site === 'CDS' ? `CDS / ${cluster}` : site;
};

// Shared site/cluster normalizer — dipakai baik oleh input manual (routes/closing.js)
// maupun sinkronisasi Data Kas (services/closingSyncService.js) supaya aturan
// pemetaan lokasi selalu konsisten di kedua mode.
const normalizeSiteCluster = (rawSite, rawCluster) => {
  const inputSite = String(rawSite || 'CDS').trim().toUpperCase();
  const inputCluster = String(rawCluster || '').trim().toUpperCase();
  const legacyCluster = inputSite === 'KRW' || inputSite === 'CLM' ? inputSite : '';
  const normalizedSite = inputSite === 'KUBANG' || inputSite.includes('KUBANG') ? 'KBG' : inputSite;
  const site = legacyCluster ? 'CDS' : normalizedSite;
  if (!['CDS', 'KBG'].includes(site)) return null;
  const cluster = site === 'CDS' && ['KRW', 'CLM'].includes(legacyCluster || inputCluster)
    ? (legacyCluster || inputCluster)
    : null;
  return { site, cluster };
};

// v2.6 — deteksi pendapatan PSB (uang masuk pemasangan baru) dari teks kategori,
// dipusatkan di sini supaya kalkulator, halaman web, dan PDF selalu pakai aturan
// yang sama. Kategori hasil sinkron Data Kas untuk PSB bernama persis
// "Pendapatan Pemasangan Baru" (lihat cash_categories kode PSB-IN di
// schemaService.js) — versi lama cuma mencocokkan /psb|pasang baru/i yang TIDAK
// PERNAH cocok dengan string itu ("pemasangan" beda ejaan dari "pasang"),
// sehingga pendapatan PSB selalu kebaur jadi satu dengan "Pembayaran pelanggan"
// biasa dan tidak pernah kelihatan sebagai baris/angka tersendiri. Sekarang juga
// mencocokkan "pemasangan" supaya kategori hasil sync maupun input manual
// ("PSB", "Pasang Baru", "Pemasangan Baru", dst) sama-sama terdeteksi.
const isPsbRevenue = (category) => /psb|pasang\s*baru|pemasangan/i.test(String(category || ''));

const mapAdd = (map, key, value) => map.set(key, (map.get(key) || 0) + money(value));

function buildClosingCalculation({ payments = [], expenses = [], heldCash = [], routerAssets = [], adjustments = [], closing = {}, mode = 'auto', lineItems = [] }) {
  const selectedMode = mode === 'manual' ? 'manual' : 'auto';
  const blocks = {
    krwclm: { label: 'CDS', revenue: 0, expense: 0, psbRevenue: 0, psbCount: 0, clusterRevenue: {}, clusterPsbRevenue: {}, clusterExpense: {}, clusterExpenseByCategory: {}, expenseByCategory: {}, shares: [] },
    kbg: { label: 'KBG', revenue: 0, expense: 0, psbRevenue: 0, psbCount: 0, clusterRevenue: {}, expenseByCategory: {}, shares: [] },
    other: { label: 'Lokasi belum dipetakan', revenue: 0, expense: 0, psbRevenue: 0, psbCount: 0, clusterRevenue: {}, expenseByCategory: {}, shares: [] }
  };

  payments.forEach((row) => {
    const blockKey = siteBlock(row.site_code, row.cluster_name, row.site_name);
    const amount = money(row.amount);
    blocks[blockKey].revenue += amount;
    // v2.6 — catat berapa dari pendapatan ini yang berasal dari PSB (pemasangan
    // baru) supaya bisa ditampilkan terpisah dari pendapatan langganan biasa.
    // Tidak mengubah blocks[blockKey].revenue (total tetap sama seperti
    // sebelumnya) — psbRevenue murni breakdown tambahan dari total itu.
    const rowIsPsb = isPsbRevenue(row.category);
    if (rowIsPsb) {
      blocks[blockKey].psbRevenue += amount;
      blocks[blockKey].psbCount += 1;
    }
    if (blockKey === 'krwclm') {
      const key = clusterKey(row.cluster_name || row.site_code);
      blocks[blockKey].clusterRevenue[key] = (blocks[blockKey].clusterRevenue[key] || 0) + amount;
      // v3.1 — breakdown PSB per cluster (dipakai kartu KRW/CLM terpisah di PDF),
      // sejajar dengan clusterRevenue di atas. Tidak mengubah clusterRevenue.
      if (rowIsPsb) blocks[blockKey].clusterPsbRevenue[key] = (blocks[blockKey].clusterPsbRevenue[key] || 0) + amount;
    }
  });

  expenses.forEach((row) => {
    const blockKey = siteBlock(row.site_code, row.site_name, row.cluster_name);
    const amount = money(row.amount);
    blocks[blockKey].expense += amount;
    const category = String(row.category || row.name || 'Lain-lain').trim() || 'Lain-lain';
    blocks[blockKey].expenseByCategory[category] = (blocks[blockKey].expenseByCategory[category] || 0) + amount;
    // v3.1 — pengeluaran CDS dulu tidak pernah dipecah per cluster (KRW/CLM),
    // cuma per kategori gabungan — jadi kategori seperti "Fee Sales" tidak
    // pernah kelihatan ada di cluster mana. Sekarang dicatat juga per cluster,
    // sejajar dengan clusterRevenue, supaya kartu KRW/CLM terpisah di PDF bisa
    // menampilkan rincian pengeluarannya sendiri-sendiri (lihat routes/closing.js
    // dan services/reportPdf.js). Tidak mengubah expenseByCategory gabungan di
    // atas — murni breakdown tambahan.
    if (blockKey === 'krwclm') {
      const key = clusterKey(row.cluster_name || row.site_code);
      blocks[blockKey].clusterExpense[key] = (blocks[blockKey].clusterExpense[key] || 0) + amount;
      const byCat = blocks[blockKey].clusterExpenseByCategory[key] || (blocks[blockKey].clusterExpenseByCategory[key] = {});
      byCat[category] = (byCat[category] || 0) + amount;
    }
  });

  // Keep old manual totals readable for legacy periods that have no detailed
  // rows yet. Once a period has closing_entries, the visible manual rows are
  // the single source of truth so hidden legacy fields cannot double count.
  // Field manual_revenue/manual_expense adalah sisa struktur lama (sebelum ada
  // closing_entries per baris). Berlaku di kedua mode selama belum ada baris
  // detail sama sekali, supaya periode lama yang belum diisi ulang tidak
  // mendadak kosong; begitu ada baris (manual atau hasil sync), baris itu jadi
  // satu-satunya sumber kebenaran.
  const hasDetailedManualRows = Array.isArray(lineItems) && lineItems.length > 0;
  if (!hasDetailedManualRows) {
    blocks.krwclm.revenue += money(closing.manual_revenue);
    blocks.krwclm.expense += money(closing.manual_expense);
    if (money(closing.manual_revenue)) blocks.krwclm.clusterRevenue.LAINNYA = (blocks.krwclm.clusterRevenue.LAINNYA || 0) + money(closing.manual_revenue);
    if (money(closing.manual_expense)) blocks.krwclm.expenseByCategory['Koreksi lama'] = (blocks.krwclm.expenseByCategory['Koreksi lama'] || 0) + money(closing.manual_expense);
  }

  Object.values(blocks).forEach((block) => {
    block.profit = block.revenue - block.expense;
    // v2.6 — sisa pendapatan di luar PSB (mis. langganan bulanan) supaya kedua
    // angka ini bisa ditampilkan berdampingan tanpa dihitung dua kali.
    block.subscriptionRevenue = block.revenue - block.psbRevenue;
  });
  // Carry-over saldo (mis. minus bulan lalu) adalah input manual terpisah dari
  // sumber pendapatan/pengeluaran, jadi selalu berlaku baik mode manual maupun
  // otomatis.
  blocks.krwclm.profit += money(closing.manual_carry);

  // Cash held belongs to the block where the transaction is installed. It must
  // never be applied to both CDS and KBG.
  // v1.29 — INVEST ROUTER auto-reward removed: router ownership no longer adds
  // Rp20.000/unit automatically. Any reward for owning a router now has to be
  // entered explicitly as a per-person adjustment (Langkah 3), same as any other
  // manual potongan/tambahan, so the paid-out "Bersih" always traces back to a
  // visible line the recipient can check instead of a hidden auto-calculation.
  const heldByBlock = new Map();
  heldCash.forEach((row) => {
    const blockKey = siteBlock(row.site_code, row.cluster_name, row.site_name);
    mapAdd(heldByBlock, `${blockKey}:${personKey(row.holder_name)}`, row.amount);
  });

  const salaryTotal = money(closing.manual_salary_agung) + money(closing.manual_salary_padilah);
  // Split in whole rupiah and assign the rounding remainder to Edwin so the
  // three deductions always reconcile exactly to the configured salary total.
  const salaryJon = money(salaryTotal * .25);
  const salaryBopung = money(salaryTotal * .25);
  const salaryByOwner = { edwin: salaryTotal - salaryJon - salaryBopung, jon: salaryJon, bopung: salaryBopung, 'mang ali': 0 };
  const adjustmentByBlock = new Map();
  adjustments.forEach((item) => {
    const recipient = personKey(item.recipient_name);
    if (!recipient) return;
    const blockKey = siteBlock(item.site_code || 'CDS');
    const signedAmount = String(item.direction || 'ADD').toUpperCase() === 'DEDUCT' ? -money(item.amount) : money(item.amount);
    mapAdd(adjustmentByBlock, `${blockKey}:${recipient}`, signedAmount);
  });

  const adjusted = (name, blockKey, gross, includeSalary = false) => {
    const key = personKey(name);
    let value = gross;
    value -= heldByBlock.get(`${blockKey}:${key}`) || 0;
    if (includeSalary && blockKey === 'krwclm') value -= salaryByOwner[key] || 0;
    value += adjustmentByBlock.get(`${blockKey}:${key}`) || 0;
    return money(value);
  };

  blocks.krwclm.shares = [
    { name: 'Edwin', percent: 50, gross: money(blocks.krwclm.profit * .50), amount: adjusted('Edwin', 'krwclm', blocks.krwclm.profit * .50, true) },
    { name: 'Jon', percent: 25, gross: money(blocks.krwclm.profit * .25), amount: adjusted('Jon', 'krwclm', blocks.krwclm.profit * .25, true) },
    { name: 'Bopung', percent: 25, gross: money(blocks.krwclm.profit * .25), amount: adjusted('Bopung', 'krwclm', blocks.krwclm.profit * .25, true) }
  ];

  const pool = blocks.kbg.profit * .65;
  // v1.29 — Jon & Bopung's blended percent-of-KBG-profit (11.791%) confused them
  // because it doesn't match the "18,14% dari pool" figure shown right next to it.
  // `displayPercent` lets the UI/PDF show the simpler pool-relative number for their
  // rows while keeping `percent` (blended) intact for anything that still needs it.
  blocks.kbg.shares = [
    { name: 'Edwin', percent: 41.418, gross: money(pool * .6372), amount: adjusted('Edwin', 'kbg', pool * .6372) },
    { name: 'Jon', percent: 11.791, displayPercent: 18.14, gross: money(pool * .1814), amount: adjusted('Jon', 'kbg', pool * .1814) },
    { name: 'Bopung', percent: 11.791, displayPercent: 18.14, gross: money(pool * .1814), amount: adjusted('Bopung', 'kbg', pool * .1814) },
    { name: 'Mang Ali', percent: 35, gross: money(blocks.kbg.profit * .35), amount: adjusted('Mang Ali', 'kbg', blocks.kbg.profit * .35) }
  ];

  return {
    mode: selectedMode,
    blocks,
    salaryTotal,
    salaryByOwner,
    salaryRows: [{ name: 'Agung', amount: money(closing.manual_salary_agung) }, { name: 'Padilah', amount: money(closing.manual_salary_padilah) }],
    adjustments,
    lineItems,
    manualApplied: selectedMode === 'manual'
  };
}

module.exports = { money, personKey, siteBlock, clusterKey, locationText, normalizeSiteCluster, isPsbRevenue, buildClosingCalculation };
