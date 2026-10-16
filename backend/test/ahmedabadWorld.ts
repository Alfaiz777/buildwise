/**
 * The demo brand's Ahmedabad network (L5) on the in-memory test world: the real catalogue sync
 * and the real stock fixture (fixtures/retail/demo-retail.csv), reservations on, a Wednesday
 * at noon in IST. Messages go through the real pipeline as simulator messages.
 */
import { readFileSync } from 'node:fs';
import request from 'supertest';
import type { Logger } from '../src/lib/logger.js';
import type { AgentRuntime } from '../src/ports/agent.js';
import type { AssistantModel } from '../src/ports/assistant.js';
import { bearer, buildTestWorld } from './helpers.js';

const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
const DEMO_CSV = readFileSync(new URL('../fixtures/retail/demo-retail.csv', import.meta.url));
export const WEDNESDAY_NOON_IST = new Date('2026-10-14T06:30:00.000Z');
let n = 0;

export async function ahmedabadWorld(
  options: {
    agent?: AgentRuntime;
    backupAgent?: AgentRuntime;
    logger?: Logger;
    aiBudgetMs?: number;
    assistantModel?: AssistantModel;
    assistantDeadlineMs?: number;
  } = {},
) {
  const world = buildTestWorld({ now: () => WEDNESDAY_NOON_IST, ...options });
  world.retailers.retailers.push({
    brandId: 'brand_A',
    retailerId: 'rtl_north',
    name: 'Ahmedabad Retail Partners',
    status: 'ACTIVE',
  });
  await world.commerceSync.sync('brand_A', SYSTEM);
  const brand = world.brands.brands.find((b) => b.brandId === 'brand_A')!;
  brand.settings = {
    ...brand.settings,
    reservation_policy: { reservations_enabled: true, hold_minutes: 120, max_quantity_per_reservation: 2 },
    human_handoff_rules: { enabled: true },
    online_store: { product_url_template: 'http://shop.test/products/{product_id}' },
  };
  const { record } = await world.retailImports.create('brand_A', SYSTEM, 'demo-retail.csv');
  await world.files.write(record.fileKey, DEMO_CSV, 'text/csv');
  await world.retailImports.process('brand_A', SYSTEM, record.importId);
  const send = (ref: string, content: Record<string, unknown>) =>
    request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({ simulator_customer_ref: ref, client_message_id: `cm_${++n}`, content });
  return {
    world,
    say: (ref: string, text: string) => send(ref, { type: 'TEXT', text }),
    tap: (ref: string, optionId: string) => send(ref, { type: 'INTERACTIVE_REPLY', option_id: optionId }),
    share: (ref: string, latitude: number, longitude: number) => send(ref, { type: 'LOCATION', latitude, longitude }),
  };
}
export type AhmedabadWorld = Awaited<ReturnType<typeof ahmedabadWorld>>;
export type SimulatorResponse = Awaited<ReturnType<AhmedabadWorld['say']>>;
