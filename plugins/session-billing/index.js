import { loadRuntime } from './runtime.js';
import { createProjection } from './projection.js';

export const name = 'session-billing';
export const inject = ['sessionProjections'];
export async function apply(ctx) {
  const runtime = await loadRuntime();
  await ctx.sessionProjections.register(createProjection(runtime));
}
