// Athlete and sensor registry. Polar sensors cannot be renamed, so the app maps each device ID to
// an athlete and a head position here. The file lives in the shared Sa7a folder so Mohammad can
// fill it in from his own computer; a copy is kept in IndexedDB for when the folder is not
// reachable. Its presence in a picked folder is also how setup recognises the shared folder
// (a web page cannot see a folder's full path).

import { kvGet, kvSet } from './storage/kv.js';

export const REGISTRY_FILE = 'sa7a_registry.json';
export const POSITIONS = ['left_ear', 'right_ear', 'forehead', 'back_of_head'];

export function emptyRegistry() {
  return { version: 1, athletes: [], sensors: [], updated: new Date().toISOString() };
}

function check(reg) {
  if (!reg || reg.version !== 1 || !Array.isArray(reg.athletes) || !Array.isArray(reg.sensors)) {
    throw new Error('The athlete list file is not in the expected format.');
  }
  return reg;
}

/** Read from the save folder if possible, else the local copy. Returns { reg, source }. */
export async function loadRegistry(folder) {
  if (folder) {
    try {
      const fh = await folder.getFileHandle(REGISTRY_FILE);
      const reg = check(JSON.parse(await (await fh.getFile()).text()));
      await kvSet('registry', reg);
      return { reg, source: 'folder' };
    } catch (e) {
      if (e.name !== 'NotFoundError' && e.name !== 'NotAllowedError') console.warn('registry:', e);
    }
  }
  const local = await kvGet('registry');
  return local ? { reg: check(local), source: 'local' } : { reg: emptyRegistry(), source: 'new' };
}

export async function saveRegistry(folder, reg) {
  reg.updated = new Date().toISOString();
  await kvSet('registry', reg);
  if (!folder) return false;
  const w = await (await folder.getFileHandle(REGISTRY_FILE, { create: true })).createWritable();
  try { await w.write(JSON.stringify(reg, null, 1)); await w.close(); } catch (e) { try { await w.abort(); } catch { /* closed */ } throw e; }
  return true;
}

/** Device ID from the BLE name, e.g. "Polar Sense C8A1B2E4" -> "C8A1B2E4". */
export function deviceIdFromName(name) {
  const m = /^Polar Sense\s+([0-9A-F]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toUpperCase() : null;
}

export function sensorInfo(reg, deviceId) {
  const s = reg.sensors.find((x) => x.deviceId === deviceId) || null;
  const a = s && reg.athletes.find((x) => x.id === s.athleteId) || null;
  return { sensor: s, athlete: a };
}

export function upsertSensor(reg, deviceId, patch) {
  let s = reg.sensors.find((x) => x.deviceId === deviceId);
  if (!s) { s = { deviceId, athleteId: null, position: null, sticker: deviceId.slice(-4), mode: 'polar' }; reg.sensors.push(s); }
  Object.assign(s, patch);
  if (s.position && !POSITIONS.includes(s.position)) throw new Error(`Unknown head position ${s.position}.`);
  return s;
}

export function upsertAthlete(reg, patch) {
  let a = patch.id && reg.athletes.find((x) => x.id === patch.id);
  if (!a) {
    // Time plus randomness: two athletes added in the same millisecond must not share an id.
    let id; do { id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; } while (reg.athletes.some((x) => x.id === id));
    a = { id, name: '', maxHr: null, birthYear: null }; reg.athletes.push(a);
  }
  Object.assign(a, patch);
  return a;
}

/** Max HR from the registry, or 220 minus age when only the birth year is known. */
export function maxHrOf(athlete, today = new Date()) {
  if (!athlete) return null;
  if (athlete.maxHr) return athlete.maxHr;
  if (athlete.birthYear) return 220 - (today.getFullYear() - athlete.birthYear);
  return null;
}

/** 0 = below zone 1, 1..5 = zones at 50/60/70/80/90 % of max, null = no max known or no HR. */
export function zoneOf(hr, maxHr) {
  if (!maxHr || hr == null || !Number.isFinite(hr)) return null;
  const p = hr / maxHr;
  return p < 0.5 ? 0 : p < 0.6 ? 1 : p < 0.7 ? 2 : p < 0.8 ? 3 : p < 0.9 ? 4 : 5;
}
