/**
 * THE LOOPHOLE — Server-Side AgentPlan Schema Gate (§2.1.4, §11.2, §11.3)
 * Rejects malformed, oversized (>9), or unauthorized fields before Engine execution.
 */

import type { ActionType, AgentAction, AgentPlan } from './types';

const ALLOWED_TOP_KEYS = new Set(['schemaVersion', 'actions']);
const ALLOWED_ACTION_KEYS = new Set(['type', 'wasteId', 'tileId']);
const ALLOWED_ACTION_TYPES = new Set<ActionType>(['PICK_UP', 'DROP', 'DISPOSE']);

export interface SchemaGateResult {
  valid: boolean;
  plan?: AgentPlan;
  error?: string;
}

export function validateAgentPlanSchema(raw: unknown, maxSteps: number = 9): SchemaGateResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'AgentPlan must be a non-null JSON object.' };
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      return {
        valid: false,
        error: `Unauthorized top-level property "${key}" in AgentPlan. Only schemaVersion and actions are permitted.`,
      };
    }
  }

  if (typeof obj.schemaVersion !== 'string' || obj.schemaVersion.trim() === '') {
    return { valid: false, error: 'AgentPlan.schemaVersion must be a non-empty string.' };
  }

  if (!Array.isArray(obj.actions)) {
    return { valid: false, error: 'AgentPlan.actions must be an array.' };
  }

  if (obj.actions.length < 1 || obj.actions.length > maxSteps) {
    return {
      valid: false,
      error: `AgentPlan.actions length must be between 1 and ${maxSteps} (received ${obj.actions.length}).`,
    };
  }

  const validatedActions: AgentAction[] = [];

  for (let i = 0; i < obj.actions.length; i++) {
    const item = obj.actions[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, error: `Action at index ${i} must be an object.` };
    }
    const act = item as Record<string, unknown>;

    for (const key of Object.keys(act)) {
      if (!ALLOWED_ACTION_KEYS.has(key)) {
        return {
          valid: false,
          error: `Unauthorized key "${key}" at action[${i}]. Arbitrary text, scores, or state overrides are forbidden.`,
        };
      }
    }

    if (typeof act.type !== 'string' || !ALLOWED_ACTION_TYPES.has(act.type as ActionType)) {
      return {
        valid: false,
        error: `Unsupported action type "${String(act.type)}" at action[${i}]. Allowed: PICK_UP, DROP, DISPOSE.`,
      };
    }

    if (typeof act.wasteId !== 'string' || act.wasteId.trim() === '') {
      return {
        valid: false,
        error: `action[${i}].wasteId must be a non-empty string.`,
      };
    }

    const actionType = act.type as ActionType;
    const hasTileId = act.tileId !== undefined && act.tileId !== null && act.tileId !== '';

    if (actionType === 'DROP') {
      if (!hasTileId || typeof act.tileId !== 'string') {
        return {
          valid: false,
          error: `action[${i}] of type DROP requires a string tileId.`,
        };
      }
      validatedActions.push({
        type: 'DROP',
        wasteId: act.wasteId,
        tileId: act.tileId,
      });
    } else {
      if (hasTileId) {
        return {
          valid: false,
          error: `action[${i}] of type ${actionType} must NOT include tileId (received "${String(act.tileId)}").`,
        };
      }
      validatedActions.push({
        type: actionType,
        wasteId: act.wasteId,
      });
    }
  }

  return {
    valid: true,
    plan: {
      schemaVersion: obj.schemaVersion,
      actions: validatedActions,
    },
  };
}
