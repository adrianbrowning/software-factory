// Runs in a worker thread, so it loads its own copy of src/run.ts: its withRun queue and in-memory state are empty.
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { withRun, type Workspace } from '../src/run.ts';

const { count, id, ws } = workerData as { count: number; id: string; ws: Workspace };

await Promise.all(
  Array.from({ length: count }, (_, index) =>
    withRun(ws, 'demo', async run => {
      // Yields between the read and the save, so an unlocked writer in the other thread gets in between.
      await sleep(1);
      run.waiting.push(`${id}-${index}`);
    }),
  ),
);
parentPort?.postMessage('done');
