// What the stock SensWear firmware does, read from its source (Sens-Wear/firmware @ 5c4f855b, 2026-09-29) on
// 2026-10-08, not measured on hardware. The Engineering and Compare views show these; each fact names its
// file. When the board is measured, or the firmware changes, update here. Full audit: AI-Modeling
// Personal\Titan-X\Boards\SensWear-Reference\FINDINGS.md section 2.

export const FW = {
  source: 'Sens-Wear/firmware 5c4f855b (2026-09-29), version string "0.1.0+0"',
  toolchain: 'nRF Connect SDK v3.3.0 (Zephyr 4.3.99), CMake 3.23 or later, Ninja, OpenOCD with target/nordic/nrf54l.cfg',
  baud: 921600,                   // uart30, console, shell and log (board .dts current-speed)
  bus: '',                        // the PPG chip is on node sys_i2c_peripheral (i2c21); take the device name from "device list"
  ppg: {                          // max30101_config.h and max30101.c, values as written by max30101_config()
    mode: 'multi LED, slots IR, red, green', sps: 3200, averaging: 16, assumedHz: 200, pulseUs: 215, adcNa: 8192,
    ledMa: { red: 1.6, ir: 1.6, green: 0.6 },
    notes: [
      '3200 sps with three LEDs at 215 µs is outside the MAX30101 datasheet\'s allowed settings; the real rate is unmeasured.',
      'PPG time stamps are filled in from the assumed 200 Hz, so only the arrival rate can show a wrong rate.',
      'LED1 (red) and LED2 (IR) currents are written swapped; invisible at the default, where both are 1.6 mA.',
      'Every PPG start resets the chip and rewrites every register, so register edits last until sampling restarts.',
    ],
  },
  imu: '100 Hz accelerometer (gravity included, 4096 LSB per g assumed by the SDKs), gyroscope (no scale declared) and game rotation vector, off at boot; batch period default 100 ms; ranges are BHI360 firmware defaults',
  driverNote: 'The stock firmware builds without the shell (every CMake preset sets CONFIG_SHELL=n), and the debug board as built may not pass PC to board serial data (its UART TX pin has no net, debugprobe board_debug_probe_config.h). So on the real board this editor needs a firmware with a register service; in sim mode it works now. The stock driver also rewrites these registers whenever PPG sampling restarts.',
  flashSteps: [
    'No bootloader: flashing is over SWD through the debug board only.',
    'Build with nRF Connect SDK v3.3.0 using the CMake preset senswear_nrf54l15_cpuapp_ppg',
    '(PPG and temperature boards); steps in BUILD.md and SETUP.md of the firmware.',
    'Flash with OpenOCD (the debug board is a CMSIS-DAP v2 probe):',
    '  openocd -f config/openocd-cmsis-dap.cfg -f config/openocd-nrf54l15.cfg \\',
    '    -c "init" -c "reset init" -c "nrf54l-load {<build>/firmware/zephyr/zephyr.hex}" \\',
    '    -c "verify_image {<build>/firmware/zephyr/zephyr.hex}" -c "reset run" -c "shutdown"',
    'The CMSIS-DAP flash task of the firmware itself (.vscode/tasks.json); not yet run on this PC.',
  ].join('\n'),
  otaNote: 'Not possible with the stock firmware: no MCUboot, no second image slot, no update service. Adding it means MCUboot, a new flash layout (two images do not fit the 1428 KB internal flash) and an update service.',
  debugNote: 'The debug board (RP2354A, Raspberry Pi debugprobe v2.3.1 port) gives SWD (CMSIS-DAP v2, 1 MHz, no SWO) and a USB serial port carrying the board\'s log at 921600 baud. GDB through OpenOCD works for step debugging.',
  onChip: 'none in the stock firmware; a new algorithm would subscribe to the PPG stream in its own thread next to oob_main.c\'s subscribers and publish through a new characteristic. 188 KB RAM, FPU on.',
  clockReset: 'The firmware sets its clock to 2026-01-01 00:00 UTC at every boot (oob_main.c), so the app sets it from this PC on connect.',
  batteryPresentAlwaysTrue: true, // power_lbs.c: the battery present bit is hard coded to 1
};
