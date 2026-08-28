# Security Policy

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.

Use the GitHub repository's **Security → Report a vulnerability** (private
advisory) at `github.com/threadwire/mcp-hub/security/advisories/new`.

If the advisory flow is unavailable, email maintainers via the address listed
on the repo's About page.

You can expect an acknowledgment within 48 hours and either a fix or a
mitigation plan within 7 days.

## Scope

In scope:

- Auth bypass (Bearer token → tenant mapping, RFC 8707/9207 handling)
- RBAC enforcement gaps (allow/deny glob escape)
- Audit integrity (input fingerprinting, log tampering)
- SSRF / upstream proxy abuse via `mcp-hub add` targets
- Denial of service (rate-limit bypass, unbounded memory in discovery)

Out of scope:

- The security of upstream MCP servers mcp-hub proxies to
- Client-side token storage on end-user machines