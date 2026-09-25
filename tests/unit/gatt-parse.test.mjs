// Standard GATT parsers checked against the Polar SDK's BleHrClient/BleBattClient test vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHeartRateMeasurement, parseBatteryLevel } from '../../core/ble/gatt-parse.js';

const gatt = JSON.parse(readFileSync(new URL('../fixtures/pmd/gatt.json', import.meta.url), 'utf8'));
// Web Bluetooth hands characteristic values over as DataView
const view = (hex) => new DataView(Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)).buffer);

// Catches misread flag bits (uint16 HR, contact needing both bits, energy shifting the RR offset) and RR ms rounding.
test('parseHeartRateMeasurement reproduces the BleHrClient vectors', () => {
  for (const v of gatt.heartRate) {
    const r = parseHeartRateMeasurement(view(v.hex));
    for (const [k, want] of Object.entries(v.expect)) assert.deepEqual(r[k], want, `${v.source.test} ${v.hex} ${k}`);
  }
});

// Catches contact reported from bit 1 alone: bits 1-2 = 01 means "not supported" in the Heart Rate Service spec and
// BleHrClient requires both bits. The SDK vector 02 00 only asserts sensorContactSupported, so this is not covered there.
test('sensor contact needs both contact bits', () => {
  assert.equal(parseHeartRateMeasurement(view('0200')).sensorContact, false);
});

// Catches an RR interval decoded from a missing byte (the SDK would read past the end and crash).
test('parseHeartRateMeasurement rejects an odd RR byte', () => {
  assert.throws(() => parseHeartRateMeasurement(view('1000ffff7f')), /RR bytes/);
});

// Catches battery values above 100 passed on as valid (the SDK drops them).
test('parseBatteryLevel reproduces the BleBattClient vectors', () => {
  for (const [hex, percent, valid] of gatt.battery[0].cases) assert.deepEqual(parseBatteryLevel(view(hex)), { percent, valid }, hex);
});
