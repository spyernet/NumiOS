# NumiOS JavaScript SDK

Applications and services use the `numios-js` runtime. In an app Worker entry module, import the public SDK from `/sdk/index.js` (or use relative modules packaged in the same NPP). The app's entry module exports `async function main(sdk, { args, env, pid, applicationId })`. A service worker entry exports `async function start(sdk, { pid, serviceName, config })` and may return `{ stop() }`.

```js
import { FilesystemSDK } from '/sdk/index.js';

export async function main(sdk, { args }) {
  await sdk.fs.mkdir('/Users/demo/Example', { recursive: true });
  await sdk.fs.writeText('/Users/demo/Example/hello.txt', 'Hello from NumiOS');
  const text = await sdk.fs.readText('/Users/demo/Example/hello.txt');
  await sdk.log.info('example', text, { args });
  return 0;
}
```

`ApplicationSDK` exposes `fs`, `system`, `process`, `ipc`, `network`, `repository`, `packages`, `log`, `resources`, and `call(name,args)`. Methods unwrap the common syscall result and throw `NumiOSError` on failure. Low-level callers can use `SyscallClient` and inspect `{ok,data,error,requestId}` directly. The worker's syscall `MessagePort` is bound to a kernel-created process identity; callers cannot select a PID in each request. Capabilities are selected by package policy and checked by the kernel on each operation.

The SDK version is `sdk/VERSION`. Public method semantics are stable within major version 1. New APIs are additive; changes to existing behavior require a major version or a documented deprecation interval. The optional `ModuleLoader` maps `@numios/*` names for tools that resolve modules; native browser Workers do not provide general bare-specifier resolution. NPP source should use explicit relative imports or absolute same-origin SDK URLs.

NumiOS has no GUI or browser-native interactive shell. A developer interface can use `window.numios.sys.call`, `window.numios.status`, `window.numios.health`, and the package/service/configuration helpers on the bootstrap page. This control object is a same-origin privileged system interface, not an untrusted-app API.
