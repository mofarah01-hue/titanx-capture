# First real session on the remote Mac

Things only a real Mac can prove. Run this with the remote user on a video call the first time. Tick each line, write the result next to it, and send the debug bundle afterwards whatever happened.

Mac model and year: ______  macOS version: ______  Chrome version (chrome://version): ______

## Before the call

- [ ] Google Drive for desktop installed and signed in. The Sa7a shortcut is in My Drive.
- [ ] `sa7a_registry.json` exists in the shared Sa7a folder (created by Mohammad). Setup uses it to recognise the right folder.
- [ ] Every sensor charged and wearing its sticker.

## Bluetooth

- [ ] First Connect click: macOS asks whether Google Chrome may use Bluetooth. He clicks Allow. If he clicked Don't Allow: System Settings, Privacy and Security, Bluetooth, switch Google Chrome on, then quit and reopen Chrome.
- [ ] Setup step 3 ticks by itself with Bluetooth on, and unticks when Bluetooth is switched off in Control Center. If it stays ticked when off, note it: the app then only finds out at Connect time.
- [ ] The chooser popup lists the sensor as "Polar Sense XXXXXXXX" within about 5 seconds of pressing its button.
- [ ] Connect step log reaches GYRO started. Note any step that needed a retry and how long Settled took.
- [ ] Measured rates in the stream table: PPG ______ Hz, ACC ______ Hz, GYRO ______ Hz. Anything more than 2 % away from the set rate goes in the notes.
- [ ] First PPI arrives after about 25 s, and Polar HR then updates about every 5 s.

## How many sensors at once

Add sensors one at a time. After each, wait 60 s and write down lost packets and measured PPG rate of the first sensor.

| Sensors connected | Lost packets, sensor 1 | PPG rate, sensor 1 | Any warning shown |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |

The real ceiling is the first row where packets start getting lost or a connection fails. Note it in the README.

## Reconnecting

- [ ] Walk one sensor out of range for 20 s, bring it back. It reconnects without the popup, or Reconnect works with one click. The gap shows in the timeline and is not filled in.
- [ ] Close the lid for 10 s during a session, open it. Note what happened to each sensor and whether the recording carried on.

## Keeping awake

- [ ] Leave the Mac on power, untouched, for 10 minutes mid session. The screen stays on (wake lock).
- [ ] Switch to another app for 1 minute so the Chrome window is hidden. The app shows the hidden window warning when he comes back. Check measured rates did not drop.

## Saving

- [ ] Setup step 6: the picker opens Google Drive, he can select Sa7a, the write test passes and the shared folder is confirmed.
- [ ] `_sa7a_check.txt` appears on Mohammad's side in drive.google.com within a few minutes.
- [ ] Quit Chrome completely and reopen the bookmark. The app shows Allow saving to your Sa7a folder. He clicks it and picks **Allow on every visit** in Chrome's box (Chrome 122 and later).
- [ ] Quit and reopen Chrome once more. This time it must not ask. If it asks again, note the Chrome version.
- [ ] During a 10 minute session, `manifest.json`, `annotations.json` and the `_live` part files appear on Mohammad's side.
- [ ] After End session, the session zip appears on Mohammad's side, opens with a double click, and `_live` is gone.
- [ ] No `.crswap` files are left in the Sa7a folder on Mohammad's side.

## Afterwards

- [ ] Help drawer, Send this to Mohammad. He texts the bundle file. Mohammad checks it opens.
- [ ] Update this file and the README with what the Mac actually did.
