/**
 * Config file for the knex CLI (`npm run migrate`, `npm run seed`).
 * Lives under src/ so it is type-checked with everything else; the app itself
 * imports src/db/client.ts directly.
 */
import { knexConfig } from './client';

export default knexConfig;
module.exports = knexConfig;
