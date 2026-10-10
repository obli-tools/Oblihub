import './src/env';
import type { Knex } from 'knex';
import path from 'path';

const isCompiled = __filename.endsWith('.js');

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: isCompiled
      ? path.resolve(__dirname, 'src/db/migrations')
      : path.resolve(__dirname, 'src/db/migrations'),
    extension: isCompiled ? 'js' : 'ts',
    loadExtensions: isCompiled ? ['.js'] : ['.ts'],
  },
};

export default config;
