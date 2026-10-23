import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const modes = ['data', 'activity', 'about'];
let output, directory, entry;

before(async () => {
  // Exercise the real production bootstrap and each lab's real CSS. Only scene
  // rendering and unrelated UI setup are stubbed; Vite still owns the imports,
  // chunk graph, CSS extraction, minification, and generated preload helpers.
  const stubs = new Map([
    ['src/branding/logo-editor.js', 'export const mountLogoEditor = () => () => {};'],
    ['src/ui/panel-appearance.js', 'export const mountPanelAppearance = () => () => {};'],
    ['src/ui/floating-layout.js', 'export const mountFloatingLayout = () => () => {};'],
    ['src/repository/session.js', 'export const flushRepositorySession = async () => {};'],
    ['src/main.js', ''],
    ...modes.map(mode => [`src/${mode}-lab/app.js`, `
      import './style.css';
      export function mount${mode[0].toUpperCase() + mode.slice(1)}Lab() {
        globalThis.__repositoryBuildMount(${JSON.stringify(mode)});
      }
    `]),
  ].map(([path, source]) => [resolve(root, path).replaceAll('\\', '/'), source]));
  const result = await build({
    root, configFile: false, publicDir: false, logLevel: 'silent',
    plugins: [{
      name: 'repository-bootstrap-scene-stubs', enforce: 'pre',
      load(id) { return stubs.has(id) ? stubs.get(id) : null; },
    }],
    build: { write: false, rollupOptions: { input: resolve(root, 'src/bootstrap.js') } },
  });
  output = result.output;
  directory = await mkdtemp(join(tmpdir(), 'quirqy-repository-build-'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const chunk of output.filter(file => file.type === 'chunk')) {
    const destination = join(directory, chunk.fileName);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, chunk.code);
  }
  entry = pathToFileURL(join(directory, output.find(file => file.type === 'chunk' && file.isEntry).fileName));
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

for (const mode of modes) test(`production ${mode} entry loads its stylesheet before mounting`, async () => {
  const links = [], errors = [], mounted = [];
  const names = ['document', 'window', 'location', '__repositoryBuildMount'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let complete;
  const mounting = new Promise(resolve => { complete = resolve; });
  const location = new URL(`https://quirqy.example/${mode}`);
  const document = {
    addEventListener() {},
    getElementsByTagName() { return []; },
    getElementById() { return null; },
    querySelector(selector) {
      const href = selector.match(/^link\[href="([^"]+)"\]/)?.[1];
      return href ? links.find(link => link.href === href && (!selector.includes('stylesheet') || link.rel === 'stylesheet')) || null : null;
    },
    createElement(tag) {
      const element = new EventTarget();
      element.tagName = tag.toUpperCase();
      element.relList = { supports: () => true };
      element.style = {};
      element.setAttribute = (name, value) => { element[name] = value; };
      return element;
    },
    head: { appendChild(link) { links.push(link); } },
    body: { append(element) { errors.push(element.textContent); } },
  };
  let timeout;
  try {
    Object.assign(globalThis, {
      document, location,
      window: { location, dispatchEvent(event) { errors.push(event.payload); return true; } },
      __repositoryBuildMount(value) { mounted.push(value); complete(); },
    });
    // Run the generated modules unchanged with Node's real dynamic importer.
    // The tiny DOM deliberately holds stylesheet load events until asserted.
    await import(`${entry.href}?mode=${mode}`);
    const stylesheet = output.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')
      && String(file.source).includes(`#${mode}-${mode === 'about' ? 'reader' : 'panel'}`));
    assert.equal(stylesheet.length, 1, 'the build emitted the selected lab stylesheet');
    const styles = links.filter(link => link.rel === 'stylesheet');
    assert.deepEqual(styles.map(link => link.href), [`/${stylesheet[0].fileName}`], 'only the selected lab stylesheet is requested');
    assert.deepEqual(mounted, [], 'scene mounting waits for its stylesheet');
    styles[0].dispatchEvent(new Event('load'));
    await Promise.race([mounting, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${mode} did not mount after its CSS loaded`)), 2000);
    })]);
    assert.deepEqual(mounted, [mode]);
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timeout);
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
