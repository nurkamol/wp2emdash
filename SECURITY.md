# Security policy

wp2emdash handles real client sites: WordPress exports, migration keys, Cloudflare tokens and form data. Please report
security problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
[github.com/nurkamol/wp2emdash](https://github.com/nurkamol/wp2emdash/security/advisories/new). Please do not open a
public issue.

Include what you found, how to reproduce it (with synthetic data — never a real site's export, credentials or form
messages), and what an attacker could do with it. You will get an answer within 7 days. Fixes are released as soon as
they are ready, and you are credited in the changelog unless you would rather not be.

## Supported versions

Only the latest release on `main` gets security fixes. The plugins under `packages/` are 0.x and follow the kit.

## In scope

- The kit CLI and dashboard (`src/`), including how it stores and uses secrets (`.env`, Wrangler secrets).
- The starter site (`starter/`): middleware, CSP, forms, comments, consent.
- The EmDash plugins in `packages/` (forms, sharing images, SEO & analytics, site health, backups, privacy & consent,
  media, change requests, comments).

Vulnerabilities in EmDash, Astro, Cloudflare or WordPress themselves belong with those projects.

## What the kit promises

- It never writes to the live WordPress site, its database or its DNS.
- Secrets never go into code, logs, reports or commits; `sites/<slug>/` is gitignored.
- Production DNS, routes and deploys need the site owner's explicit approval.
- Sites marked `sensitiveData: true` keep form data out of Workers storage, email bodies and analytics.

A way to break any of these is a security bug.
