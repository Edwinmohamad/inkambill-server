# Rekonsiliasi Cash — Lanjutan

Schema baru otomatis dibuat saat server start (`ensureV53Schema`): tabel `cash_settlements`,
`cash_settlement_cancellations`, kolom `payments.settlement_id`, dan pengaturan di `settings`.

| Fitur | Lokasi |
|------|--------|
| Umur cash di tim (kolom Umur, kartu "Lewat N Hari", filter `?aging=overdue`, umur tertua per collector) | Rekonsiliasi → Belum Disetor |
| Pengingat harian (≥ 08:00 WIB) ke admin & collector untuk cash lewat batas hari; batas diatur Master Admin | cron 30 menit, `services/cashSettlementService.js` |
| Nomor setoran per batch `STR-YYYYMMDD-000123` + tanda terima PDF dengan kotak tanda tangan | semua konfirmasi setoran; `/payments/settlements/:id/receipt.pdf` |
| Batalkan setoran per transaksi atau per batch (Master Admin, wajib alasan; jurnal Data Kas dihapus, baris Closing sinkron di-exclude; ditolak di periode terkunci) | Histori & Status Setoran |
| Setor per Collector: nominal yang diserahkan dicocokkan FIFO ke transaksi tertua yang muat utuh; kelebihan dicatat sebagai selisih lebih | tombol di tabel Belum Disetor |
| Ringkasan per collector + Daftar Setoran | Histori & Status Setoran |
| Cash Saya (setiap user): cash di tangan + umur, menunggu approval, riwayat & tanda terima setoran sendiri | `/my-cash`, menu GO & sidebar |
| Tanda terima WhatsApp otomatis setelah approval (default nonaktif; cash saja / semua metode; template) | WA Gateway → Tanda Terima Pembayaran |

Perbaikan terkait: koreksi metode transfer/QRIS → cash sebelumnya selalu gagal (`paidDate is not defined`).
