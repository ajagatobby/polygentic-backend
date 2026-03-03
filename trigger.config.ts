import { defineConfig } from '@trigger.dev/sdk/v3';
import { esbuildPlugin } from '@trigger.dev/build';

/**
 * Custom esbuild plugin that force-marks unresolvable NestJS optional peer
 * dependencies as external. Trigger.dev's built-in `build.external` only works
 * when the package can be resolved from node_modules. Subpaths like
 * `class-transformer/storage` have no top-level entry point and fail resolution
 * under pnpm's strict hoisting, so the built-in externals plugin silently
 * ignores them. This plugin intercepts the bare specifiers at the esbuild
 * resolve phase and marks them external unconditionally.
 */
const nestExternalsPlugin = esbuildPlugin({
  name: 'nest-externals',
  setup(build) {
    // Patterns that should be treated as external regardless of whether
    // they can be resolved from the project root.
    const externalPatterns = [
      '@nestjs/microservices',
      '@nestjs/websockets',
      '@nestjs/platform-express',
      'class-transformer/storage',
    ];

    build.onResolve(
      {
        filter:
          /^(@nestjs\/microservices|@nestjs\/websockets|@nestjs\/platform-express|class-transformer\/storage)/,
      },
      (args) => {
        return { path: args.path, external: true };
      },
    );
  },
});

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
    // The built-in `external` array handles packages that exist in node_modules
    // and can be resolved. We keep it for packages that ARE installed.
    external: [
      '@nestjs/microservices',
      '@nestjs/websockets',
      '@nestjs/websockets/socket-module',
      '@nestjs/platform-express',
    ],
    // The custom esbuild plugin handles subpaths and packages that can't be
    // resolved (e.g. class-transformer/storage has no top-level entry point).
    extensions: [nestExternalsPlugin],
  },
});
