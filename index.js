import { apply as quota } from './plugins/opencode-go-quota/index.js';
import { apply as billing } from './plugins/session-billing/index.js';

export const name = 'dsh-toolkit-local';
export const inject = ['webServer', 'sessionProjections', 'connection'];

export async function apply(ctx) {
  quota(ctx);
  await billing(ctx);
}
