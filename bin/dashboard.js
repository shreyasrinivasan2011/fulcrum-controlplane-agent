#!/usr/bin/env node
/* Start the live dashboard.  node bin/dashboard.js [--port 4173] */

import { startDashboard } from '../src/dashboard.js';

try { process.loadEnvFile('.env'); } catch { /* rely on the environment */ }

const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 4173;

const { connection, url } = await startDashboard({ port });

console.log(`\n  Fulcrum control-plane agent — live dashboard`);
console.log(`  connected as ${connection.user.email} · ${connection.workspace.name} · role ${connection.role} (${connection.mode})`);
console.log(`\n  →  ${url}\n`);
console.log(`  ctrl-c to stop.\n`);
