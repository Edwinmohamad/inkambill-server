const PREFIX_BY_CATEGORY = [
  [/petty\s*cash|pettycash/i, 'PTC'], [/bandwidth|\bisp\b|internet/i, 'BW'],
  [/listrik|utilitas/i, 'LST'], [/gaji|honor/i, 'GJI'], [/transport/i, 'TRP'],
  [/maintenance|perawatan/i, 'MNT'], [/sewa/i, 'SWA'],
  [/pajak|administrasi/i, 'ADM'], [/vendor/i, 'VDR'], [/material|barang/i, 'MTL']
];

function clean(value) {
  return String(value || '').replace(/[_|]+/g, ' ').replace(/[^\p{L}\p{N}./&+\- ]/gu, '').replace(/\s+/g, ' ').trim();
}
function title(value) {
  return clean(value).split(' ').filter(Boolean).map((word) => {
    const quantity = word.match(/^(\d+)(pcs?|unit|buah)$/i);
    if (quantity) return `${quantity[1]}${quantity[2].charAt(0).toUpperCase()}${quantity[2].slice(1).toLowerCase()}`;
    if (/^(odp|ont|olt|isp|ups|mcb|ac|dc|lan|wan)$/i.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}
function prefix(code, name) {
  const mapped = PREFIX_BY_CATEGORY.find(([pattern]) => pattern.test(clean(name)));
  if (mapped) return mapped[1];
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'EXP';
}
function formatCashExpenseName({ categoryCode, categoryName, rawName, shopName, vendorName }) {
  const segments = String(rawName || '').split('_');
  const alreadyFormatted = segments.length >= 3 && /^[A-Z0-9]{2,8}$/.test(segments[0]);
  const description = title(alreadyFormatted ? segments.slice(1, -1).join(' ') : rawName).slice(0, 120);
  if (!description) throw new Error('Nama transaksi wajib diisi.');
  const source = title(vendorName || shopName || (alreadyFormatted ? segments.at(-1) : '') || 'Internal').replace(/\s+/g, '').slice(0, 60) || 'Internal';
  return `${prefix(categoryCode, categoryName)}_${description}_${source}`.slice(0, 255);
}

module.exports = { formatCashExpenseName };
