# Local daemon frontend

`zkapi-clientd` compiles with Rust alone. Its default `/` and `/funding/` page
explains the local client, links to health, wallet status and the model catalog,
and points to the terminal funding and withdrawal commands. It does not contain
OA Chat, initialize a browser wallet, or load proof assets. The monetary API
routes are unchanged.

OA Chat is a separate application that consumes the zkAPI browser SDK. The
zkAPI daemon and Docker image do not clone or build OA Chat, run npm, or require
Node. Start a new terminal-funded wallet using `zkapi client --fund-with-cast`
with the deployment and state-directory settings for that wallet; Foundry's
`cast` is required for that interactive flow. The CLI's explicit opt-in and
signer handling are unchanged.

## Embed a prebuilt app

A downstream application may provide its own static output at compile time:

```bash
ZKAPI_FRONTEND_DIST=/absolute/path/to/prebuilt/funding \
  cargo build --release -p zkapi-clientd
```

The directory must contain a nonempty UTF-8 `index.html` at its root. Relative
paths resolve from `crates/zkapi-clientd`, so an absolute path is recommended.
Assets are embedded byte-for-byte and served below `/funding/` with `no-store`
and `nosniff` headers. The HTML should use `<base href="/funding/">` or equivalent
asset paths. The directory is compile-time input; changing it requires a new
binary. Existing files and directory additions/removals trigger Cargo rebuilds.
Unset the variable to restore the bundled help page. An empty value, invalid
index, unreadable directory, symlink, hidden entry or `node_modules` directory
fails the build. Use a dedicated public output directory, never a source tree
or a directory containing credentials.

The daemon retains its same-origin content security policy and loopback-only
CORS policy. A supplied app must use those local API routes or otherwise work
within that policy; this option does not allow arbitrary external network
origins. API routes such as `/funding/api/status` and `/funding/config` retain
priority over static files. Missing optional assets, including the former
`app.js`, `wallet.js` and OA license paths, return 404 rather than panicking.

The provided Dockerfile uses the default help page. To ship custom embedded
assets, copy only the already-built public directory into a derivative builder
and set `ZKAPI_FRONTEND_DIST` for its `cargo build` command; build OA Chat or any
other host application separately.
