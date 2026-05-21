Rolled out — `bundle-20260518-083526-b22a915-viewer-grant`.

**Root cause:** `<iframe src=...>` requests don't carry the `Authorization: Bearer ...` header — only cookies. So the verifier middleware rejected every viewer request with "missing bearer token".

**Fix — short-lived HMAC grant cookie:**

1. **`auth/grant.go`** (new): `GrantStore` mints a `v1.<base64-payload>.<hmac>` token. Payload includes the user identity (subject, email, groups, isAdmin), a URL-prefix scope, and an exp timestamp. HMAC secret is random per-process — grants don't survive restarts (fine for 10-minute viewer sessions, the UI just re-grants).
2. **`auth/oidc.go`** — `Verifier.Middleware` falls back to `GrantStore.FromRequest` when there's no Bearer. The grant carries its own scope check (token's scope must be a prefix of the request path), so a cookie minted for `/aistorage/pvc/foo/viewer/` can't authenticate `/api/v1/whoami`.
3. **`api/aistorage.go`** — new `POST /pvc/{name}/viewer/grant`. Requires Bearer (it's in the verifier-protected group). Mints a 10-minute token scoped to the viewer path and sets it as an HttpOnly, `SameSite=Lax`, path-scoped cookie.
4. **Frontend `PVCManager.tsx`** — "Open viewer" now calls `pvcViewerGrant(ns, pvc)` first, shows a Spin loader, and only mounts the iframe once the cookie is set.
