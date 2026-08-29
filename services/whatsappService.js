function normalizeWhatsapp(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`;
  return digits;
}

function validateWhatsapp(value) {
  const normalized = normalizeWhatsapp(value);
  if (!normalized) return { valid: false, normalized: null, reason: 'Nomor belum diisi' };
  if (!/^628[1-9]\d{7,11}$/.test(normalized)) {
    return { valid: false, normalized: null, reason: 'Format nomor Indonesia tidak valid' };
  }
  if (/(\d)\1{7,}/.test(normalized)) {
    return { valid: false, normalized: null, reason: 'Nomor berisi pola digit tidak wajar' };
  }
  return { valid: true, normalized, reason: 'Format WhatsApp Indonesia valid' };
}

module.exports = { normalizeWhatsapp, validateWhatsapp };
