// Browser and OS facts the app needs before anything else, plus keep awake and update checks.

/** Can this browser run the app? Decided by the features we need, not by the name. */
export function browserCheck() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  const name = /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua) ? 'Safari'
    : brands.includes('Microsoft Edge') || /Edg\//.test(ua) ? 'Edge'
    : brands.includes('Google Chrome') ? 'Chrome'
    : brands.includes('Brave') ? 'Brave'
    : 'this browser';
  const hasBluetooth = 'bluetooth' in navigator;
  const hasFolders = 'showDirectoryPicker' in window;
  // Chrome 110 is the first that lets a page save inside ~/Library/CloudStorage, where Google
  // Drive for desktop lives on a Mac (Chromium CL 4034851). 122 adds "Allow on every visit".
  const major = Number((/(?:Chrome|Chromium)\/(\d+)/.exec(ua) || [])[1]) || null;
  const tooOld = major != null && major < 110;
  return {
    ok: hasBluetooth && hasFolders && window.isSecureContext && !tooOld,
    name, major, tooOld, hasBluetooth, hasFolders,
    remembersFolder: major != null && major >= 122,
    os: /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'other',
    // Enhancements that are behind a flag on macOS; used only when present.
    canGetDevices: typeof navigator.bluetooth?.getDevices === 'function',
    canWatchAds: typeof globalThis.BluetoothDevice?.prototype?.watchAdvertisements === 'function',
  };
}

/**
 * Bluetooth availability. false means no Bluetooth adapter the browser can use, which on a Mac is
 * usually "Bluetooth is switched off" and on some older Macs "no Bluetooth Low Energy".
 * Calls onChange(available) now and on every change.
 */
export async function watchBluetooth(onChange) {
  if (!navigator.bluetooth?.getAvailability) { onChange(false); return; }
  const report = async () => { try { onChange(await navigator.bluetooth.getAvailability()); } catch { onChange(false); } };
  navigator.bluetooth.addEventListener?.('availabilitychanged', (e) => onChange(!!e.value));
  await report();
}

/** Screen wake lock that comes back after the tab is shown again (the browser drops it when hidden). */
export function createWakeLock(onChange = () => {}) {
  let want = false, lock = null;
  const acquire = async () => {
    if (!want || lock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      onChange(true);
      lock.addEventListener('release', () => { lock = null; onChange(false); if (want) acquire(); });
    } catch { onChange(false); }
  };
  document.addEventListener('visibilitychange', acquire);
  return {
    start() { want = true; acquire(); },
    stop() { want = false; lock?.release(); lock = null; onChange(false); },
    get active() { return !!lock; },
  };
}

/**
 * Polls version.json and calls onNew(info) once when the live version differs from ours.
 * `info.files` (written by the release script) lets reloadFresh refetch every app file first,
 * because GitHub Pages caches files for 10 minutes and a plain reload could mix old and new.
 */
export function watchForUpdates(current, onNew, everyMs = 5 * 60 * 1000) {
  let told = false;
  const check = async () => {
    if (told) return;
    try {
      const info = await (await fetch('version.json', { cache: 'no-store' })).json();
      if (info.version && info.version !== current) { told = true; onNew(info); }
    } catch { /* offline: try again later */ }
  };
  setInterval(check, everyMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
}

export async function reloadFresh(info) {
  await Promise.all((info?.files || []).map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
  location.reload();
}
