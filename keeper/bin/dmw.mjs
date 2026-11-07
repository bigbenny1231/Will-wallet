#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so `npx dmw <cmd>` works without a build step.
import { register } from 'tsx/esm/api';
register();
await import('../src/cli.ts');
