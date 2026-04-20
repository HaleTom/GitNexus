/**
 * Per-language `EmitProvider` registry — the lookup the generic
 * `scopeResolutionPhase` uses to pick the right provider for each
 * migrated language.
 *
 * Adding a language is two lines: implement an `EmitProvider` in
 * `languages/<lang>/emit/index.ts` and register it here. The phase
 * picks it up automatically — no workflow changes, no per-language
 * pipeline phase file.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { EmitProvider } from './emit-core/emit-provider.js';
import { pythonEmitProvider } from './languages/python/emit/index.js';

/** Map of `SupportedLanguages` → `EmitProvider`. The phase iterates
 *  this map intersected with `MIGRATED_LANGUAGES` (the per-language
 *  flag set) so adding a provider here without flipping the flag is
 *  safe — the provider sits idle until the language is migrated. */
export const EMIT_PROVIDERS: ReadonlyMap<SupportedLanguages, EmitProvider> = new Map<
  SupportedLanguages,
  EmitProvider
>([[SupportedLanguages.Python, pythonEmitProvider]]);

export function getEmitProvider(lang: SupportedLanguages): EmitProvider | undefined {
  return EMIT_PROVIDERS.get(lang);
}
