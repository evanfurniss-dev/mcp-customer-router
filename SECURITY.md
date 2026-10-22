# Security policy

## Report a vulnerability

Use [GitHub's private vulnerability report form](https://github.com/evanfurniss-dev/mcp-customer-router/security/advisories/new). Describe the affected version, expected access boundary, and steps to reproduce with synthetic data.

Do not post credentials, customer records, authorization links, or exploitable security details in public issues. If private reporting is unavailable, open a public issue requesting a private contact without disclosing the vulnerability.

There is no guaranteed response time. Security fixes target the latest release; older versions may require an upgrade.

## Access boundary

The router checks customer organization identity and local folder bindings before exposing Glide tools. Its dashboard binds to loopback and checks browser requests. Credentials and settings backups use private file permissions.

All processes still run under the same operating-system user. An agent or process with broad file access can read other customer credentials. Use a separate execution boundary when customers or agents are not mutually trusted.

Removing a local connection does not revoke its grant at Glide. Use Glide's access controls to revoke access after suspected credential exposure. A cancelled or timed-out tool call does not establish that a remote write was rolled back.
