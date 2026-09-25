// Polar Measurement Data (PMD) protocol constants.
// Ground truth: https://github.com/polarofficial/polar-ble-sdk @ a693e9e944c9bc925addbdd8cf07fb9b28748bf7
// Android sources under sources/Android/android-communications/library/src/main/java/com/polar/androidcommunications/api/ble/model/gatt/client/pmd/
// (abbreviated below as "pmd/").

export const SDK_COMMIT = 'a693e9e944c9bc925addbdd8cf07fb9b28748bf7';

// pmd/BlePMDClient.kt. Web Bluetooth wants lowercase. The dashboard discovers the characteristics at runtime;
// these are the known values for reference and for requestDevice() filters.
export const PMD_SERVICE_UUID = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_CONTROL_POINT_UUID = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_DATA_UUID = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// pmd/PmdMeasurementType.kt. Frame byte 0 and command bytes carry the type in bits 0-5; bit 7 is the
// recording type (0 online, 1 offline, pmd/PmdRecordingType.kt).
export const MeasurementType = Object.freeze({
  ECG: 0,
  PPG: 1,
  ACC: 2,
  PPI: 3,
  GYRO: 5,
  MAG: 6,
  SKIN_TEMP: 7,
  SDK_MODE: 9,
  LOCATION: 10,
  PRESSURE: 11,
  TEMPERATURE: 12,
  OFFLINE_RECORDING: 13,
  OFFLINE_HR: 14,
  DERIVED_MEASUREMENT: 15,
});
export const MEASUREMENT_TYPE_MASK = 0x3f;
export const MEASUREMENT_TYPE_NAME = Object.freeze(
  Object.fromEntries(Object.entries(MeasurementType).map(([k, v]) => [v, k])),
);

// Control point READ value: byte 0 is 0x0F, then a bitmask (PmdMeasurementType.fromByteArray).
// Bit 4 of byte 1 has no SDK type (online_measurement.pdf p.12 calls it bio impedance).
export const FEATURES_RESPONSE_CODE = 0x0f;
export const FEATURE_BITS = Object.freeze([
  // [measurement type, byte index, mask]
  [MeasurementType.ECG, 1, 0x01],
  [MeasurementType.PPG, 1, 0x02],
  [MeasurementType.ACC, 1, 0x04],
  [MeasurementType.PPI, 1, 0x08],
  [MeasurementType.GYRO, 1, 0x20],
  [MeasurementType.MAG, 1, 0x40],
  [MeasurementType.SKIN_TEMP, 1, 0x80],
  [MeasurementType.SDK_MODE, 2, 0x02],
  [MeasurementType.LOCATION, 2, 0x04],
  [MeasurementType.PRESSURE, 2, 0x08],
  [MeasurementType.TEMPERATURE, 2, 0x10],
  [MeasurementType.OFFLINE_RECORDING, 2, 0x20],
  [MeasurementType.OFFLINE_HR, 2, 0x40],
]);

// pmd/PmdControlPointCommand.kt (client -> device op codes)
export const OpCode = Object.freeze({
  GET_SETTINGS: 1,
  START: 2,
  STOP: 3,
  GET_SDK_MODE_SETTINGS: 4, // "full" settings: what SDK mode would offer, readable in any mode
  GET_MEASUREMENT_STATUS: 5,
  GET_SDK_MODE_STATUS: 6,
  GET_OFFLINE_RECORDING_TRIGGER_STATUS: 7,
  SET_OFFLINE_RECORDING_TRIGGER_MODE: 8,
  SET_OFFLINE_RECORDING_TRIGGER_SETTINGS: 9,
  GET_DERIVED_MEASUREMENT_SETTINGS_GROUP: 10,
});
export const OP_CODE_NAME = Object.freeze(Object.fromEntries(Object.entries(OpCode).map(([k, v]) => [v, k])));

// Control point notification byte 0: 0xF0 = response to our command (pmd/PmdControlPointResponse.kt);
// 0x01 = device stopped online measurement(s) on its own, followed by the type bytes
// (PmdControlPointCommandServiceToClient.ONLINE_MEASUREMENT_STOPPED).
export const CP_RESPONSE_CODE = 0xf0;
export const CP_MEASUREMENT_STOPPED = 0x01;

// pmd/PmdSetting.kt: setting type ids, wire field size in bytes, and the key used by parseSettings/buildStart.
export const SettingType = Object.freeze({
  SAMPLE_RATE: 0,
  RESOLUTION: 1,
  RANGE: 2,
  RANGE_MILLIUNIT: 3,
  CHANNELS: 4,
  FACTOR: 5, // IEEE 754 float32; only ever sent by the device in the START response
  SECURITY: 6,
  DERIVED_MEASUREMENT_METHOD: 7,
  SOURCE_MEASUREMENT_TYPE: 8,
  SOURCE_MEASUREMENT_SAMPLE_RATE: 9,
  SOURCE_MEASUREMENT_RANGE: 10,
  DERIVED_MEASUREMENT_TIME_WINDOW: 11,
  DERIVED_MEASUREMENT_SETTINGS_GROUP_ID: 12,
});
export const SETTING_FIELD_SIZE = Object.freeze({
  0: 2, 1: 2, 2: 2, 3: 4, 4: 1, 5: 4, 6: 16, 7: 1, 8: 1, 9: 2, 10: 4, 11: 4, 12: 1,
});
export const SETTING_KEY = Object.freeze({
  0: 'sampleRate',
  1: 'resolution',
  2: 'range',
  3: 'rangeMilliunit',
  4: 'channels',
  5: 'factor',
  6: 'security',
  7: 'derivedMeasurementMethod',
  8: 'sourceMeasurementType',
  9: 'sourceMeasurementSampleRate',
  10: 'sourceMeasurementRange',
  11: 'derivedMeasurementTimeWindow',
  12: 'derivedMeasurementSettingsGroupId',
});

