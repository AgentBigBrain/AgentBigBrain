/**
 * @fileoverview Fail-closed router for optional local intent-model execution.
 */

import type {
  LocalIntentModelRequest,
  LocalIntentModelResolver,
  LocalIntentModelSignal
} from "./localIntentModelContracts";

/**
 * Executes the optional local intent-model path and fails closed on missing resolvers or errors.
 *
 * @param request - Canonical local intent-model request.
 * @param resolver - Optional local model resolver.
 * @returns Local model signal when one was produced safely, otherwise `null`.
 */
export async function routeLocalIntentModel(
  request: LocalIntentModelRequest,
  resolver?: LocalIntentModelResolver
): Promise<LocalIntentModelSignal | null> {
  if (!resolver) {
    return null;
  }

  try {
    const result = await resolver(request);
    return result ?? null;
  } catch {
    return null;
  }
}
