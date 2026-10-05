import sys,json,hashlib,shutil,datetime,subprocess
from pathlib import Path
source=Path(__file__).resolve().parent
if len(sys.argv)!=2:sys.exit('Pakai: python3 INSTALL.py /path/inkambill-server')
target=Path(sys.argv[1]).resolve()
if not (target/'app.js').is_file():sys.exit('Folder aplikasi tidak valid: app.js tidak ditemukan.')
manifest=json.loads((source/'manifest.json').read_text())
for name,hashes in manifest.items():
 p=target/name
 if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() not in hashes:
  sys.exit('Versi file berbeda, pemasangan dibatalkan tanpa perubahan: '+name)
if not shutil.which('node'):sys.exit('Node.js diperlukan untuk validasi sebelum pemasangan.')
for name in manifest:
 if name.endswith('.js'):subprocess.run(['node','--check',str(source/'payload'/name)],check=True)
backup=target.parent/('closing-backup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
for name in manifest:
 p=target/name
 if p.exists():
  b=backup/name;b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,b)
try:
 for name in manifest:
  p=target/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/'payload'/name,p)
 for test in ['test-closing-calculator.js','test-closing-sync.js','test-closing-report-data.js','test-closing-report-integrity.js','test-report-center-integrity.js','test-invoice-refresh.js','test-cash-payment-method-filter.js','test-cash-settlement-journal.js']:
  subprocess.run(['node','scripts/'+test],cwd=target,check=True)
except Exception:
 for name in manifest:
  b=backup/name;p=target/name
  if b.exists():shutil.copy2(b,p)
  else:p.unlink(missing_ok=True)
 raise
print('Patch terpasang dan tes lulus. Backup:',backup)
print('Rebuild/restart aplikasi menggunakan prosedur deployment Anda, lalu export PDF baru.')
