// Connecting sensors: the chooser (Chrome's, or the simulator's), naming a new sensor, and the
// SensorLink per device. Packets go straight to the capture worker.
import T from '../strings/en.js';
import { SensorLink, chooseSensor } from '../core/ble/device.js';
import { deviceIdFromName, upsertSensor, upsertAthlete, saveRegistry, POSITIONS } from '../core/registry.js';
import { S, emit, newData, rxOf, now, infoOf, log } from './state.js';
import { toast, say, modal, esc, headSVG, $$ } from './ui.js';

let worker = null, radio = null;
export function initLinks(w, simRadio) { worker = w; radio = simRadio; if (radio) radio.onChooser = simChooser; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Registry changes are saved to the Sa7a folder (except in sim mode, where nothing is saved). */
export async function persistRegistry() {
  if (S.sim) return;
  try { await saveRegistry(S.folder.permission === 'granted' ? S.folder.handle : null, S.reg); }
  catch (e) { log('error', `registry save: ${e.message}`); toast('The athlete list could not be saved to the Sa7a folder. It is kept on this Mac for now.'); }
}

/**
 * Connect button. The hint shows first; Chrome's chooser opens 1.2 s later, well inside the 5 s a
 * click keeps its permission to open it.
 */
export async function connect(slotId = null) {
  toast(T.connect.hint + (slotId ? ` This one is ${slotId.slice(-4)}.` : ''), 6000);
  await sleep(1200);
  let device;
  try { device = await (radio ? radio.requestDevice() : chooseSensor()); } catch (e) {
    const m = String(e?.message || '');
    toast(say(e?.name === 'NotFoundError' && /adapter|not available/i.test(m) ? T.errors.btOff : e?.name === 'SecurityError' ? T.errors.blocked : T.errors.noPick));
    return;
  }
  const id = deviceIdFromName(device.name);
  if (!id) { toast(say(T.errors.notPolar)); return; }
  if (slotId && id !== slotId && !infoOf(id).sensor) {
    const keep = infoOf(slotId);
    if (keep.sensor && await confirmSwap(slotId, id)) {
      upsertSensor(S.reg, id, { athleteId: keep.sensor.athleteId, position: keep.sensor.position, mode: keep.sensor.mode });
      S.reg.sensors = S.reg.sensors.filter((s) => s.deviceId !== slotId);
      await persistRegistry();
    }
  } else if (slotId && id !== slotId) {
    toast(`That was sensor ${id.slice(-4)}. It is connected in its own slot.`);
  }
  if (!infoOf(id).sensor) await nameSensor(id);
  start(device, id);
}

function start(device, id) {
  let e = S.links.get(id);
  if (e && e.device === device && e.link.state !== 'disconnected') { e.link.run(e.link.failedAt).catch(() => {}); return; }
  const info = infoOf(id);
  e = { id, device, mode: info.sensor?.mode || 'polar', data: newData(), stats: {}, streams: {}, linkState: null, streamingSince: null };
  e.link = new SensorLink(device, {
    mode: e.mode,
    onPacket: (kind, bytes, rxMs) => worker.postMessage({ type: 'packet', id, kind, rx: rxOf(rxMs), bytes: bytes.buffer }, [bytes.buffer]),
    onStream: (key, cfg) => { e.streams[key] = cfg; worker.postMessage({ type: 'stream', id, key, cfg }); },
    onState: (st) => {
      const was = e.linkState?.state;
      e.linkState = st; e.mode = st.mode;
      if (st.state === 'streaming' && was !== 'streaming') e.streamingSince = now();
      if (st.state !== was) { worker.postMessage({ type: 'link', id, state: st.state, rx: now(), error: st.error }); log('link', `${id} ${st.state}${st.error ? ' ' + st.error.code : ''}`); }
      emit('link');
    },
  });
  S.links.set(id, e);
  tellWorker(id);
  emit('links');
  e.link.run().catch(() => { /* the slot shows the error and a Retry button */ });
}

export function tellWorker(id) {
  const e = S.links.get(id); if (!e) return;
  const { sensor, athlete } = infoOf(id);
  worker.postMessage({ type: 'device', id, athlete: athlete?.name, athleteId: athlete?.id ?? null, position: sensor?.position ?? null, mode: e.mode });
}

export function retry(id) { const e = S.links.get(id); if (e) e.link.retry().catch(() => {}); }
export async function reconnect(id) { const e = S.links.get(id); if (e) e.link.run('connected').catch(() => {}); }
export async function disconnect(id) { const e = S.links.get(id); if (e) await e.link.disconnect(); emit('links'); }
export async function disconnectAll() { for (const e of S.links.values()) await e.link.disconnect().catch(() => {}); }
export async function setMode(id, mode) {
  const e = S.links.get(id); if (!e) return;
  upsertSensor(S.reg, id, { mode }); await persistRegistry();
  e.link.setMode(mode).catch(() => {});
}

// ---------- dialogs ----------
function simChooser(list) {
  modal(`<h2>Pick a sensor</h2><p class="dim">Simulated sensors. In the real app Chrome shows this list.</p>
    <div class="choices">${list.map((d) => `<button class="choice" data-id="${d.id}"><b>${esc(d.name)}</b></button>`).join('') || '<p class="dim">Every simulated sensor is already connected.</p>'}</div>
    <div class="foot"><span class="spacer"></span><button class="btn" data-x>Cancel</button></div>`, (d, close) => {
    $$('[data-id]', d).forEach((b) => b.addEventListener('click', () => { close(); radio.choose(b.dataset.id); }));
    d.querySelector('[data-x]').addEventListener('click', () => { close(); radio.cancel(); });
  }).then((v) => { if (v === null) radio.cancel(); });
}

function confirmSwap(slotId, id) {
  const { athlete, sensor } = infoOf(slotId);
  return modal(`<h2>Different sensor</h2><p>This slot is for sticker <b>${slotId.slice(-4)}</b>, but you picked <b>${id.slice(-4)}</b>.</p>
    <p>Use ${id.slice(-4)} for ${esc(athlete?.name || 'this athlete')}, ${esc(T.positions[sensor?.position] || '')} from now on?</p>
    <div class="foot"><button class="btn primary" data-y>Yes, use ${id.slice(-4)}</button><button class="btn" data-n>No</button></div>`, (d, close) => {
    d.querySelector('[data-y]').addEventListener('click', () => close(true));
    d.querySelector('[data-n]').addEventListener('click', () => close(false));
  });
}

/** Who wears this sensor, and where. Saved to the athlete list so it is asked only once. */
export function nameSensor(id) {
  const athletes = S.reg.athletes;
  const cur = infoOf(id);
  let athleteId = cur.athlete?.id || null, position = cur.sensor?.position || null;
  return modal(`<h2>${cur.sensor ? 'Change athlete or position' : `New sensor ${id.slice(-4)}`}</h2>
    <p class="dim">${cur.sensor ? '' : T.connect.unknown}</p>
    <div class="field">Athlete<div class="choices" id="ath">${athletes.map((a) => `<button class="choice" data-a="${a.id}" aria-pressed="${a.id === athleteId}">${esc(a.name)}</button>`).join('')}</div>
      <input id="newName" placeholder="Or type a new athlete name" autocomplete="off"></div>
    <div class="field">Max heart rate, optional<input id="maxHr" inputmode="numeric" placeholder="For example 195" autocomplete="off"></div>
    <div class="field">Where on the head<div class="posgrid">${POSITIONS.map((p) => `<button class="choice" data-p="${p}" aria-pressed="${p === position}">${headSVG([p], 28)}${T.positions[p]}</button>`).join('')}</div></div>
    <div class="foot"><button class="btn primary" data-s>Save</button><button class="btn" data-x>Skip for now</button></div>`, (d, close) => {
    const pick = (sel, attr, set) => $$(sel, d).forEach((b) => b.addEventListener('click', () => { $$(sel, d).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); set(b.dataset[attr]); }));
    pick('[data-a]', 'a', (v) => { athleteId = v; d.querySelector('#newName').value = ''; });
    pick('[data-p]', 'p', (v) => { position = v; });
    d.querySelector('[data-x]').addEventListener('click', () => close(null));
    d.querySelector('[data-s]').addEventListener('click', async () => {
      const name = d.querySelector('#newName').value.trim(), max = parseInt(d.querySelector('#maxHr').value, 10);
      if (!athleteId && !name) { toast('Pick an athlete or type a new name.'); return; }
      if (!position) { toast('Pick where the sensor sits on the head.'); return; }
      if (name) athleteId = upsertAthlete(S.reg, { name, maxHr: max >= 100 && max <= 240 ? max : null }).id;
      else if (max >= 100 && max <= 240) upsertAthlete(S.reg, { id: athleteId, maxHr: max });
      upsertSensor(S.reg, id, { athleteId, position });
      await persistRegistry();
      tellWorker(id);
      emit('registry');
      close(true);
    });
  });
}
