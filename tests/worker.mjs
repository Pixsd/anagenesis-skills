import * as fs from "node:fs/promises";
import { Store, create, submit, restore, resolve } from "../dist/index.js";
const job = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
try {
  const store = await Store.open({
    storePath: job.storePath,
    onPhase: async (phase) => {
      if (phase !== job.phase) return;
      if (job.mode === "crash") process.kill(process.pid, "SIGKILL");
      if (job.mode === "pause") {
        process.send?.({ phase });
        await new Promise((resolve) => process.once("message", resolve));
      }
    },
  });
  const result = await { create, submit, restore, resolve }[job.command](
    store,
    job.request,
  );
  process.send?.({ result });
  process.stdout.write(JSON.stringify({ result }) + "\n");
} catch (e) {
  process.send?.({ error: e.toJSON?.() ?? { message: e.message } });
  process.stdout.write(
    JSON.stringify({ error: e.toJSON?.() ?? { message: e.message } }) + "\n",
  );
}
process.disconnect?.();
