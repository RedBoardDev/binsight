# Security policy

## Supported versions

binsight is in early development. Until version 1.0, only the latest commit on `main` receives security fixes.
After 1.0, the latest release does.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead: open the
[Security tab of the repository](https://github.com/RedBoardDev/binsight/security/advisories/new) and choose
**Report a vulnerability**. Include what you found, how to reproduce it and the version you tested (`binsight --version`
or the commit you built). Never include a real password or Helius API key.

What to expect:

- a first answer within **7 days**;
- a fix, or a clear explanation of why the report is not a vulnerability;
- coordinated disclosure: the advisory is published once a fixed version is available, with credit to you if you wish.

## Scope

In scope:

- the `binsight` binary and its HTTP API;
- the container image built from the repository's `Dockerfile`;
- the web app it serves.

Out of scope:

- attacks that already require shell access to the host, or access to the data directory or the `/data` volume;
- an instance exposed to the Internet over plain HTTP without a TLS reverse proxy (not a supported setup);
- vulnerabilities in third-party services, such as the RPC provider.

## Sign-in protection

- Failed sign-ins are slowed down per client address: after three failures, each attempt from that address waits 1, 2,
  4… seconds, up to a minute; an hour without failures, or a successful sign-in, clears the count. Someone guessing
  from one address does not lock you out from another.
- Failures from all addresses together also count against a larger allowance (30 per hour before any delay), so
  guessing from many addresses at once is slowed down as well. During such an attack, your own sign-in may have to
  wait up to a minute too: that is the price of the backstop.
- Behind a reverse proxy every request comes from the proxy's address. Set `BINSIGHT_CLIENT_IP_HEADER` to the header
  your proxy writes the client's address into, and only then: a client that reaches binsight directly could put any
  address in that header.

## Sessions

- A session lasts 30 days. Signing out deletes the session cookie from that browser; the server keeps no session
  list, so a cookie copied before then stays valid until it expires. An open live-update stream ends when its
  session expires.
- To sign every device out, stop binsight, run `binsight admin rotate-sessions`, and start it again. Changing the
  password signs everyone out too.

## Hardening your instance

- Put the instance behind a reverse proxy with HTTPS before exposing it beyond your local network, or reach it through a
  private network such as a VPN.
- Use a long, unique password (at least 12 characters; longer is better).
- Do not publish the container port directly on the Internet.
- Keep regular copies of the data directory: a backup is a copy of its database file.
