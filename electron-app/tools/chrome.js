// tools/chrome.js — Chromium browser discovery, launch, and CDP management
// Supports Chrome, Brave, Edge, Chromium — uses whichever is installed
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';

const CDP_PORT = process.env.NIRO_CDP_PORT || 9222;

// ─── Browser candidates — ordered by preference ───────────────────────────────
function getBrowserCandidates() {
  const lad = process.env.LOCALAPPDATA || '';
  const pf  = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  return [
    // Brave (Chromium-based, very common)
    { exe: path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      userDataDir: path.join(lad, 'BraveSoftware', 'Brave-Browser', 'User Data'), name: 'Brave' },
    { exe: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      userDataDir: path.join(lad, 'BraveSoftware', 'Brave-Browser', 'User Data'), name: 'Brave' },
    { exe: path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      userDataDir: path.join(lad, 'BraveSoftware', 'Brave-Browser', 'User Data'), name: 'Brave' },

    // Chrome stable
    { exe: path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome', 'User Data'), name: 'Chrome' },
    { exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome', 'User Data'), name: 'Chrome' },
    { exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome', 'User Data'), name: 'Chrome' },

    // Chrome Beta / Dev / Canary
    { exe: path.join(lad, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome Beta', 'User Data'), name: 'Chrome Beta' },
    { exe: path.join(lad, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome Dev', 'User Data'), name: 'Chrome Dev' },
    { exe: path.join(lad, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Google', 'Chrome SxS', 'User Data'), name: 'Chrome Canary' },

    // Chromium
    { exe: path.join(lad, 'Chromium', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Chromium', 'User Data'), name: 'Chromium' },
    { exe: path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
      userDataDir: path.join(lad, 'Chromium', 'User Data'), name: 'Chromium' },

    // Microsoft Edge (fallback)
    { exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: path.join(lad, 'Microsoft', 'Edge', 'User Data'), name: 'Edge' },
    { exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: path.join(lad, 'Microsoft', 'Edge', 'User Data'), name: 'Edge' },
  ];
}

/**
 * Find the first installed Chromium-based browser.
 * Returns { exe, userDataDir, name } or throws.
 */
export function getBrowserInfo() {
  for (const candidate of getBrowserCandidates()) {
    try {
      if (fs.existsSync(candidate.exe)) {
        console.log(`[chrome.js] Found browser: ${candidate.name} at ${candidate.exe}`);
        return candidate;
      }
    } catch (_) {}
  }
  throw new Error(
    'No Chromium-based browser found. Install Brave, Chrome, or Edge to use browser automation.'
  );
}

// Keep getChromeExecutable for backward compat
export function getChromeExecutable() {
  return getBrowserInfo().exe;
}

/**
 * Discover profiles from the browser's User Data directory.
 */
export function discoverProfiles(userDataDir) {
  const dir = userDataDir || getBrowserInfo().userDataDir;
  const profiles = [];

  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry !== 'Default' && !entry.startsWith('Profile ')) continue;
      const prefPath = path.join(dir, entry, 'Preferences');
      if (!fs.existsSync(prefPath)) continue;
      try {
        const raw = fs.readFileSync(prefPath, 'utf8');
        const prefs = JSON.parse(raw);
        const accountInfo = prefs?.account_info?.[0];
        const name = accountInfo?.full_name || prefs?.profile?.name || entry;
        const email = accountInfo?.email || '';
        profiles.push({ id: entry, name, email });
      } catch (_) {
        profiles.push({ id: entry, name: entry, email: '' });
      }
    }
  } catch (err) {
    console.warn('[chrome.js] Could not read browser profiles:', err.message);
  }

  return profiles;
}

/**
 * Select the best profile — prefers Google/Gmail accounts, falls back to Default.
 */
export function getDefaultProfile(userDataDir) {
  const profiles = discoverProfiles(userDataDir);
  if (profiles.length === 0) return 'Default';

  const googleProfile = profiles.find(
    p => p.email && (p.email.includes('@gmail.com') || p.email.includes('@google.com'))
  );
  if (googleProfile) return googleProfile.id;

  const defaultProfile = profiles.find(p => p.id === 'Default');
  if (defaultProfile) return defaultProfile.id;

  return profiles[0].id;
}

let browserProcess = null;

/**
 * Launch the best available Chromium browser with remote debugging on CDP port.
 * Uses the user's actual profile so cookies/logins are preserved.
 */
export function launchChrome() {
  const browser = getBrowserInfo();
  const profileId = getDefaultProfile(browser.userDataDir);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--profile-directory=${profileId}`,
    `--user-data-dir=${browser.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
  ];

  console.log(`[chrome.js] Launching ${browser.name}: ${browser.exe}`);
  console.log(`[chrome.js] Profile: ${profileId}, CDP port: ${CDP_PORT}`);

  browserProcess = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
  browserProcess.unref();

  browserProcess.on('error', (err) => {
    console.error('[chrome.js] Browser process error:', err.message);
    browserProcess = null;
  });

  browserProcess.on('exit', (code) => {
    console.log(`[chrome.js] Browser exited with code ${code}`);
    browserProcess = null;
  });

  return browserProcess;
}

/**
 * Check if the CDP endpoint is responding.
 */
export function isChromeCDPReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Poll CDP endpoint until browser is ready or timeout expires.
 */
export async function waitForCDP(timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeCDPReady()) {
      console.log('[chrome.js] Browser CDP is ready');
      return true;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Browser CDP did not become ready within ${timeoutMs}ms`);
}
