import { after, before, beforeEach } from 'node:test';
import { resetDatabase } from './database';
import { buildWorld, type World } from './fixtures';
import { startServer, type TestServer } from './server';

/**
 * The boilerplate every suite needs, written once.
 *
 * A server for the file, an empty database before each test, and a freshly
 * built world — so no test can be made to pass or fail by the one before it.
 * Node runs each test file in its own process, which is also what lets a
 * suite configure the application differently (a payment gateway, an SMS
 * provider) without disturbing the others.
 */
export interface Harness {
  server: () => TestServer;
  world: () => World;
}

export function harness(): Harness {
  let server: TestServer;
  let world: World;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    world = await buildWorld();
  });

  return { server: () => server, world: () => world };
}
