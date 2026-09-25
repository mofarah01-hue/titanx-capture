// Every word the remote user reads. Arabic goes in strings/ar.js with the same keys.
// House rules: plain words, no dashes as punctuation, errors say what happened and what to do
// next in one sentence each, no codes without an explanation.

export default {
  app: { name: 'TitanX Capture', sim: 'Simulated data' },

  gate: {
    title: 'Please open this page in Google Chrome',
    why: (browser) => `${browser} cannot talk to Bluetooth sensors from a web page. Chrome on a Mac can.`,
    download: 'Download Chrome',
    after: 'After installing, open Chrome, paste this page address into it and bookmark it.',
    copyLink: 'Copy this page address',
    notSecure: 'This page must be opened from its https link, not from a saved file.',
    oldChrome: (v) => `This Chrome is version ${v}, too old to save into Google Drive. Click the three dots at the top right of Chrome, then Help, then About Google Chrome, and let it update.`,
  },

  update: {
    idle: 'New version available. Reload the page.',
    inSession: 'New version available. Reload the page after this session ends.',
    reload: 'Reload now',
  },

  wizard: {
    title: 'Set up TitanX Capture',
    reopen: 'Setup',
    stepOf: (n, total) => `Step ${n} of ${total}`,
    next: 'Next', back: 'Back', done: 'Done',
    steps: [
      {
        key: 'chrome', title: 'Use Chrome',
        body: 'This page only works in Google Chrome. The app checks this for you.',
        ok: 'You are using Chrome.',
      },
      {
        key: 'bookmark', title: 'Bookmark this page',
        body: 'Press Cmd and D together, then click Done in the box that appears. Next time, open the bookmark.',
        tick: 'I bookmarked it',
      },
      {
        key: 'bluetooth', title: 'Turn on Bluetooth',
        body: 'Click the Control Center icon at the top right of the screen, it looks like two small switches. Click Bluetooth so it turns blue.',
        ok: 'Bluetooth is on.',
        off: 'Bluetooth is off, or this Mac has no Bluetooth Low Energy. Turn it on in Control Center and this step ticks by itself.',
      },
      {
        key: 'drive', title: 'Install Google Drive for desktop',
        body: 'Download it from Google, open the installer and follow it. When it asks, sign in with your Google account. A Google Drive icon then appears at the top of the screen.',
        link: 'Open the Google Drive download page',
        ok: 'Confirmed when you pick the folder in step 6.',
      },
      {
        key: 'shared', title: 'Add the Sa7a folder to your Drive',
        body: 'Open drive.google.com in Chrome and click Shared with me. Right click the Sa7a folder, choose Organize, then Add shortcut to My Drive, then pick My Drive.',
        why: 'Without this shortcut the Mac cannot see the folder, and your recordings cannot reach Mohammad.',
        ok: 'Confirmed when you pick the folder in step 6.',
      },
      {
        key: 'folder', title: 'Pick your save folder',
        body: 'Every session is saved into the Sa7a folder in your Google Drive. Google Drive then sends it to Mohammad by itself.',
        how: 'Click Choose folder. In the window that opens, click Google Drive on the left, open My Drive, click Sa7a once, then click Select.',
        button: 'Choose folder',
        chosen: (name) => `Folder chosen: ${name}`,
        writeOk: 'Write test passed. A small test file was saved and read back.',
        writeFail: 'The app could not save a test file in this folder. Pick the Sa7a folder in Google Drive instead.',
        sharedOk: 'Shared folder confirmed. The athlete list Mohammad put in this folder is here.',
        notShared: 'This folder is on your Mac only. Recordings will not reach Mohammad. Pick the Sa7a folder inside Google Drive.',
      },
      {
        key: 'sensor', title: 'Test with a sensor',
        body: 'Put the headgear on someone, press the button on one sensor so its light blinks, then click Connect and choose it in the popup.',
        button: 'Connect a sensor',
        waiting: 'Waiting for the first heart rate. This can take up to 30 seconds.',
        ok: (hr) => `Heart rate is arriving: ${hr} beats per minute.`,
      },
      {
        key: 'ready', title: 'You are ready',
        body: 'In a session you connect each sensor, recording starts by itself, you press a mark button when something happens, and you click End session when done. Google Drive sends everything to Mohammad.',
        button: 'Start a session',
      },
    ],
  },

  checklist: {
    title: 'Before you start',
    items: {
      power: 'Laptop plugged in',
      lid: 'Lid stays open and this window stays visible',
      folder: 'Save folder connected',
      charged: 'Sensors charged',
      stickers: 'Sensors wear the athlete stickers',
    },
    folderMissing: 'Allow saving to your Sa7a folder first.',
    start: 'Start session',
    label: 'Session name',
    labelHint: 'For example practice or sparring',
  },

  connect: {
    hint: 'A popup will list nearby sensors. Pick the one whose last four characters match the sticker.',
    button: 'Connect',
    retry: 'Retry',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    steps: {
      requested: 'Sensor picked',
      connected: 'Connected',
      settled: 'Settled',
      battery: 'Battery read',
      hr: 'Heart rate on',
      pmd: 'Raw data service found',
      sdk: 'Max rate mode on',
      ppg: 'PPG started',
      acc: 'ACC started',
      gyro: 'GYRO started',
      mag: 'MAG started',
      ppi: 'Beat to beat (PPI) started',
    },
    named: (athlete, position) => `This sensor is ${athlete}, ${position}.`,
    unknown: 'New sensor. Pick the athlete and head position so the app remembers it.',
  },

  positions: { left_ear: 'Left ear', right_ear: 'Right ear', forehead: 'Forehead', back_of_head: 'Back of head' },
  modes: {
    polar: 'Polar mode', max: 'Max rate mode',
    polarNote: 'Polar heart rate and beat to beat intervals on, plus raw PPG, ACC, GYRO and MAG.',
    maxNote: 'Highest rates this sensor allows. Polar heart rate is off on this sensor.',
  },

  marks: {
    quick: ['Still', 'Light', 'Heavy', 'Adjusted', 'HR looks wrong', 'Mark'],
    all: 'All athletes',
    target: 'Mark for',
    notePlaceholder: 'Type a note and press Enter',
    add: 'Add note',
    saved: (what, time, who) => `Marked ${what} at ${time} for ${who}. Saved.`,
  },

  storage: {
    allow: 'Allow saving to your Sa7a folder',
    allowHint: 'Chrome will ask. Choose Allow on every visit so it does not ask again.',
    saved: (s) => `saved ${s} s ago`,
    localOnly: 'Saving on this Mac only. Recordings will not reach Mohammad until the Sa7a folder is connected.',
  },

  end: {
    title: 'Session saved',
    length: 'Length', sensors: 'Sensors', marks: 'Marks',
    synced: (folder, mb) => `Saved to Google Drive folder ${folder}, ${mb} MB, syncing.`,
    failed: 'The session could not be saved to the Sa7a folder. It is safe on this Mac.',
    download: 'Download session',
    dragHow: 'Open drive.google.com, open the Sa7a folder, and drag the downloaded file into it.',
  },

  errors: {
    // [what happened, what to do next]
    noPick: ['No sensor was picked.', 'Click Connect again and pick the sensor in the popup.'],
    btOff: ['Bluetooth is off.', 'Turn on Bluetooth in Control Center, then click Connect.'],
    blocked: ['Chrome blocked access to the sensor.', 'Reload the page and try again. If it happens again, send a debug bundle to Mohammad.'],
    dropped: ['The sensor dropped the connection.', 'Press the button on the sensor and click Retry.'],
    refused: ['The sensor refused a request.', 'Click Retry. The app carries on from the step that failed.'],
    notPolar: ['This is not a Polar Verity Sense.', 'Pick a sensor whose name starts with Polar Sense.'],
    charging: ['The sensor is on its charger.', 'Take it off the charger and click Retry.'],
    mtu: ['This computer cannot carry raw sensor data over its Bluetooth link.', 'Send a debug bundle to Mohammad.'],
    streamRefused: (stream, meaning) => [`The sensor refused to start ${stream} (${meaning}).`, 'Click Retry.'],
    folderLost: ['Saving to the Sa7a folder stopped because Chrome lost permission.', 'Click Allow saving to your Sa7a folder. Recording is safe on this Mac meanwhile.'],
    folderGone: ['The Sa7a folder cannot be found.', 'Open Setup and pick the Sa7a folder again.'],
    diskFull: ['This Mac is out of space for recordings.', 'Free some disk space. Everything saved so far is kept.'],
    tabHidden: ['This window was hidden, so recording may have slowed down.', 'Keep this window visible during a session.'],
    unknown: ['Something went wrong.', 'Click Retry. If it happens again, send a debug bundle to Mohammad.'],
  },

  help: {
    title: 'Help',
    search: 'Search help, for example popup',
    none: 'Nothing matches. Try a shorter word, or send a debug bundle to Mohammad below.',
    entries: [
      ['The sensor does not show up in the popup', 'Press the button on the sensor once so its light blinks, then click Connect again. Keep it close to the laptop. If a phone app is connected to it, close that app first, because a sensor talks to one device at a time.'],
      ['It connected but no heart rate', 'Heart rate needs skin. Seat the headgear so the sensor window touches skin, then wait. The first beat to beat reading takes about 25 seconds.'],
      ['The popup asks again every time', 'This is normal in Chrome on a Mac. Chrome asks you to pick each sensor by hand for privacy. Pick the one whose last four characters match the sticker.'],
      ['Connecting more than one sensor', 'Each athlete slot has its own Connect button. Click it, pick that sensor in the popup, then do the next slot. One popup per sensor.'],
      ['The page asks to allow saving again', 'Chrome can forget folder permission after a restart. Click Allow saving to your Sa7a folder, then choose Allow on every visit in the box Chrome shows, so it stops asking. You do not need to pick the folder again.'],
      ['My recordings are not reaching Mohammad', 'Click the Google Drive icon at the top of the screen and check it says up to date. If the header says the folder is on your Mac only, open Setup and pick the Sa7a folder inside Google Drive.'],
      ['The Mac went to sleep or the lid closed during a session', 'Open the lid and click Reconnect on each sensor. Everything recorded before the sleep is saved. The gap is written down for Mohammad, so just carry on.'],
      ['The number looks wrong', 'Press HR looks wrong straight away so Mohammad can find that moment. Then check the sensor sits flat on skin and the headgear is snug.'],
      ['How to send a debug bundle', 'Click Send this to Mohammad below. The app saves a small file into your Sa7a folder and shows its name. Text or email that file to Mohammad.'],
      ['How to update', 'Reload the page with Cmd and R. When a new version is out, a banner at the top tells you to reload.'],
    ],
    contactTitle: 'Having trouble?',
    contactBody: 'This saves connection logs and the last minute of sensor data into your Sa7a folder. It holds no personal data.',
    contactButton: 'Send this to Mohammad',
    bundleSaved: (name, where) => `Saved ${name} in ${where}. Text or email it to Mohammad.`,
  },
};
