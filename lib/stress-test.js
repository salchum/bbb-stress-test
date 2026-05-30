const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const username = require("./username");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = (name, fallback) =>
  Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;

const DEBUG_DIR = env("BBB_BOT_DEBUG_DIR", "/app/screenshots");
const CHROMIUM_PATH = env("CHROMIUM_PATH", "/usr/bin/chromium");

const JOIN_AS = env("BBB_BOT_JOIN_AS", "attendee").toLowerCase();
const FIRST_CLIENT_AS_MODERATOR =
  env("BBB_BOT_FIRST_CLIENT_AS_MODERATOR", "true") === "true";

const JOIN_CONCURRENCY = Math.max(
  1,
  Number(env("BBB_BOT_JOIN_CONCURRENCY", "1")) || 1
);
const CHAT_TEXT = env("BBB_BOT_CHAT_TEXT", "Hello from {{username}} 👋");
const WEBCAM_TIMEOUT_MS = Math.max(
  1000,
  Number(env("BBB_BOT_WEBCAM_TIMEOUT_MS", "30000")) || 30000
);
const REPORT_DIR = env("BBB_BOT_REPORT_DIR", "/app/reports");
const REPORT_FILE = env("BBB_BOT_REPORT_FILE", "");
const SCREENSHOT_MODE = env("BBB_BOT_SCREENSHOT_MODE", "failure");
// failure | all | none

const ROOM_SELECTORS = [
  ".navbar",
  '[aria-label="Actions"]',
  '[aria-label="Leave meeting"]',
  '[aria-label="Options"]',
  '[aria-label="User list"]',
  '[aria-label="Public chat"]',
];

const CLIENT_READY_SELECTORS = [
  ...ROOM_SELECTORS,
  '[aria-label="Microphone"]',
  '[aria-label*="Microphone"]',
  '[aria-label="Listen only"]',
  '[aria-label*="Listen only"]',
  '[aria-label="Join audio"]',
  '[aria-label*="Join audio"]',
  '[data-test="joinAudio"]',
  '[data-test="microphoneBtn"]',
  '[data-test="listenOnlyBtn"]',
  '[data-test="joinAudioMicrophone"]',
  '[data-test="joinAudioListenOnly"]',
];

const AUDIO_CONNECTED_SELECTORS = [
  '[aria-label="Mute"]',
  '[aria-label="Unmute"]',
  '[aria-label*="Mute"]',
  '[aria-label*="Unmute"]',
  '[aria-label="Leave audio"]',
  '[aria-label*="Leave audio"]',
  '[title*="Leave audio"]',
  '[data-test="leaveAudio"]',
];

function ensureDebugDir() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function formatReportTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function getReportFilePath() {
  if (REPORT_FILE) {
    return path.isAbsolute(REPORT_FILE)
      ? REPORT_FILE
      : path.join(REPORT_DIR, REPORT_FILE);
  }

  return path.join(
    REPORT_DIR,
    `stress-report-${formatReportTimestamp()}.jsonl`
  );
}

function createReportWriter(logger) {
  const filePath = getReportFilePath();
  let disabled = false;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    logger.info(`Writing structured report log to ${filePath}`);
  } catch (error) {
    disabled = true;
    logger.warn(`Unable to create report log ${filePath}: ${error.message}`);
  }

  return {
    filePath,

    write(event, fields = {}) {
      if (disabled) return;

      try {
        fs.appendFileSync(
          filePath,
          `${JSON.stringify({
            event,
            timestamp: new Date().toISOString(),
            ...fields,
          })}\n`
        );
      } catch (error) {
        disabled = true;
        logger.warn(`Unable to write report log ${filePath}: ${error.message}`);
      }
    },
  };
}

function resolveExistingFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;

    const resolved = path.resolve(candidate);

    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

function getAudioFile() {
  return resolveExistingFile([
    env("BBB_BOT_AUDIO_FILE", null),
    "./audio.wav",
    "./app/audio.wav",
    "/app/audio.wav",
  ]);
}

