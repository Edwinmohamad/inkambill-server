const fs=require('fs');
const css=fs.readFileSync('public/css/app.css','utf8');
function requireToken(token){if(!css.includes(token))throw new Error(`Responsive CSS missing: ${token}`);}
[
  '@media (max-width:1400px)',
  '@media (max-width:1180px)',
  '@media (max-width:900px)',
  '@media (max-width:600px)',
  '.psb-hero-v119{grid-template-columns:1fr',
  '.site-condition-grid{grid-template-columns:1fr',
  '.analytics-filter{grid-template-columns:1fr 1fr',
  '.odp-heatmap{grid-template-columns:1fr}',
  '.infra-hub-shell{display:block',
  '.infra-frame-wrap,.infra-frame-wrap iframe{min-height:560px}',
  '.cash-approval-item{grid-template-columns:1fr}',
  '.dashboard-user-ticker{grid-template-columns:1fr}'
].forEach(requireToken);
console.log('Responsive CSS validation OK: desktop/tablet/mobile breakpoints and critical Dashboard/Analytics/Infrastructure/Approval stacking rules are present.');
