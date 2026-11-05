'use strict';

/*
 * Automatic proof scanning permanently disabled.
 *
 * Manual upload of payment proof remains available.
 * This compatibility module prevents old payment calls
 * from breaking the main billing application.
 */

const disabledResult = Object.freeze({
  ok: false,
  success: false,
  enabled: false,
  disabled: true,
  skipped: true,
  sender_name: null,
  amount: null,
  bank_name: null,
  transaction_date: null,
  reason: 'Automatic proof scanning removed'
});

const noop = async () => disabledResult;

const api = new Proxy(noop, {
  get(target, prop) {
    if (prop === 'then') return undefined;
    if (prop === 'enabled') return false;
    if (prop === 'disabled') return true;
    if (prop === 'SCANNABLE_METHODS') return new Set();
    if (prop === 'result') return disabledResult;

    return noop;
  },

  apply() {
    return Promise.resolve(disabledResult);
  }
});

module.exports = api;
