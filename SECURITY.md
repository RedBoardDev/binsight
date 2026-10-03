# Security policy

## Supported versions

binsight is in early development. Until version 1.0, only the latest commit on `main` receives security fixes.
After 1.0, the latest release does.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead: open the
[Security tab of the repository](https://github.com/RedBoardDev/binsight/security/advisories/new) and choose
**Report a vulnerability**. Include what you found, how to reproduce it and the version you tested (`binsight --version`
or the image tag). Never include a real password or Helius API key.

What to expect:

- a first answer within **7 days**;
- a fix, or a clear explanation of why the report is not a vulnerability;
- coordinated disclosure: the advisory is published once a fixed version is available, with credit to you if you wish.

## Scope

In scope:

- the `binsight` binary and its HTTP API;
- the official container image;
- the web app it serves.

Out of scope:

- attacks that already require shell access to the host, or access to the data directory or the `/data` volume;
- an instance exposed to the Internet over plain HTTP without a TLS reverse proxy (not a supported setup);
- vulnerabilities in third-party services, such as the RPC provider.

## Hardening your instance

- Put the instance behind a reverse proxy with HTTPS before exposing it beyond your local network, or reach it through a
  private network such as a VPN.
- Use a long, unique password (at least 12 characters; longer is better).
- Do not publish the container port directly on the Internet.
- Keep regular copies of the data directory: a backup is a copy of its database file.
