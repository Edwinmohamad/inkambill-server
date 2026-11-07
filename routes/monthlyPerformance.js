const express = require('express');
const db = require('../config/db');
const { getMonthlyPerformance } = require('../services/monthlyPerformanceService');
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const y = Number(req.query.year), m = Number(req.query.month);
    const year = Number.isInteger(y) && y >= 2020 && y <= 2100 ? y : now.getFullYear();
    const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : (year === now.getFullYear() ? now.getMonth() + 1 : 12);
    const data = await getMonthlyPerformance(db, { year, month });
    res.render('performa/index', { title: 'Performa Bulanan', perf: data });
  } catch (err) { next(err); }
});

module.exports = router;
