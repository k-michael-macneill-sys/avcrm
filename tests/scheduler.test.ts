import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScheduler, type ScheduledJob } from '../src/jobs/scheduler';

/**
 * The scheduler's three promises, tested against jobs built for the purpose.
 *
 * The real four finish in milliseconds, which makes the case that matters
 * — a signal arriving while a job is still running — impossible to stage
 * against them. `stop_grace_period: 60s` in the compose file exists for
 * exactly that case, so it is worth holding to something.
 */

const NEVER = 60_000;

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls rather than guessing a sleep long enough to cover a slow machine. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await delay(5);
  }
}

function job(name: string, run: ScheduledJob['run'], everyMs = NEVER): ScheduledJob {
  return { name, everyMs, delayMs: 5, run };
}

describe('the scheduler', { timeout: 20_000 }, () => {
  it('waits for a job that is still running when the signal arrives', async () => {
    const held = gate();
    let entered = false;
    let finished = false;

    const scheduler = createScheduler([
      job('slow', async () => {
        entered = true;
        await held.promise;
        finished = true;
        return { ok: true };
      }),
    ]);

    scheduler.start();
    await until(() => entered);
    assert.deepEqual(scheduler.running, ['slow'], 'the job should be in flight');

    let drained = false;
    const draining = scheduler.drain('SIGTERM').then(() => {
      drained = true;
    });

    // This is the whole point: the signal has been delivered and the job has
    // not finished, so shutdown must still be waiting.
    await delay(60);
    assert.equal(drained, false, 'drain resolved while a job was still running');
    assert.equal(finished, false);

    held.open();
    await draining;

    assert.equal(finished, true, 'the job should have been allowed to finish');
    assert.equal(drained, true);
    assert.deepEqual(scheduler.running, []);
  });

  it('still shuts down when the job that is running throws', async () => {
    const held = gate();
    let entered = false;

    const scheduler = createScheduler([
      job('doomed', async () => {
        entered = true;
        await held.promise;
        throw new Error('the gateway was unreachable');
      }),
    ]);

    scheduler.start();
    try {
      await until(() => entered);

      // Order matters: the signal has to arrive while the job is still held,
      // otherwise this proves nothing about shutting down mid-run.
      const draining = scheduler.drain('SIGTERM');
      held.open();

      // allSettled, not all — a job failing on the way out must not leave the
      // process hanging or reject the shutdown.
      await draining;
      assert.deepEqual(scheduler.running, []);
    } finally {
      // Both are idempotent, so this only matters when an assertion above
      // threw and the run would otherwise hang.
      held.open();
      await scheduler.drain('SIGTERM');
    }
  });

  it('never starts a job on top of itself', async () => {
    const held = gate();
    let starts = 0;

    const scheduler = createScheduler([
      job(
        'overlapping',
        async () => {
          starts += 1;
          await held.promise;
          return null;
        },
        10,
      ),
    ]);

    scheduler.start();
    try {
      await until(() => starts >= 1);

      // Several intervals elapse while the first run is still held open.
      await delay(80);
      assert.equal(starts, 1, 'a second run started on top of the first');
    } finally {
      // Unconditional: if the guard ever regresses this test must fail, not
      // hang the run on an interval that never stops and a gate never opened.
      held.open();
      await scheduler.drain('SIGTERM');
    }
  });

  it('starts no new work once it is draining', async () => {
    let runs = 0;
    const scheduler = createScheduler([
      job(
        'quick',
        async () => {
          runs += 1;
          return null;
        },
        10,
      ),
    ]);

    scheduler.start();
    await until(() => runs > 0);

    await scheduler.drain('SIGTERM');
    const after = runs;

    await delay(60);
    assert.equal(runs, after, 'a job ran after the scheduler had drained');
  });

  it('is safe to signal twice', async () => {
    const scheduler = createScheduler([job('quiet', async () => null)]);
    scheduler.start();

    await scheduler.drain('SIGTERM');
    await scheduler.drain('SIGINT');
    assert.deepEqual(scheduler.running, []);
  });

  it('keeps running the others when one job throws every time', async () => {
    let good = 0;
    const scheduler = createScheduler([
      job(
        'bad',
        async () => {
          throw new Error('nope');
        },
        10,
      ),
      job(
        'good',
        async () => {
          good += 1;
          return null;
        },
        10,
      ),
    ]);

    scheduler.start();
    await until(() => good >= 2, 3000);

    await scheduler.drain('SIGTERM');
    assert.ok(good >= 2, 'the healthy job should have kept its schedule');
  });
});
