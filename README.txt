INKAMBILL - WA Broadcast Final Patch

Cara pakai:
1. Extract ZIP ini.
2. Copy folder "scripts" ke root repository inkambill-server.
3. Buka terminal di root repository.
4. Jalankan:
   node scripts/apply-wa-broadcast-filter-final.js

5. Validasi:
   node --check routes/waCrm.js
   node --check services/waBroadcastService.js
   node --check public/js/wa-broadcast.js
   npm run validate:final

6. Jika semua PASS, buka GitHub Desktop.
7. Review perubahan file.
8. Commit, contoh:
   feat: improve WhatsApp broadcast filters and audience segmentation
9. Push origin.

Patch akan membuat backup file otomatis dengan suffix .bak-TIMESTAMP.
