# Grilling Web Companion

A self-contained, phone-friendly wizard for design interviews. It uses only Node.js built-ins, binds to the phone itself by default, and stores its local transcript in the ignored `.grilling/sessions.json` file.

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
