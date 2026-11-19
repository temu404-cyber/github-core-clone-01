// Lifecycle glue between this forge and the trial environment.
//
// The environment hands us its origin in MAKEFUN_ENV_URL. We start the
// forge on a kernel-chosen port, tell the environment which port that is,
// and then keep asking whether the trial is finished. When the
// environment answers that it is, we shut the server down and leave with
// status zero. Nothing here touches the store: every byte the trial
// scores comes from the server that app.ts builds.
//
// The environment owns port 8080, so we never bind a fixed port at all.
// A register call that is refused because another entry registered first
// (HTTP 409) is treated as success: the first registration stands and
// there is nothing left for us to do. A 400 or 405 means our request
// itself is wrong, so we give up at once instead of retrying forever.
// Anything else — a refused connection, a timeout, a 5xx — is retried
// with a backoff, because the environment may still be coming up.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin.length === 0) {
  process.stderr.write("entry: MAKEFUN_ENV_URL is empty, so there is no environment to join\n");
  process.exit(1);
}

const callBudgetMs = 30_000;
const firstBackoffMs = 250;
const maxBackoffMs = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function backoffMs(failures: number): number {
  const capped = failures > 8 ? 8 : failures;
  const wait = firstBackoffMs * 2 ** capped;
  return wait > maxBackoffMs ? maxBackoffMs : wait;
}

type DoneBody = { done?: unknown };

async function postPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(callBudgetMs),
      });
    } catch {
      reply = null;
    }
    if (reply !== null) {
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register failed with HTTP ${reply.status}: ${await reply.text()}`);
      }
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function pollUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(callBudgetMs) });
    } catch {
      reply = null;
    }
    if (reply !== null && reply.ok) {
      const payload = (await reply.json()) as DoneBody;
      if (payload.done === true) return;
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind an ephemeral TCP port");
  }
  process.stdout.write(`entry: forge is listening on port ${bound.port}\n`);
  await postPort(bound.port);
  process.stdout.write("entry: registered with the environment, waiting for done\n");
  await pollUntilDone();
  server.close();
  process.stdout.write("entry: environment says done, shutting down\n");
}

try {
  await run();
  process.exit(0);
} catch (cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`entry: ${detail}\n`);
  process.exit(1);
}