function getVideoFile() {
  return resolveExistingFile([
    env("BBB_BOT_VIDEO_FILE", null),
    "./webcam.y4m",
    "./app/webcam.y4m",
    "/app/webcam.y4m",
  ]);
}

function shouldScreenshot(kind) {
  if (SCREENSHOT_MODE === "none") return false;
  if (SCREENSHOT_MODE === "all") return true;

  return kind === "failure";
}

async function screenshot(page, name, kind = "failure") {
  if (!shouldScreenshot(kind)) return;

  ensureDebugDir();

  try {
    await page.screenshot({
      path: path.join(DEBUG_DIR, `${name}-${Date.now()}.png`),
      fullPage: true,
    });
  } catch (_) {
    // Ignore screenshot failures so the bot does not die while trying to debug itself.
  }
}

async function isVisible(handle) {
  const box = await handle.boundingBox();

  if (!box || box.width <= 0 || box.height <= 0) {
    return false;
  }

  return handle.evaluate((el) => {
    const style = window.getComputedStyle(el);

    return (
      style &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true" &&
      el.getAttribute("aria-hidden") !== "true"
    );
  });
}

async function findVisible(page, selectors) {
  for (const selector of selectors) {
    const handles = await page.$$(selector);

    for (const handle of handles) {
      if (await isVisible(handle)) {
        return { selector, handle };
      }
    }
  }

  return null;
}

async function waitForVisible(page, selectors, timeout = 30000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const found = await findVisible(page, selectors);

    if (found) {
      return found;
    }

    await sleep(250);
  }

  throw new Error(
    `Timeout waiting for visible selector: ${selectors.join(", ")}`
  );
}

async function clickFirstVisible(page, selectors, timeout = 30000) {
  const { selector, handle } = await waitForVisible(page, selectors, timeout);

  await handle.click();

  return selector;
}

async function clickIfVisible(page, selectors, timeout = 3000) {
  try {
    return await clickFirstVisible(page, selectors, timeout);
  } catch (_) {
    return null;
  }
}

async function waitUntilVisibleOrNull(page, selectors, timeout = 10000) {
  try {
    return await waitForVisible(page, selectors, timeout);
  } catch (_) {
    return null;
  }
}

async function clickButtonByText(page, texts, timeout = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const clicked = await page.evaluate((texts) => {
      function visible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      const normalizedTexts = texts.map((t) => String(t).toLowerCase());

      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], a, label, [aria-label], [title]'
        )
      );

      for (const el of candidates) {
        if (!visible(el)) continue;

        const text = [
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.textContent,
          el.innerText,
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .toLowerCase();

        if (!text) continue;

        const matched = normalizedTexts.some((needle) =>
          text.includes(needle)
        );

        if (matched) {
          const clickable =
            el.closest("button") ||
            el.closest('[role="button"]') ||
            el;

          clickable.click();

          return true;
        }
      }

      return false;
    }, texts);

    if (clicked) {
      return true;
    }

    await sleep(300);
  }

  return false;
}

async function clickBbbControl(page, selectors, texts, timeout = 20000) {
  return (
    (await clickIfVisible(page, selectors, timeout)) ||
    (await clickButtonByText(page, texts, Math.max(5000, timeout / 2)))
  );
}

async function waitForAudioConnected(page, timeout = 15000) {
  return Boolean(
    await waitUntilVisibleOrNull(page, AUDIO_CONNECTED_SELECTORS, timeout)
  );
}

function installClientPatches(page) {
  return page.evaluateOnNewDocument(() => {
    const originalGetUserMedia =
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null;

    if (originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
        if (constraints.audio && typeof constraints.audio === "object") {
          constraints.audio.echoCancellation = false;
          constraints.audio.noiseSuppression = false;
          constraints.audio.autoGainControl = false;
          constraints.audio.channelCount = 1;
          constraints.audio.sampleRate = 48000;
        }

        return originalGetUserMedia(constraints);
      };
    }

    const NativePeerConnection = window.RTCPeerConnection;

    if (NativePeerConnection) {
      window.__bbbPeerConnections = [];

      window.RTCPeerConnection = function (...args) {
        const pc = new NativePeerConnection(...args);

        window.__bbbPeerConnections.push(pc);

        pc.addEventListener("connectionstatechange", () => {
          console.debug(`[webrtc] connectionState=${pc.connectionState}`);
        });

        pc.addEventListener("iceconnectionstatechange", () => {
          console.debug(
            `[webrtc] iceConnectionState=${pc.iceConnectionState}`
          );
        });

        pc.addEventListener("icecandidateerror", (event) => {
          console.error(
            `[webrtc] icecandidateerror code=${event.errorCode} text=${event.errorText}`
          );
        });

        return pc;
      };

      window.RTCPeerConnection.prototype = NativePeerConnection.prototype;
    }
  });
}

