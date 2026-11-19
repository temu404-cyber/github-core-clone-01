# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/temu404-cyber/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/temu404-cyber/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard
library only: git smart HTTP (upload-pack protocol v2, receive-pack v0),
REST v3, GraphQL v4 and MCP, all served from its own in-memory store — no
git binary, no database, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the trial env at
`$MAKEFUN_ENV_URL`, serves the forge until the env says done, then exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll /done).
- `app.ts` — the HTTP server and the git smart-HTTP handlers.
- `gitcore.ts` — git objects, trees, commits, packfiles and pkt-lines.
- `store.ts` — repositories, refs, issues, pull requests and merges.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a small GraphQL parser and executor for the v4 surface.
- `mcp.ts` — the MCP endpoint (JSON-RPC 2.0 over Streamable HTTP).
- `scenario.ts` — derives the token owner's login from the contest's fixed scenario seed.
- `ids.ts` — opaque, stable global ids shared by REST, GraphQL and MCP.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8wf5mahh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
