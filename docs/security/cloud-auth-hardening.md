# Cloud authentication hardening

Production and staging deployments reject development tenant-header authentication, require explicit non-default credentials and durable infrastructure, enforce route-level authorization scopes, bound request bodies, and use an explicit CORS origin allowlist. Generic queue submission remains available only in development and test environments.
