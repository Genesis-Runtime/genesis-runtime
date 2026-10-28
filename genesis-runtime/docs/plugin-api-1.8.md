# Plugin API 1.8: public routes and plugin-served apps

Core API 1.8.0 lets a plugin serve a whole web app from a Genesis host: its own page at `/` and its own API under `/api`, used by browsers that have no Genesis admin token. Both changes are additive; 1.7 manifests normalise as before.

## Public routes

Core protects every unsafe request under `/api` (and every read, with `GENESIS_PROTECT_API_READS=1`) with the admin token, because a plugin route is assumed to be an admin action. An app's API is not: its callers authenticate some other way, such as a signed header from a reverse proxy, or are deliberately anonymous.

A plugin lists those routes as path prefixes:

```js
// manifest.permissions.publicRoutes: ["/api/chat", "/api/sessions"]
```

A prefix covers itself and everything below it at a path-segment boundary: `/api/chat` covers `/api/chat` and `/api/chat/stream`, not `/api/chatroom`. Requests to a public route skip the admin-token and origin checks entirely, so **the plugin must authenticate its callers itself**.

Core's own routes cannot be claimed: a prefix that overlaps `/api/plugins`, `/api/admin-token`, `/api/runtime`, `/api/context`, `/api/model-providers`, `/api/ui`, `/api/security`, `/api/health` or `/api/compat` (including a bare `/api`) is ignored and recorded as a plugin failure. Routes of disabled or hidden plugins are not public.

Hosts pass `isPublicRoute` to `createAdminSecurity`; the manager offers `isPublicRoute(path)` and `listPublicRoutes()`. The bundled server wires them together.

## Plugin routes before static files

The bundled server now registers plugin routes before its static files (`public/`, `/observer-compat`). A plugin that serves `GET /` replaces the Genesis status page; without one, `/` is the status page as before. `/observer-compat/...` stays available either way unless a plugin serves that path itself.
