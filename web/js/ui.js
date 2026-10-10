// Small UI helpers shared by the app modules.

let toastTimer;
export function toast(msg, bad = false, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, ms);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** In-page replacement for confirm()/prompt(). Resolves true/false, or the text (null on cancel). */
export function ask(message, { input = null, ok = 'OK', cancel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask';
    dlg.innerHTML = `<p>${esc(message)}</p>${input !== null ? `<input id="askInput" value="${esc(input)}">` : ''}
      <div class="row"><span class="grow"></span><button data-v="0">${esc(cancel)}</button><button data-v="1" class="primary">${esc(ok)}</button></div>`;
    document.body.appendChild(dlg);
    const field = dlg.querySelector('input');
    const done = (v) => { dlg.close(); dlg.remove(); resolve(input !== null ? (v ? field.value : null) : v); };
    dlg.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => done(b.dataset.v === '1')));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    if (field) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
    dlg.showModal();
    (field || dlg.querySelector('[data-v="1"]')).focus();
    if (field) field.select();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ------------------------------------------------------------------ saving
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal zip (stored, no compression) of {name: Uint8Array}. */
export function zip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nb = enc.encode(name);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nb.length, true);
    local.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...local, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

let hostDownloads; // undefined = not checked yet
async function hostSaver() {
  if (hostDownloads !== undefined) return hostDownloads;
  hostDownloads = null;
  if (window.claude?.use) {
    try { hostDownloads = await window.claude.use('downloads'); } catch { hostDownloads = null; }
  }
  return hostDownloads;
}

/**
 * Save a file to the user's computer. Inside the claude.ai viewer the host's
 * download prompt is used (STEP files go inside a .zip there); elsewhere a
 * normal browser download.
 * @returns the filename actually offered, or null if the user declined.
 */
export async function saveFile(filename, data, type = 'application/octet-stream') {
  const host = await hostSaver();
  if (host) {
    let name = filename;
    let payload = data;
    if (!/\.(json|csv|txt|zip|html)$/i.test(name)) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === 'string' ? new TextEncoder().encode(data) : data;
      payload = zip({ [filename]: bytes });
      name = `${filename}.zip`;
    }
    try {
      await host.save({ filename: name, data: payload instanceof Blob ? payload : new Blob([payload], { type }) });
      return name;
    } catch (e) {
      if (e?.code === 'declined') return null;
      throw new Error(e?.message || 'The download was refused');
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return filename;
}
