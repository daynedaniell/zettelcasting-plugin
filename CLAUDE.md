# ZettelCasting plugin — working notes

Obsidian community plugin that publishes notes from the vault to the
ZettelCasting service. Talks to the NestJS API at `~/code/zettelcasting-nestjs`.

## Dashboard blocks

Markdown code block processors (`zc-connections`, and later blocks) that render
account and publishing status inside an ordinary note. They sit on a shared
cache-first API client in `src/dashboard/`.

Read [docs/dashboard-spec.md](docs/dashboard-spec.md) before touching any of it
— it records the architecture decisions (code blocks rather than a custom view,
`requestUrl` rather than `fetch`, cache-first rendering, no network before the
user connects an account), the `GET /api/integrations/pkm/status` contract, and
the refresh and teardown rules.
