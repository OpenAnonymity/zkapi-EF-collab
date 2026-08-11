# Authentication

Version 2 has one protocol authentication construction: the private
state-anchor chain described in [design-note.md](design-note.md). A request
proof demonstrates knowledge of an active note and, after genesis, a valid
server signature on the current private balance commitment and anchor.

The old swappable blind-signature and XMSS modes are not v2 wire protocols.
The `auth_scheme` field may still appear in app-layer observability structures
during code cleanup, but deployments and clients must use `state-anchor`.
