import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'proj_vxjafqrlliypvyfbcnpl',
  runtime: 'node',
  logLevel: 'log',
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ['./src/trigger'],
  build: {
    // Mark NestJS optional peer dependencies as external so esbuild doesn't
    // try to resolve them at bundle time. These are dynamically required by
    // @nestjs/core but never actually used by Trigger.dev tasks (which use
    // standalone service instantiation via src/trigger/init.ts).
    external: [
      '@nestjs/microservices',
      '@nestjs/websockets',
      '@nestjs/platform-express',
      'class-transformer/storage',
    ],
  },
});
