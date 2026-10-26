import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApi } from "./app.ts";
import { bootSlack } from "./slack.ts";

const { app, enqueueTask, decideForTask } = createApi(
  process.env.API_ACCESS_TOKEN,
);
const host = process.env.API_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "::1", "localhost"].includes(host))
  throw Error("Refusing non-loopback API host");
const port = Number(process.env.API_PORT ?? "3001");
serve({ fetch: app.fetch, hostname: host, port }, () =>
  console.log(`Optimus API listening at http://${host}:${port}`),
);
void bootSlack({ enqueueTask, decideForTask }).catch((e) =>
  console.error("Slack unavailable", e),
);
