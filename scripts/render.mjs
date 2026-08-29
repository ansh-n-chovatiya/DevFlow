/**
 * Captures screenshots of built extension pages using headless Chrome.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist');
const OUT = join(root, '.render');

/** Page render configurations with target viewport heights. */
const PAGES = {
  settings: { file: 'settings.html', height: 2400 },
  viewer: { file: 'viewer.html', height: 1800 },
  popup: { file: 'popup.html', height: 700 },
};

/** Candidate paths for local Chrome or Chromium executables. */
const CHROMES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/* --- CLI Arguments --- */

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const wanted = argv.filter((arg) => !arg.startsWith('--') && arg in PAGES);
const pages = wanted.length > 0 ? wanted : Object.keys(PAGES);

/** Settings overrides to inject into the storage sync area. */
const seed = flag('seed') ?? '{}';

/** Search query to simulate on page load. */
const query = flag('query') ?? '';

/**
 * Open the Advanced disclosure before shooting.
 *
 * Phase 6 put twenty-eight settings behind it, and a tool that cannot open it
 * cannot see the half of the screen that phase added. `--query` opens it as a
 * side effect — a search that matches inside Advanced expands it — but that
 * also filters away everything else, so it cannot answer "do these rows look
 * like the rows above them", which is the only question worth rendering for.
 */
const openAdvanced = argv.includes('--open');

/** Viewport height override, for a page that is taller than its default. */
const height = Number(flag('height')) || 0;

/* --- Browser Mocks --- */

/** Mock chrome API stub injected into extension pages. */
const STUB = (overrides) => `<script>
(() => {
  const sync = ${overrides};
  const local = {};
  const pick = (store, keys) => {
    if (keys === null || keys === undefined) return { ...store };
    if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    }
    return { ...keys, ...pick(store, Object.keys(keys)) };
  };
  const area = (store) => ({
    get: (keys, cb) => cb(pick(store, keys)),
    set: (patch, cb) => { Object.assign(store, patch); cb && cb(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; cb && cb(); },
    getBytesInUse: (_keys, cb) => cb(0),
  });
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'render' }),
      getURL: (path) => path,
      sendMessage: (_message, cb) => cb && cb({}),
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: { sync: area(sync), local: area(local), onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: (_q, cb) => cb([]) },
  };
})();
</script>`;

/** Script snippet to drive the page before the shot: search, then disclosure. */
const DRIVE = (text, open) => `<script type="module">
setTimeout(() => {
  ${
    text
      ? `const box = document.querySelector('input[type=search], input[placeholder*=Search]');
  if (box) {
    box.value = ${JSON.stringify(text)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }`
      : ''
  }
  ${open ? `document.querySelector('.advanced__summary')?.click();` : ''}
}, 400);
</script>`;

/* --- Static Server --- */

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  return new Promise((ready) => {
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      const file = join(DIST, path === '/' ? '/settings.html' : path);

      if (!file.startsWith(DIST) || !existsSync(file)) {
        response.writeHead(404).end('no');
        return;
      }

      const type = TYPES[extname(file)] ?? 'application/octet-stream';

      if (type !== 'text/html') {
        response.writeHead(200, { 'content-type': type }).end(readFileSync(file));
        return;
      }

      // Inject storage mock and query drive script into page.
      const html = readFileSync(file, 'utf8')
        .replace('<body>', `<body>${STUB(seed)}`)
        .replace('</body>', `${query || openAdvanced ? DRIVE(query, openAdvanced) : ''}</body>`);

      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });

    server.listen(0, '127.0.0.1', () => ready({ server, port: server.address().port }));
  });
}

/* --- Headless Capture --- */

function shoot(chrome, url, out, height) {
  return new Promise((done, fail) => {
    const child = spawn(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--virtual-time-budget=3000',
        `--window-size=1440,${height}`,
        `--screenshot=${out}`,
        url,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('exit', (code) =>
      code === 0 || existsSync(out) ? done() : fail(new Error(stderr.trim() || `chrome exited ${code}`)),
    );
  });
}

/* --- Execution --- */

if (!existsSync(DIST)) {
  console.error('render: dist/ is not there. Run `npm run build` first — this reads it.');
  process.exit(1);
}

const chrome = CHROMES.find((path) => existsSync(path));
if (!chrome) {
  console.error(
    'render: no Chrome found. Set CHROME to its path:\n' +
      "  CHROME='/path/to/chrome' npm run render",
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const { server, port } = await serve();

try {
  for (const name of pages) {
    const { file, height: tall } = PAGES[name];
    const out = join(OUT, `${name}.png`);
    await shoot(chrome, `http://127.0.0.1:${port}/${file}`, out, height || tall);
    console.log(`render: ${out}`);
  }
} finally {
  server.close();
}
