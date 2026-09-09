# Browser SDK ownership

The former OA-inside-zkAPI composition has been replaced. OA Chat now consumes
`@openanonymity/zkapi-browser-sdk` as an immutable dependency and owns its UI,
payment-mode runtime, routing, and Vercel deployments.

This repository has no OA Chat submodule or browser-chat build. See
[SDK integration](../sdk/README.md) for the host API and asset packaging,
and [the local client guide](local-client-quickstart.md) for the independent
Rust daemon and optional prebuilt frontend support.

The prior composed app and its deployment records remain available in Git
history at `f7e3d08`. Existing trial deployments are unaffected by this source
reorganization. The new OA Chat branch is `codex/zkapi-browser-sdk`.
