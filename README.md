# NumiOS browser-native core

NumiOS is a client-only operating-system core built from HTML5, small CSS, JSON configuration, and native JavaScript ES modules. It boots in a modern browser, exposes a kernel-owned syscall API, and provides persistent virtual storage, filesystem mounts, capability checks, processes, Workers, IPC, services, NPP packages, repositories, and a developer SDK. There is no desktop, graphical shell, terminal emulator, Node.js runtime, build step, application backend, or package-manager requirement.

## Run from a static origin

Serve this repository as static files from an HTTP(S) origin. For local development, any static file server works; for example, Python's standard-library server:

```sh
python3 -m http.server 8080 --bind 0.0.0.0
```

Open `http://localhost:8080/`. The Python command is only a local static-file server; NumiOS itself has no server component. Production deployment can use any static host. Do not open the files with `file://`: browser ES modules, Workers, and service workers require an HTTP(S) origin, and some APIs require a secure context (HTTPS or localhost).

The root page is text-only boot diagnostics. After a successful boot, the system-control API is exposed as `window.numios`. The default virtual root is stored in IndexedDB (`numios` database); clearing site data removes it. If IndexedDB cannot be opened, boot fails unless `allowEphemeralRoot` was explicitly enabled in `etc/system.json`; an enabled fallback is reported as volatile and is never presented as persistent. OPFS, persistent-storage requests, Web Locks, service workers, clipboard, directory picking, and other optional browser APIs are feature-detected.

## Browser tests

Open `http://localhost:8080/tests/browser.html` from the same static origin. The page runs the test suite directly in the browser without Node.js, npm, external test packages, or a backend. It covers configuration schemas, VFS paths/descriptors, remote-protocol decoding, coordinator cancellation, IndexedDB reopen persistence, and an integrated kernel/syscall/security boot. IndexedDB coverage is explicitly skipped if the browser does not expose IndexedDB. Results and failure details are shown on the test page and in its browser console.

## Programmatic control

```js
await numios.status();
await numios.sys.call('fs.write', {
  path: '/Users/demo/hello.txt',
  data: 'Hello from NumiOS'
});
const result = await numios.sys.call('fs.read', {
  path: '/Users/demo/hello.txt',
  encoding: 'text'
});
await numios.services.list();
// Call this from a user gesture (for example, a button click); it opens the browser picker.
await numios.authorizeDirectory({ mountPoint: '/Volumes/shared', readOnly: true });
await numios.shutdown();
```

Syscall responses use `{ ok, data, error, requestId }`; errors contain stable machine-readable codes. Application code should use the SDK (`import ... from '/sdk/index.js'`) and a port-bound syscall client. The kernel derives the caller from the `MessagePort`, never from a caller ID in an app message. Apps cannot add or replace privileged handlers.

## Architecture

- `boot/`: static asset loading, validated boot configuration, staged startup, recovery, and lifecycle checkpoints.
- `kernel/`: kernel wiring, syscall table/dispatcher, security, process/scheduler, IPC, logical resources, network client, and diagnostics.
- `storage/` and `fs/`: IndexedDB primary store, optional OPFS adapter, atomic key-value batches, virtual tree filesystems, descriptors, and longest-prefix mounts.
- `services/`: JSON `.service` units, dependency ordering, lifecycle, health checks, bounded restart policy, and built-in service adapters.
- `packages/`: NPP parser/verifier, ZIP STORE archive support, semantic versions, repository client, and journaled install/remove/recovery.
- `runtime/`: Worker-backed application/service entry points and service-worker URL adapter for installed NPP modules.
- `sdk/` and `lib/`: application-facing syscall, filesystem, process, IPC, logging, networking, configuration, and package helpers.
- `dev/` and `proc/`: browser-resource devices and state-generated `/proc` files.
- `etc/`: versioned JSON configuration and JSON schemas.

The root filesystem is backed by IndexedDB in persistent mode. `/Temp` is deliberately volatile. OPFS, memory, static, explicitly authorized directory, and JSON-protocol remote adapters are optional. The browser's storage quota and eviction policies still apply; a persistence request is best-effort, not a durability guarantee.

## NPP packages and repositories

NPP v1 is a ZIP-compatible container using STORE (uncompressed) entries, UTF-8 names, CRC-32, and a root `manifest.json`. Files must be declared in the manifest with SHA-256 digests. Unsupported compression, ZIP64, encryption, traversal, duplicate paths, symlinks, undeclared files, and unrestricted install hooks are rejected. Optional signatures use Web Crypto ECDSA P-256/SHA-256 with configured JWK trust keys. No external package service is bundled and no repository is configured by default. See [`docs/npp-v1.md`](docs/npp-v1.md).

Unsigned local packages are denied unless the system configuration and caller explicitly allow them. Applications run in dedicated module Workers where supported; installed module URLs use the service-worker adapter. Unsupported origins or browser APIs produce an explicit error rather than a pretend runtime. Remote repositories and filesystems need compatible public services, CORS, and any required authorization; NumiOS does not provide those services.

## Browser security and lifecycle limits

Syscall capabilities authorize NumiOS operations, but they are not a native security boundary: same-origin JavaScript, including a Worker, may call browser APIs directly. Strong isolation of mutually untrusted apps requires separate origins and browser-enforced policy. Worker workloads can be terminated; same-realm asynchronous work is only cooperatively cancellable. Scheduling, background-tab suspension, storage eviction, CORS, user prompts, and service-worker lifetime remain controlled by the browser. Services cannot keep running after the page/browser execution context closes; persisted state is restored on the next boot.

Browser JavaScript cannot enumerate arbitrary local paths, access raw disks, create native TCP/UDP sockets, or run after the browser closes. Directory mounts require an explicit File System Access API picker and browser permission. Remote mounts use the documented JSON protocol, not WebDAV or arbitrary host paths. These limits are surfaced instead of emulated.

## Extending

Syscall handlers are registered while the kernel is constructed, then the registry is sealed. Add a syscall to `kernel/syscall/syscall-table.json`, validate its boundary inputs, and wire its handler inside `kernel/kernel.js`. Filesystems implement the contract in `fs/filesystem-contract.js`; services are schema-validated JSON units and use the same syscall path. SDK compatibility is versioned independently in `sdk/VERSION`.
