function asMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function buildPsbTerms({ isNewInstall, teamPayment, packagePrice, salesFlatCommission }) {
  const enabled = Boolean(isNewInstall);
  const distributed = enabled && String(teamPayment || '').toLowerCase() === 'yes';
  if (!enabled) {
    return { isNewInstall: 0, firstMonthFree: 0, teamPayment: 0, salesAmount: 0, technicianAmount: 0 };
  }

  const price = asMoney(packagePrice);
  const salesAmount = asMoney(salesFlatCommission);
  if (distributed && (price <= 0 || salesAmount < 0 || salesAmount > price)) {
    throw new Error('Pembagian pembayaran PSB tidak valid. Harga paket harus cukup untuk bagian sales dan teknisi.');
  }

  return {
    isNewInstall: 1,
    firstMonthFree: 1,
    teamPayment: distributed ? 1 : 0,
    salesAmount: distributed ? salesAmount : 0,
    technicianAmount: distributed ? price - salesAmount : 0
  };
}

function isPsbActivationPeriod(activationDate, year, monthIndex) {
  if (!activationDate) return false;
  const active = new Date(activationDate);
  return !Number.isNaN(active.getTime()) && active.getFullYear() === Number(year) && active.getMonth() === Number(monthIndex);
}

module.exports = { buildPsbTerms, isPsbActivationPeriod };