function buildLaunchArgs(logger) {
  const audioFile = getAudioFile();
  const videoFile = getVideoFile();

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--mute-audio",
  ];

  if (audioFile) {
    logger.info(`Using fake microphone audio file: ${audioFile}`);
    args.push(`--use-file-for-fake-audio-capture=${audioFile}`);
  } else {
    logger.warn(
      "audio.wav not found. Chromium will use its default fake microphone. " +
        "Set BBB_BOT_AUDIO_FILE=/path/to/audio.wav if needed."
    );
  }

  if (videoFile) {
    logger.info(`Using fake webcam video file: ${videoFile}`);
    args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  } else {
    logger.warn(
      "webcam.y4m not found. Chromium will use its default fake webcam. " +
        "Set BBB_BOT_VIDEO_FILE=/path/to/webcam.y4m if needed."
    );
  }

  return args;
}

function normalizeBbbApiUrl(apiBase) {
  const clean = apiBase.replace(/\/+$/, "");

  if (clean.endsWith("/bigbluebutton/api")) {
    return clean;
  }

  if (clean.endsWith("/bigbluebutton")) {
    return `${clean}/api`;
  }

  if (clean.endsWith("/api")) {
    return clean;
  }

  return `${clean}/bigbluebutton/api`;
}

function signBbbUrl(apiBase, secret, callName, params) {
  const queryString = new URLSearchParams(params).toString();

  const checksum = crypto
    .createHash("sha1")
    .update(callName + queryString + secret)
    .digest("hex");

  const apiUrl = normalizeBbbApiUrl(apiBase);

  return `${apiUrl}/${callName}?${queryString}&checksum=${checksum}`;
}

function getJoinUrl(bbbClient, client, meetingID, passwordForFallback) {
  if (!bbbClient.url || !bbbClient.secret) {
    return bbbClient.getJoinUrl(
      client.username,
      meetingID,
      passwordForFallback
    );
  }

  return signBbbUrl(bbbClient.url, bbbClient.secret, "join", {
    fullName: client.username,
    meetingID,
    password: passwordForFallback,
    userID: client.userID,

    "userdata-bbb_override_default_locale": "en",
    "userdata-bbb_show_public_chat_on_login": "true",
    "userdata-bbb_show_participants_on_login": "true",
    "userdata-bbb_auto_join_audio": "false",
    "userdata-bbb_listen_only_mode": client.microphone ? "false" : "true",
  });
}

async function waitForClientReady(page, logger, client) {
  try {
    await waitForVisible(page, CLIENT_READY_SELECTORS, 90000);

    logger.info(`${client.username} BBB client loaded`);
  } catch (error) {
    await screenshot(
      page,
      `bbb-client-never-loaded-${client.username}`,
      "failure"
    );

    throw new Error(`BBB client never loaded: ${error.message}`);
  }
}

async function waitForRoom(page, logger) {
  try {
    await waitForVisible(page, ROOM_SELECTORS, 45000);

    logger.info("user successfully entered meeting");
  } catch (error) {
    await screenshot(page, "meeting-room-never-appeared", "failure");

    throw new Error(`meeting room never appeared: ${error.message}`);
  }
}