// pmd/PmdControlPointResponse.kt (PmdControlPointResponseCode). Plain-English text from the SDK names and
// documentation/Device Error Codes & D2H Notifications.md. That document numbers 15-18 differently
// (15 = derived method, 16 = source type, 17 = source rate, 18 = settings group); both the Android and the
// iOS SDK enums use the numbering below, so the SDK numbering is kept.
export const ResponseStatus = Object.freeze({
  0: ['SUCCESS', 'Command succeeded.'],
  1: ['ERROR_INVALID_OP_CODE', 'The device does not recognise this control point command.'],
  2: ['ERROR_INVALID_MEASUREMENT_TYPE', 'This measurement type is unknown to the device or cannot be started directly.'],
  3: ['ERROR_NOT_SUPPORTED', 'The device does not support this measurement or operation.'],
  4: ['ERROR_INVALID_LENGTH', 'The command has the wrong length for this operation.'],
  5: ['ERROR_INVALID_PARAMETER', 'A setting in the request is not valid. Use values from the device\'s own settings list.'],
  6: ['ERROR_ALREADY_IN_STATE', 'Already in that state: the measurement (or SDK mode) is already running, or already stopped.'],
  7: ['ERROR_INVALID_RESOLUTION', 'The device does not offer this resolution in its current mode.'],
  8: ['ERROR_INVALID_SAMPLE_RATE', 'The device does not offer this sample rate in its current mode.'],
  9: ['ERROR_INVALID_RANGE', 'The device does not offer this range in its current mode.'],
  10: ['ERROR_INVALID_MTU', 'The Bluetooth MTU of this connection is too small for streaming (the browser and OS negotiate the MTU).'],
  11: ['ERROR_INVALID_NUMBER_OF_CHANNELS', 'The device does not offer this number of channels.'],
  12: ['ERROR_INVALID_STATE', 'The device cannot do this now: not ready, first-time setup not done, SDK mode on while PPI/HR is requested, or measurements running while SDK mode is switched.'],
  13: ['ERROR_DEVICE_IN_CHARGER', 'The device is on its charger. Unplug it to measure.'],
  14: ['ERROR_DISK_FULL', 'The device storage is full.'],
  15: ['ERROR_INVALID_SOURCE_MEASUREMENT_TYPE', 'Derived measurement: invalid source measurement type.'],
  16: ['ERROR_INVALID_SOURCE_MEASUREMENT_RATE', 'Derived measurement: invalid source sample rate.'],
  17: ['ERROR_INVALID_DERIVED_MEASUREMENT_SETTINGS_GROUP', 'Derived measurement: unknown settings group.'],
  18: ['ERROR_INVALID_DERIVED_MEASUREMENT_METHOD', 'Derived measurement: unknown method.'],
});

// Supported settings of the Polar Verity Sense, from documentation/products/PolarVeritySense.md @ SDK_COMMIT.
// normal = defaults outside SDK mode (the doc's bold values); sdkMode = options once SDK mode is on.
// Not in the doc: channel counts and frame types. Observed in Polar's own example (technical_documentation/
// online_measurement.pdf p.13-14, Verity Sense ACC): settings 52 Hz / 16 bit / 8 G / 3 channels, start response
// FACTOR 0x397FDA40 (= 2.44e-4 G per count), data frames of type 0x80 (delta compressed, type 0).
// PPG frame type 0x80 (3 PPG + ambient) is inferred from the SDK, not documented for this device.
// Known issue (documentation/KnownIssues.md): firmware 1.1.5 to <2.1.0 reports PPG 135 Hz in normal mode
// while streaming at 55 Hz.
export const VERITY_SENSE = Object.freeze({
  source: 'documentation/products/PolarVeritySense.md @ ' + SDK_COMMIT,
  ACC: {
    normal: { sampleRate: [52], range: [8], resolution: [16] },
    sdkMode: { sampleRate: [26, 52, 104, 208, 416], range: [2, 4, 8, 16], resolution: [16] },
  },
  GYRO: {
    normal: { sampleRate: [52], range: [2000], resolution: [16] },
    sdkMode: { sampleRate: [26, 52, 104, 208, 416], range: [250, 500, 1000, 2000], resolution: [16] },
  },
  MAG: {
    normal: { sampleRate: [10, 20, 50, 100], range: [50], resolution: [16] },
    sdkMode: { sampleRate: [10, 20, 50, 100], range: [50], resolution: [16] },
  },
  PPG: {
    normal: { sampleRate: [55], resolution: [22] },
    sdkMode: { sampleRate: [28, 44, 55, 135, 176], resolution: [22] },
  },
  PPI: { normal: {}, sdkMode: null }, // not available in SDK mode
  HR: { normal: {}, sdkMode: null }, // standard GATT 0x2A37; not available in SDK mode
});
