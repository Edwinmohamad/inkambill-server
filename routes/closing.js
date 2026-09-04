const express = require('express');

const router = express.Router();

// Placeholder page for the Closing module. Calculation features will be added
// only after the closing rules and data sources are finalized.
router.get('/', (req, res) => {
  res.render('closing/index', {
    title: 'Closing',
    pageTitle: 'Closing',
    pageSubtitle: 'Modul pembagian hasil sedang dipersiapkan.'
  });
});

module.exports = router;
