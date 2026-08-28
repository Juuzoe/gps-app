/**
 * Deployment scope.
 *
 * The engine itself is state-generic; this constant is the only thing that
 * makes a build state-specific. Locking a state skips the state-inference
 * probes on every build (one fewer round of OSM lookups) and removes the
 * state picker from the UI.
 *
 * Texas milestone: locked to TX. For the later milestones set this to
 * undefined and every state works again, with the picker restored.
 */
export const LOCKED_STATE: string | undefined = 'TX'
