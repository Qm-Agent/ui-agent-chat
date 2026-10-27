# Security policy (pre-release)

UIWarden is undergoing an open-source readiness review. There is no publicly supported release yet.

Do not attach credentials, complete session folders, browser profiles, screenshots, or database files to public issues. Report vulnerabilities privately to the repository maintainers through a private channel provided by the hosting organization. Include a minimal reproduction and redacted evidence. Do not test against another person's environment without authorization.

The current API lacks first-party authentication. The open-source client binds to loopback and stores data locally. Do not expose its local service to an untrusted network. See the [client guide](docs/CLIENT_GUIDE.md) for data locations and release boundaries.

## Credential rotation before publication

Run `npm run check:open-source-history` against the private repository before creating a public remote. When historical environment objects are found, the checker prints only affected environment variable names and suppresses every value. For each reported key name, the credential owner must revoke or rotate the credential at its issuing service, update private deployment secrets, and record the rotation date and owner in a private release ticket. Never put old or replacement values in a Git commit, issue, build log, or public checklist.

After rotation, publish only the history-free `opensource-clean` branch or an archive produced by `npm run export:open-source-snapshot`. Deleting a file in a later commit, force-pushing an unverified rewrite, or changing `.gitignore` does not revoke a credential and is not sufficient evidence of cleanup.
