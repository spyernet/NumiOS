const CACHE_NAME = 'numios-static-v1';
const DATABASE_NAME = 'numios';
const DATABASE_VERSION = 1;
const OBJECT_STORE = 'records';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const response = await fetch('/offline-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`offline manifest HTTP ${response.status}`);
      const files = await response.json();
      if (!Array.isArray(files)) throw new Error('offline manifest must be an array');
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(files);
    } catch (error) {
      // A first install can still operate online; future fetches populate the cache.
      await self.registration?.active?.postMessage?.({ type: 'numios:precache-warning', message: error.message });
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('numios-static-') && key !== CACHE_NAME) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__numios__/apps/')) {
    event.respondWith(servePackageModule(url));
    return;
  }
  if (url.pathname.startsWith('/__numios__/system/')) {
    event.respondWith(serveSystemModule(url));
    return;
  }
  if (url.pathname === '/service-worker.js') return;
  event.respondWith(staticOfflineFetch(request));
});

async function staticOfflineFetch(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(`NumiOS offline asset unavailable: ${error.message}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function servePackageModule(url) {
  let database;
  try {
    const pieces = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (pieces.length < 5 || pieces[0] !== '__numios__' || pieces[1] !== 'apps') return notFound();
    const [, , id, version, ...pathParts] = pieces;
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return notFound();
    if (pathParts.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) return notFound();
    const path = pathParts.join('/');
    database = await openDatabase();
    const metadata = await getRecord(database, `packages/db/${id}`);
    if (!metadata || metadata.type !== 'application' || metadata.version !== version) return notFound();
    const data = await getRecord(database, `packages/files/${id}/${path}`);
    if (!data) return notFound();
    return moduleResponse(toBytes(data), mimeType(path));
  } catch (error) {
    return new Response(`NumiOS package module unavailable: ${error.message}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } finally {
    database?.close();
  }
}

async function serveSystemModule(url) {
  let database;
  try {
    const pieces = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (pieces.length < 3 || pieces[0] !== '__numios__' || pieces[1] !== 'system' || pieces.some(part => part === '.' || part === '..' || part.includes('\\'))) return notFound();
    const path = `/${pieces.slice(2).join('/')}`;
    database = await openDatabase();
    const file = await readRootFile(database, path);
    if (!file || file.type !== 'file') return notFound();
    return moduleResponse(file.data, mimeType(path));
  } catch (error) {
    return new Response(`NumiOS system module unavailable: ${error.message}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } finally {
    database?.close();
  }
}

function moduleResponse(bytes, contentType) {
  return new Response(bytes, { status: 200, headers: {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin'
  } });
}
function mimeType(path) {
  if (/\.(mjs|js)$/i.test(path)) return 'text/javascript; charset=utf-8';
  if (/\.json$/i.test(path)) return 'application/json; charset=utf-8';
  if (/\.wasm$/i.test(path)) return 'application/wasm';
  return 'application/octet-stream';
}
function notFound() { return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE)) database.createObjectStore(OBJECT_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}
function getRecord(database, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OBJECT_STORE, 'readonly');
    const request = transaction.objectStore(OBJECT_STORE).get(key);
    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB read aborted'));
  });
}
async function readRootFile(database, path) {
  const parts = path.split('/').filter(Boolean);
  let id = 'root';
  for (let index = 0; index < parts.length; index += 1) {
    const entry = await getRecord(database, `fs/root/entry/${id}/${encodeURIComponent(parts[index])}`);
    if (!entry) return null;
    const inode = await getRecord(database, `fs/root/inode/${entry}`);
    if (!inode) return null;
    if (index < parts.length - 1 && inode.type !== 'directory') return null;
    id = inode.id;
    if (index === parts.length - 1) {
      if (inode.type !== 'file') return { type: inode.type };
      const data = await getRecord(database, `fs/root/content/${id}`);
      return data ? { type: 'file', data: toBytes(data) } : { type: 'file', data: new Uint8Array() };
    }
  }
  return null;
}
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}
