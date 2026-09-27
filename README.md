# Software Factory

A local, deterministic orchestrator that turns one trusted GitHub Issue into a tested, reviewed pull request or native PR Stack, stopping at a human-controlled Merge Boundary.

This project is at the first tracer-bullet stage. The current CLI can capture an immutable Issue Contract from GitHub and persist an atomic run manifest:

```sh
pnpm install
pnpm process issue 'owner/repository#42'
```

## Development

The project uses Node.js, TypeScript, and pnpm 10. TypeScript 5.9 is intentionally pinned because the TypeScript 7 native compiler does not currently provide an Android/Termux binary.

```sh
pnpm test
pnpm typecheck
```

The agreed domain language lives in [CONTEXT.md](./CONTEXT.md). The [MVP design and roadmap](./docs/MVP.md) define the delivery sequence, and durable decisions are recorded in [docs/adr](./docs/adr/).

## Grilling Web Companion

The repository includes a local, phone-friendly wizard used during design interviews. It uses only Node.js built-ins, binds to the phone itself by default, and stores its local transcript in the ignored `.grilling/sessions.json` file.

### Start it

```sh
pnpm start
```

Open <http://127.0.0.1:8787> in the phone's browser. The page checks for new rounds every two seconds.

### Grilling-session bridge

Write each frontier round as JSON:

```json
{
  "questions": [
    {
      "title": "Audience",
      "body": "Who is this for?",
      "recommendation": "Start with maintainers."
    }
  ]
}
```

Publish the round and retain its ID:

```sh
node src/cli.mjs publish /path/to/questions.json
```

Read its answers after submission:

```sh
node src/cli.mjs answers ROUND_ID
```

While a round is open, `answers` returns `{"status":"waiting"}`. The web page waits for the next published round automatically after submission.

The server defaults to private loopback access. Binding it to `0.0.0.0` exposes the unauthenticated page to other devices that can reach the host.