async function detectBlockingScreen(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || "" : "";

    const checks = [
      "Waiting for a moderator",
      "waiting for a moderator",
      "Meeting has not started",
      "meeting has not started",
      "Invalid meeting",
      "invalid meeting",
      "Guest lobby",
      "guest lobby",
      "You are now in the guest lobby",
      "This meeting has ended",
      "meeting has ended",
      "Whitelabel Error Page",
      "There was an unexpected error",
      "status=404",
      "type=Not Found",
      "Invalid checksum",
      "checksumError",
      "missingParam",
    ];

    return checks.find((text) => bodyText.includes(text)) || null;
  });
}

async function connectAudio(page, logger, microphone, client) {
  const audioMode = microphone ? "Microphone" : "Listen only";

  logger.debug(`waiting for ${audioMode} button`);

  await screenshot(page, `before-audio-${client.username}`, "all");

  const blockingText = await detectBlockingScreen(page);

  if (blockingText) {
    await screenshot(page, `blocking-screen-${client.username}`, "failure");
    throw new Error(`BBB blocking screen detected: ${blockingText}`);
  }

  const selectors = microphone
    ? [
        '[aria-label="Join audio"]',
        '[aria-label*="Join audio"]',
        '[aria-label="Microphone"]',
        'button[aria-label="Microphone"]',
        '[aria-label*="Microphone"]',
        '[aria-label*="microphone"]',
        '[title*="Microphone"]',
        '[title*="microphone"]',
        '[data-test="joinAudio"]',
        '[data-test="microphoneBtn"]',
        '[data-test="joinAudioMicrophone"]',
      ]
    : [
        '[aria-label="Join audio"]',
        '[aria-label*="Join audio"]',
        '[aria-label="Listen only"]',
        'button[aria-label="Listen only"]',
        '[aria-label*="Listen only"]',
        '[aria-label*="listen only"]',
        '[title*="Listen only"]',
        '[title*="listen only"]',
        '[data-test="joinAudio"]',
        '[data-test="listenOnlyBtn"]',
        '[data-test="joinAudioListenOnly"]',
      ];

  const clicked = await clickBbbControl(
    page,
    selectors,
    microphone
      ? [
          "Microphone",
          "Join audio",
          "Join with microphone",
          "Use microphone",
          "Audio",
        ]
      : [
          "Listen only",
          "Join audio",
          "Join listen only",
          "Listen",
        ],
    20000
  );

  if (!clicked) {
    await screenshot(
      page,
      `audio-button-not-found-${client.username}`,
      "failure"
    );

    const audioConnected = await waitForAudioConnected(page, 2000);
    const roomVisible = await findVisible(page, ROOM_SELECTORS);

    if (audioConnected || roomVisible) {
      logger.warn(
        `${audioMode} button not found, but the room/audio controls are visible. Continuing.`
      );

      return audioConnected;
    }

    throw new Error(`${audioMode} button not found`);
  }

  logger.debug(`${audioMode} clicked`);

  const choiceClicked = await clickBbbControl(
    page,
    microphone
      ? [
          '[aria-label="Microphone"]',
          'button[aria-label="Microphone"]',
          '[aria-label*="Microphone"]',
          '[data-test="microphoneBtn"]',
          '[data-test="joinAudioMicrophone"]',
        ]
      : [
          '[aria-label="Listen only"]',
          'button[aria-label="Listen only"]',
          '[aria-label*="Listen only"]',
          '[data-test="listenOnlyBtn"]',
          '[data-test="joinAudioListenOnly"]',
        ],
    microphone
      ? ["Microphone", "Join with microphone", "Use microphone"]
      : ["Listen only", "Join listen only"],
    3000
  );

  if (choiceClicked) {
    logger.debug(`${audioMode} choice clicked`);
  }

  const confirmClicked = await clickBbbControl(
    page,
    [
      '[data-test="joinEchoTestButton"]',
      'button[aria-label="Join audio"]',
      '[aria-label="Join audio"]',
      '[aria-label*="Join audio"]',
    ],
    ["Join audio"],
    15000
  );

  if (confirmClicked) {
    logger.debug("audio settings confirmed");
  }

  if (microphone) {
    const echoClicked =
      (await clickIfVisible(
        page,
        [
          '[aria-label="Echo is audible"]',
          'button[aria-label="Echo is audible"]',
          '[aria-label*="Echo is audible"]',
          '[aria-label*="echo is audible"]',
          '[title*="Echo is audible"]',
          '[data-test="echoYes"]',
        ],
        15000
      )) ||
      (await clickButtonByText(
        page,
        [
          "Echo is audible",
          "Yes",
          "Yes, I can hear myself",
          "I can hear audio",
        ],
        7000
      ));

    if (echoClicked) {
      logger.debug("echo test accepted");
    } else {
      logger.debug("echo dialog not shown or skipped");
    }

    await waitForAudioConnected(page, 10000);

    const unmuted = await clickIfVisible(
      page,
      [
        '[aria-label="Unmute"]',
        'button[aria-label="Unmute"]',
        '[aria-label*="Unmute"]',
        '[title*="Unmute"]',
      ],
      3000
    );

    if (unmuted) {
      logger.debug("microphone unmuted");
    }
  } else {
    await waitForAudioConnected(page, 10000);
  }

  return true;
}

