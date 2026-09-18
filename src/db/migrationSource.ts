import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Knex } from 'knex';

/**
 * Names a migration by what it is, not by which build ran it.
 *
 * Knex records the filename in `knex_migrations`. Under tsx that filename ends
 * in `.ts`; in the production image, where everything has been compiled, the
 * same migration is a `.js` file. Knex then compares the two lists, finds the
 * `.ts` names missing, and refuses to run anything at all:
 *
 *     Error: The migration directory is corrupt, the following files are
 *     missing: 20260907000100_enable_extensions.ts, ...
 *
 * Which is a confusing way to be told that a developer once pointed a local
 * checkout at the server's database. Recording the name without its extension
 * makes the two worlds agree, permanently.
 */

const require_ = createRequire(__filename);

interface FoundMigration {
  name: string;
  file: string;
}

export class DirectoryMigrationSource implements Knex.MigrationSource<FoundMigration> {
  constructor(private readonly directory: string) {}

  async getMigrations(): Promise<FoundMigration[]> {
    const entries = await fs.promises.readdir(this.directory);

    return entries
      .filter((file) => /\.(ts|js)$/.test(file))
      // Declaration files and source maps sit next to the real thing in a
      // build directory and are not migrations.
      .filter((file) => !file.endsWith('.d.ts') && !file.endsWith('.js.map'))
      .map((file) => ({ name: file.replace(/\.(ts|js)$/, ''), file }))
      // Migrations are ordered by their timestamp prefix, which sorts as text.
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getMigrationName(migration: FoundMigration): string {
    return migration.name;
  }

  async getMigration(migration: FoundMigration): Promise<Knex.Migration> {
    return require_(path.join(this.directory, migration.file)) as Knex.Migration;
  }
}
