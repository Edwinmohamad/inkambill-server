// Upload guard (v1.33): foto bukti dari kamera HP biasanya 4-12 MB, sedangkan server menolak
// bukti di atas 6 MB (multer LIMIT_FILE_SIZE) lalu redirect ke /payments sehingga isian form hilang.
// Script ini mengecilkan foto di perangkat SEBELUM listener halaman lain menerima event `change`,
// jadi modal pembayaran, upload bukti massal, kas, cicilan, ticket, dan piket otomatis memakai
// file yang sudah kecil. PDF tidak diubah; PDF di atas batas langsung ditolak dengan pesan jelas.
// Input bisa keluar dari aturan ini dengan atribut data-no-compress (mis. logo invoice PNG).
(() => {
  if (typeof DataTransfer !== 'function' || !window.HTMLCanvasElement) return;
  const MAX_DIMENSION = 1920;          // cukup tajam untuk membaca nominal & nomor referensi (OCR)
  const TARGET_BYTES = 1.5 * 1024 * 1024;
  const DEFAULT_LIMIT_MB = 6;
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const pending = new Set();
  const replaying = new WeakSet();

  const isImageInput = input => {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.hasAttribute('data-no-compress')) return false;
    const accept = String(input.accept || '').toLowerCase();
    return !accept || accept.includes('image/');
  };
  const limitBytes = input => (Number(input.dataset.maxMb) || DEFAULT_LIMIT_MB) * 1024 * 1024;
  const looksLikeImage = file => /^image\//i.test(file.type) || (!file.type && /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || ''));
  const mb = bytes => (bytes / 1024 / 1024).toFixed(1).replace('.', ',');

  let toastEl = null;
  const toast = (text) => {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:3000;background:#111827;color:#fff;padding:10px 16px;border-radius:12px;font:500 13px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:calc(100vw - 32px);text-align:center';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text || '';
    toastEl.hidden = !text;
  };

  const decode = file => {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => decodeWithImg(file));
    }
    return decodeWithImg(file);
  };
  const decodeWithImg = file => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak dapat dibaca perangkat.')); };
    img.src = url;
  });
  const toBlob = (canvas, quality) => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));

  async function shrink(file) {
    const source = await decode(file);
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (!width || !height) throw new Error('Ukuran foto tidak valid.');
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (typeof source.close === 'function') source.close();
    let quality = 0.82;
    let blob = await toBlob(canvas, quality);
    while (blob && blob.size > TARGET_BYTES && quality > 0.5) {
      quality -= 0.12;
      blob = await toBlob(canvas, quality);
    }
    // Lepaskan memori canvas segera; WebView di HP murah mudah kehabisan RAM.
    canvas.width = 0; canvas.height = 0;
    if (!blob) throw new Error('Foto gagal dikompres.');
    const base = String(file.name || 'bukti').replace(/\.[^.]+$/, '') || 'bukti';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  }

  function replay(input) {
    const event = new Event('change', { bubbles: true });
    replaying.add(event);
    input.dispatchEvent(event);
  }
  function reject(input, message) {
    input.value = '';
    toast('');
    alert(message);
    replay(input); // biar label nama file di halaman ikut kembali kosong
  }

  document.addEventListener('change', async event => {
    const input = event.target;
    if (replaying.has(event) || !isImageInput(input) || !input.files || !input.files.length) return;
    const limit = limitBytes(input);
    const files = [...input.files];
    const needsWork = files.some(file => looksLikeImage(file)
      ? (file.size > TARGET_BYTES || !ALLOWED.has(file.type))
      : file.size > limit);
    if (!needsWork) return;

    // Tahan event asli; halaman baru menerima `change` setelah file siap.
    event.stopImmediatePropagation();
    pending.add(input);
    input.setAttribute('aria-busy', 'true');
    toast('Mengecilkan foto bukti…');
    try {
      const out = [];
      for (const file of files) {
        if (!looksLikeImage(file)) {
          if (file.size > limit) return reject(input, `File "${file.name}" berukuran ${mb(file.size)} MB. Maksimal ${mb(limit)} MB. Kirim sebagai foto (JPG/PNG) atau PDF yang lebih kecil.`);
          out.push(file);
          continue;
        }
        if (file.size <= TARGET_BYTES && ALLOWED.has(file.type)) { out.push(file); continue; }
        try {
          const small = await shrink(file);
          out.push(small.size < file.size || !ALLOWED.has(file.type) ? small : file);
        } catch (error) {
          if (ALLOWED.has(file.type) && file.size <= limit) { out.push(file); continue; }
          return reject(input, `Foto "${file.name}" tidak dapat diproses (${error.message}). Coba ambil ulang foto atau pilih dari galeri.`);
        }
      }
      const tooBig = out.find(file => file.size > limit);
      if (tooBig) return reject(input, `File "${tooBig.name}" masih ${mb(tooBig.size)} MB setelah dikecilkan. Maksimal ${mb(limit)} MB.`);
      const transfer = new DataTransfer();
      out.forEach(file => transfer.items.add(file));
      input.files = transfer.files;
      toast('');
      replay(input);
    } finally {
      pending.delete(input);
      input.removeAttribute('aria-busy');
    }
  }, true);

  // Jangan biarkan form terkirim saat foto masih dikompres (file lama yang besar bisa ikut terkirim).
  document.addEventListener('submit', event => {
    const form = event.target;
    if (![...pending].some(input => input.form === form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('Tunggu sebentar, foto bukti masih diproses…');
    setTimeout(() => { if (!pending.size) toast(''); }, 2500);
  }, true);
})();