async function startWebcam(page, logger, client) {
  try {
    logger.debug("starting webcam");

    await screenshot(page, `before-webcam-${client.username}`, "all");

    const shareClicked =
      (await clickIfVisible(
        page,
        [
          '[aria-label="Share webcam"]',
          'button[aria-label="Share webcam"]',
          '[aria-label*="Share webcam"]',
          '[aria-label*="share webcam"]',
          '[aria-label*="Camera"]',
          '[aria-label*="camera"]',
          '[title*="Share webcam"]',
          '[title*="share webcam"]',
          '[data-test="joinVideo"]',
        ],
        WEBCAM_TIMEOUT_MS
      )) ||
      (await clickButtonByText(
        page,
        [
          "Share webcam",
          "Webcam",
          "Camera",
        ],
        WEBCAM_TIMEOUT_MS
      ));

    if (!shareClicked) {
      logger.warn(
        "Share webcam button not found. Webcam may already be active."
      );
      return false;
    }

    await sleep(2000);

    const startClicked =
      (await clickIfVisible(
        page,
        [
          '[aria-label="Start sharing"]',
          'button[aria-label="Start sharing"]',
          '[aria-label*="Start sharing"]',
          '[aria-label*="start sharing"]',
          '[title*="Start sharing"]',
          '[title*="start sharing"]',
          '[data-test="startSharingWebcam"]',
        ],
        WEBCAM_TIMEOUT_MS
      )) ||
      (await clickButtonByText(
        page,
        [
          "Start sharing",
          "Start Sharing",
          "Share",
        ],
        WEBCAM_TIMEOUT_MS
      ));

    if (!startClicked) {
      throw new Error("Start sharing button not found");
    }

    await waitUntilVisibleOrNull(
      page,
      [
        '[aria-label="Stop sharing webcam"]',
        '[aria-label*="Stop sharing webcam"]',
        '[aria-label*="stop sharing webcam"]',
        '[title*="Stop sharing webcam"]',
        '[data-test="leaveVideo"]',
        "video",
      ],
      WEBCAM_TIMEOUT_MS
    );

    logger.info("webcam enabled");

    return true;
  } catch (error) {
    logger.error(`webcam failed: ${error}`);
    await screenshot(page, `webcam-failed-${client.username}`, "failure");

    throw error;
  }
}

const PUBLIC_CHAT_SELECTORS = [
  "#chat-toggle-button",
  '[data-test="chatButton"]',
  '[role="button"][aria-label="Public Chat"]',
  '[aria-label="Public chat"]',
  '[aria-label="Public Chat"]',
  '[aria-label*="public chat"]',
  '[aria-label*="Public chat"]',
  '[aria-label*="Public Chat"]',
  '[title*="Public chat"]',
  '[title*="public chat"]',
  '[data-test="publicChat"]',
];

