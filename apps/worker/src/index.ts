import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.ts";

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  const worker = await Worker.create({
    connection,
    taskQueue: "optimus-tasks",
    workflowsPath: join(
      dirname(fileURLToPath(import.meta.url)),
      "workflows.ts",
    ),
    activities,
  });
  console.log("Optimus Temporal worker listening on optimus-tasks");
  await worker.run();
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
