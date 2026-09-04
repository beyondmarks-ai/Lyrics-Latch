# Security policy

## Reporting a vulnerability

Please do not publish credentials, exploit details, or private audio in a public issue. Report a suspected vulnerability privately through GitHub Security Advisories for this repository. Include the affected version, reproduction steps, and the expected impact.

## Credential safety

- Keep API keys in `customization/.env`; this file is ignored by Git.
- Restrict YouTube API keys to the YouTube Data API and rotate exposed keys immediately.
- Use Google Application Default Credentials locally. Do not copy credential JSON files into this repository.
- Review `git diff --cached` before every push.

The companion binds to `127.0.0.1` by design. Do not expose its port to the public internet without adding authentication and strict origin controls.