async function activatePublicChatButton(page) {
  const result = await page.evaluate((selectors) => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        el.getAttribute("aria-disabled") !== "true"
      );
    }

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));

      for (const el of elements) {
        if (!visible(el)) continue;

        el.scrollIntoView({ block: "center", inline: "center" });
        el.focus();

        for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
          el.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
            })
          );
        }

        if (el.getAttribute("aria-expanded") === "false") {
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "Enter",
              code: "Enter",
            })
          );
          el.dispatchEvent(
            new KeyboardEvent("keyup", {
              bubbles: true,
              cancelable: true,
              key: "Enter",
              code: "Enter",
            })
          );
        }

        return {
          ariaExpanded: el.getAttribute("aria-expanded"),
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          selector,
        };
      }
    }

    return null;
  }, PUBLIC_CHAT_SELECTORS);

  if (result) {
    await page.mouse.click(result.x, result.y);
  }

  return result;
}

async function pressPublicChatShortcut(page, logger) {
  try {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyP");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");

    return true;
  } catch (error) {
    logger.debug(`public chat keyboard fallback failed: ${error.message}`);

    return false;
  }
}

async function openPublicChat(page, logger) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (await findChatInput(page)) {
      return true;
    }

    const result = await activatePublicChatButton(page);

    if (result) {
      logger.debug(
        `public chat activation attempt ${attempt}: ${result.selector}, aria-expanded=${result.ariaExpanded}`
      );
    } else {
      logger.debug(`public chat activation attempt ${attempt}: button not found`);
    }

    await sleep(1000);

    if (await findChatInput(page)) {
      return true;
    }

    await pressPublicChatShortcut(page, logger);
    await sleep(1000);
  }

  return Boolean(await findChatInput(page));
}

async function findChatInput(page) {
  return findVisible(page, [
    "#message-input",
    '[data-test="chatInput"]',
    'textarea[aria-label="Message input for chat Public Chat"]',
    'textarea[aria-label*="Message"]',
    'textarea[placeholder*="Message"]',
    'textarea[aria-label*="message"]',
    'textarea[placeholder*="message"]',
    'textarea[aria-label*="Chat"]',
    'textarea[placeholder*="Chat"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    "textarea",
  ]);
}

async function fillChatInput(page, found, message) {
  await found.handle.click({ clickCount: 1 });

  await page.evaluate(
    (el, value) => {
      el.focus();

      if (
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement
      ) {
        const prototype =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(
          prototype,
          "value"
        ).set;

        valueSetter.call(el, value);
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value,
          })
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));

        return;
      }

      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    },
    found.handle,
    message
  );
}

