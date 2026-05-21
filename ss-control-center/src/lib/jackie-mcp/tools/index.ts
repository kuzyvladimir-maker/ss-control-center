/**
 * Tool registry — barrel. Importing this module registers every tool.
 * Adding a new category = one new file here + one line in the array.
 */

import { registerTool } from "../registry";

import { tools as listings } from "./listings";
import { tools as orders } from "./orders";
import { tools as customerHub } from "./customer-hub";
import { tools as accountHealth } from "./account-health";
import { tools as alerts } from "./alerts";
import { tools as bundleFactory } from "./bundle-factory";
import { tools as walmartReturns } from "./walmart-returns";

const ALL_TOOLS = [
  ...listings,
  ...orders,
  ...customerHub,
  ...accountHealth,
  ...alerts,
  ...bundleFactory,
  ...walmartReturns,
];

let registered = false;
export function ensureRegistered(): void {
  if (registered) return;
  for (const tool of ALL_TOOLS) registerTool(tool);
  registered = true;
}
