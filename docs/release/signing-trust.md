# Release signing trust

Tool Evolver production releases use an Ed25519 signing identity whose private key is supplied only by the external release workflow secret boundary.

- The historical `tool-evolver-release-v1` identity is permanently revoked because its private half was committed in repository history. It must never be trusted for a production release.
- Production source, test fixtures, npm packages, and release artifacts contain **no private signing key**.
- Production packaging requires `TOOL_EVOLVER_RELEASE_KEY_ID`, `TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM`, and `TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM`. The private key is accepted only in memory and its derived public key must match the externally configured public key.
- `release-trust.json` contains public material only. It is informational metadata; production clients must pin the expected public key/key ID independently rather than trusting the key embedded in downloaded content.
- Unit/integration release tests generate ephemeral Ed25519 identities at runtime with `test-only-*` identifiers, and test evidence is marked `TEST_ONLY`. Production verification rejects both.
- The signed manifest binds the exact Git commit, workflow run identity, package digests, distributed asset digests, and release-evidence digests.
