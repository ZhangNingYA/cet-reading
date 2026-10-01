import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { readConfig } from '@cet-reading/contracts/config';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
export const config = readConfig();
