# Contributing

Thanks for taking the time. Bug reports, documentation fixes and focused pull requests are welcome.

## Reporting a problem

- Security problems: do not open an issue. Follow [SECURITY.md](SECURITY.md).
- Bugs and feature requests: use the issue forms. For a bug, include the version or commit, how you run Server Hub (Docker Compose or not), the relevant log lines (remove secrets such as the setup token) and the steps to reproduce.
- For deployment questions, check [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), especially its troubleshooting table, first.

## Sending a change

1. Open an issue first for anything larger than a small fix, so the direction can be agreed before you write code.
2. Set up the project and run the checks as described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): `python -m pytest`, `ruff check .`, `ruff format --check .` and `npm test` in `web/` (and in `demo/` if you touched `web/` or `demo/`).
3. Keep the change focused. Security-sensitive changes (authentication, sessions, the outbound client, the middleware) need tests.
4. Update the documentation with the change: [docs/API.md](docs/API.md) for the HTTP contract, [.env.example](.env.example) and the README table for settings, and an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. Use Conventional Commits for commit messages (`feat:`, `fix:`, `docs:`; `!` for breaking changes) and open the pull request against `main`.

The frontend rules (no inline scripts or styles, no third-party requests, DOM built with `h()`) are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#content-security-policy-rules).

By contributing you agree that your work is released under the [MIT license](LICENSE).
