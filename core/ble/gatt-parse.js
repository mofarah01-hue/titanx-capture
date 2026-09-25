// Standard GATT characteristics the dashboard reads besides PMD. Behaviour matches polar-ble-sdk @ a693e9e9,
// sources/Android/android-communications/library/src/main/java/com/polar/androidcommunications/api/ble/model/gatt/client/
// BleHrClient.kt and BleBattClient.kt.

export const HEART_RATE_SERVICE = 0x180d;
export const HEART_RATE_MEASUREMENT = 0x2a37;
export const BATTERY_SERVICE = 0x180f;
export const BATTERY_LEVEL = 0x2a19;

function bytesOf(view) {
  if (view instanceof Uint8Array) return view;
  if (ArrayBuffer.isView(view)) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  throw new TypeError('expected a DataView or Uint8Array');
}

// Heart Rate Measurement 0x2A37. flags: bit0 HR uint16, bits1-2 sensor contact (contact only when both set, as
// the SDK does), bit3 energy expended uint16 kJ present, bit4 RR intervals present (uint16, 1/1024 s).
// rrsMs uses the SDK rounding: round(rr / 1024 * 1000), ties up. energyKj is null when absent (the SDK gives 0).
export function parseHeartRateMeasurement(dataView) {
  const p = bytesOf(dataView);
  if (p.length < 2) throw new Error(`HR measurement too short: ${p.length} bytes`);
  const flags = p[0];
  const hrUint16 = (flags & 0x01) !== 0;
  if (hrUint16 && p.length < 3) throw new Error('HR measurement too short for a uint16 heart rate');
  const hr = hrUint16 ? p[1] | (p[2] << 8) : p[1];
  let off = hrUint16 ? 3 : 2;
  let energyKj = null;
  if (flags & 0x08) {
    if (off + 2 > p.length) throw new Error('HR measurement: energy expended flagged but missing');
    energyKj = p[off] | (p[off + 1] << 8);
    off += 2;
  }
  const rrPresent = (flags & 0x10) !== 0;
  const rrs1024 = [];
  const rrsMs = [];
  if (rrPresent) {
    if ((p.length - off) % 2 !== 0) throw new Error(`HR measurement: ${p.length - off} RR bytes, expected pairs`);
    for (; off < p.length; off += 2) {
      const rr = p[off] | (p[off + 1] << 8);
      rrs1024.push(rr);
      rrsMs.push(Math.round((rr / 1024) * 1000));
    }
  }
  return {
    hr,
    hrUint16,
    sensorContact: ((flags & 0x06) >> 1) === 3,
    sensorContactSupported: (flags & 0x04) !== 0,
    energyKj,
    rrPresent,
    rrs1024,
    rrsMs,
  };
}

// Battery Level 0x2A19: one byte, percent. valid is false outside 0..100 (the SDK drops those readings).
export function parseBatteryLevel(dataView) {
  const p = bytesOf(dataView);
  if (p.length < 1) throw new Error('battery level: empty value');
  return { percent: p[0], valid: p[0] <= 100 };
}
