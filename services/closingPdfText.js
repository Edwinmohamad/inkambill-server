'use strict';

// Presentation only: stored transaction descriptions and accounting data stay intact.
function cleanClosingDescription(value) {
  return String(value ?? '').trim()
    .replace(/\bData\s+Kas\s*\(\s*(?:sinkron|singkron)\s+otomatis\s*\)/gi, '')
    .replace(/\(\s*(?:sinkron|singkron)\s+otomatis\s*\)/gi, '')
    .replace(/(?:^|[·|\n])\s*(?:Data Closing|Input manual|Data Kas)\s*(?=$|[·|\n])/gi, '')
    .replace(/^(?:PTC|BILL|SETOR)_+/i, '')
    .replace(/_/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').replace(/(?:\s*[·|]\s*)+/g, ' · ').replace(/^[\s·|]+|[\s·|]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

module.exports = { cleanClosingDescription };