async function waitForChatMessage(page, message, timeout = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const sent = await page.evaluate((message) => {
      const bodyText = document.body ? document.body.innerText || "" : "";

      return bodyText.includes(message);
    }, message);

    if (sent) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

async function sendPublicChat(page, message, logger, client) {
  if (!message) {
    return false;
  }

  try {
    const chatOpened = await openPublicChat(page, logger);

    if (!chatOpened) {
      await screenshot(page, `chat-not-open-${client.username}`, "failure");
    }

    let found = await findChatInput(page);

    if (!found) {
      await sleep(2000);
      found = await findChatInput(page);
    }

    if (!found) {
      throw new Error("Could not find public chat input");
    }

    await fillChatInput(page, found, message);
    await sleep(300);

    const sendClicked = await clickIfVisible(
      page,
      [
        '[data-test="sendMessageButton"]',
        'button[data-test="sendMessageButton"]',
        '[aria-label="Send public message"]',
        '[aria-label*="Send public message"]',
        '[aria-label="Send message"]',
        '[aria-label*="Send message"]',
        '[aria-label="Send"]',
        'button[type="submit"]',
      ],
      5000
    );

    if (!sendClicked) {
      await page.keyboard.press("Enter");
    }

    const messageVisible = await waitForChatMessage(page, message);

    if (!messageVisible) {
      throw new Error("public chat message was not visible after send");
    }

    logger.info(`public chat sent: ${message}`);

    return true;
  } catch (error) {
    logger.error(`public chat failed: ${error}`);
    await screenshot(page, `chat-failed-${client.username}`, "failure");

    return false;
  }
}

async function initClient(browser, logger, joinUrl, client, report, clientStartedAt) {
  const page = await browser.newPage();

  page.setDefaultTimeout(60000);

  await page.setViewport({
    width: 1280,
    height: 720,
  });

  await installClientPatches(page);

  page.on("pageerror", (err) => {
    logger.error(`PAGE ERROR ${client.username}: ${err}`);
  });

  page.on("console", (msg) => {
    logger.debug(`[browser:${client.username}] ${msg.type()} ${msg.text()}`);
  });

  page.on("requestfailed", (request) => {
    logger.debug(
      `[requestfailed:${client.username}] ${
        request.failure() ? request.failure().errorText : "unknown"
      } ${request.url()}`
    );
  });

  page.on("response", (response) => {
    const status = response.status();

    if (status >= 400) {
      logger.debug(
        `[response:${client.username}] status=${status} url=${response.url()}`
      );
    }
  });

  logger.info(`${client.username} joining ${joinUrl}`);

  try {
    let response = null;

    try {
      response = await page.goto(joinUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      logger.debug(
        `${client.username} navigation status=${
          response ? response.status() : "null"
        } url=${page.url()}`
      );
    } catch (error) {
      logger.warn(
        `${client.username} navigation warning: ${error.message}. currentUrl=${page.url()}`
      );

      // BBB may already be loading or redirecting to the HTML5 client.
      // Do not fail immediately here.
    }

    await sleep(5000);

    logger.debug(`${client.username} after join url=${page.url()}`);

    await screenshot(page, `join-${client.username}`, "all");

    const blockingText = await detectBlockingScreen(page);

    if (blockingText) {
      await screenshot(page, `blocking-screen-${client.username}`, "failure");
      throw new Error(`BBB blocking screen detected: ${blockingText}`);
    }

    await waitForClientReady(page, logger, client);

    report.write("client_joined", {
      username: client.username,
      currentUrl: page.url(),
      elapsedMs: Date.now() - clientStartedAt,
    });

    let audioConnected = false;

    try {
      audioConnected = await connectAudio(
        page,
        logger,
        client.microphone,
        client
      );

      report.write("audio_connected", {
        username: client.username,
        mode: client.microphone ? "microphone" : "listen_only",
        success: Boolean(audioConnected),
      });
    } catch (error) {
      report.write("audio_connected", {
        username: client.username,
        mode: client.microphone ? "microphone" : "listen_only",
        success: false,
        error: error.message || String(error),
      });

      throw error;
    }

    await waitForRoom(page, logger);

    if (client.webcam) {
      try {
        const webcamStarted = await startWebcam(page, logger, client);

        report.write("webcam_started", {
          username: client.username,
          success: Boolean(webcamStarted),
        });
      } catch (error) {
        report.write("webcam_started", {
          username: client.username,
          success: false,
          error: error.message || String(error),
        });

        throw error;
      }
    }

    if (client.chatText !== "") {
      const chatSent = await sendPublicChat(
        page,
        client.chatText,
        logger,
        client
      );

      report.write("chat_sent", {
        username: client.username,
        success: Boolean(chatSent),
        message: client.chatText,
      });
    }

    await screenshot(page, `client-ready-${client.username}`, "all");

    report.write("client_ready", {
      username: client.username,
      elapsedMs: Date.now() - clientStartedAt,
      success: true,
    });

    return page;
  } catch (error) {
    await screenshot(page, `client-failed-${client.username}`, "failure");

    try {
      await page.close();
    } catch (_) {}

    throw error;
  }
}

function formatChatText(template, client) {
  return template.replace(/{{\s*username\s*}}/g, client.username);
}

function generateClientConfig(webcam = false, microphone = false, role = "attendee") {
  const botName = username.getRandom();

  const client = {
    username: botName,
    userID: `bot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    webcam,
    microphone,
    role,
  };

  client.chatText = formatChatText(CHAT_TEXT, client);

  return client;
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];

  const workerCount = Math.max(
    1,
    Math.min(concurrency, items.length || 1)
  );

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });

  await Promise.all(workers);
}

async function start(
  bbbClient,
  logger,
  meetingID,
  testDuration,
  clientWithCamera,
  clientWithMicrophone,
  clientListening
) {
  ensureDebugDir();

  const report = createReportWriter(logger);
  const activeClients = [];
  const failedClients = [];
  const requested = {
    webcams: clientWithCamera,
    microphones: clientWithMicrophone,
    listening: clientListening,
    total: clientWithCamera + clientWithMicrophone + clientListening,
  };

  logger.info(`Starting stress test on meeting ${meetingID}`);
  logger.info(`Join mode: ${JOIN_AS}`);
  logger.info(`First client as moderator: ${FIRST_CLIENT_AS_MODERATOR}`);
  logger.info(`Join concurrency: ${JOIN_CONCURRENCY}`);

  report.write("run_started", {
    meetingID,
    requested,
    durationSeconds: testDuration,
    joinConcurrency: JOIN_CONCURRENCY,
  });

  const defaultRole = JOIN_AS === "moderator" ? "moderator" : "attendee";

  const clients = [
    ...Array(clientWithCamera)
      .fill()
      .map(() => generateClientConfig(true, true, defaultRole)),

    ...Array(clientWithMicrophone)
      .fill()
      .map(() => generateClientConfig(false, true, defaultRole)),

    ...Array(clientListening)
      .fill()
      .map(() => generateClientConfig(false, false, defaultRole)),
  ];

  if (FIRST_CLIENT_AS_MODERATOR && clients.length > 0) {
    clients[0].role = "moderator";

    logger.info(
      `${clients[0].username} will join as moderator to start the room`
    );
  }

  let browser = null;
  let runStatus = "success";

  try {
    const attendeePassword = await bbbClient.getAttendeePassword(meetingID);
    const moderatorPassword = await bbbClient.getModeratorPassword(meetingID);

    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      ignoreHTTPSErrors: true,
      args: buildLaunchArgs(logger),
    });

    await runWithConcurrency(clients, JOIN_CONCURRENCY, async (client) => {
      const clientStartedAt = Date.now();

      logger.info(`${client.username} join the conference`);

      report.write("client_started", {
        username: client.username,
        userID: client.userID,
        role: client.role,
        webcam: client.webcam,
        microphone: client.microphone,
        chat: client.chatText !== "",
      });

      try {
        const fallbackPassword =
          client.role === "moderator" ? moderatorPassword : attendeePassword;

        const joinUrl = getJoinUrl(
          bbbClient,
          client,
          meetingID,
          fallbackPassword
        );

        const page = await initClient(
          browser,
          logger,
          joinUrl,
          client,
          report,
          clientStartedAt
        );

        activeClients.push({
          client,
          page,
        });

        await sleep(10000);
      } catch (error) {
        failedClients.push({
          client,
          error,
        });

        report.write("client_failed", {
          username: client.username,
          userID: client.userID,
          role: client.role,
          elapsedMs: Date.now() - clientStartedAt,
          error: error.message || String(error),
        });

        logger.error(
          `Unable to initialize client ${client.username}: ${error}`
        );
      }
    });

    logger.info(
      `All users processed. success=${activeClients.length}, failed=${failedClients.length}`
    );

    report.write("run_clients_processed", {
      success: activeClients.length,
      failed: failedClients.length,
    });

    if (failedClients.length > 0) {
      failedClients.forEach(({ client, error }) => {
        logger.error(
          `FAILED ${client.username}: ${error.message || error}`
        );
      });
    }

    logger.info(`Sleeping ${testDuration}s`);

    await sleep(testDuration * 1000);
  } catch (error) {
    runStatus = "failed";

    report.write("run_error", {
      error: error.message || String(error),
    });

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        logger.warn(`Unable to close browser cleanly: ${error.message}`);
      }
    }

    const finalStatus =
      runStatus === "failed"
        ? "failed"
        : failedClients.length > 0
        ? "partial_failure"
        : "success";

    report.write("run_finished", {
      requestedTotal: requested.total,
      totalSuccess: activeClients.length,
      totalFailed: failedClients.length,
      durationSeconds: testDuration,
      status: finalStatus,
    });
  }

  logger.info("Stress test completed");
}

module.exports = {
  start,
};
