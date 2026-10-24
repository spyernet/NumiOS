# NumiOS remote filesystem JSON protocol v1

A remote mount is a compatible HTTP(S) service, not an arbitrary URL or a WebDAV/native filesystem mount. Requests use `POST <baseUrl>/v1/fs`, `content-type: application/json`, and a JSON envelope:

```json
{
  "protocol": "numios-remote-fs",
  "version": 1,
  "operation": "metadata",
  "path": "/docs/readme.txt"
}
```

Successful responses use `{ "protocol":"numios-remote-fs", "version":1, "ok":true, "data": ... }`; failures use `{ "protocol":"numios-remote-fs", "version":1, "ok":false, "error":{"code":"NOT_FOUND","message":"..."} }`. The adapter supports `health`, `metadata`, `list`, `read`, `write`, `mkdir`, `delete`, `rename`, and `realpath`. Read data is base64 in `data.data`; writes send base64 in the request `data` field. `list` returns an array of stat-like entries; `metadata` and `realpath` return one stat/path object. `rename` may return `NOT_SUPPORTED` if the server cannot provide it atomically.

`Authorization: Bearer <token>` is supplied only by an application-provided token callback; credentials must not be embedded in the URL. The browser enforces CORS, origin policy, user network permission, and connectivity. Read requests can be cached briefly; mutations invalidate local cache entries. The adapter applies timeouts and bounded retries to read operations, but not writes (a lost write response has ambiguous commit status). Add server-side idempotency/ETags and conflict responses for stronger distributed transaction semantics.

A deterministic mock for tests can be built by implementing the same filesystem contract. There is no production service or mock server endpoint bundled with NumiOS.
