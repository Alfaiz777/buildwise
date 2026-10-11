/**
 * Execution profiles (docs/03_TECH_ARCHITECTURE.md §2.2, docs/07_SECURITY_SPEC.md §19).
 * One logical architecture; only the adapters behind the five ports change.
 */

export const PROFILES = ['local', 'gcp'] as const;
export type Profile = (typeof PROFILES)[number];

export type CommerceSelection = 'mock' | 'shopify';
export type MessagingChannelSelection = 'simulator' | 'whatsapp';
export type AgentRuntimeSelection = 'mock' | 'adk_gemini';
export type FileStorageSelection = 'local' | 'gcs';
export type EventSinkSelection = 'local' | 'bigquery';

export interface AdapterSelection {
  commerce: CommerceSelection;
  messagingChannels: MessagingChannelSelection[];
  agentRuntime: AgentRuntimeSelection;
  fileStorage: FileStorageSelection;
  eventSink: EventSinkSelection;
}

export const PROFILE_DEFAULTS: Record<Profile, AdapterSelection> = {
  local: {
    commerce: 'mock',
    messagingChannels: ['simulator'],
    agentRuntime: 'mock',
    fileStorage: 'local',
    eventSink: 'local',
  },
  gcp: {
    commerce: 'shopify',
    // The simulator stays available in gcp as the approved fallback channel (BRAND_ADMIN only).
    messagingChannels: ['whatsapp', 'simulator'],
    agentRuntime: 'adk_gemini',
    fileStorage: 'gcs',
    eventSink: 'bigquery',
  },
};

/** Local profile talks to the Firebase emulators unless told otherwise. */
export const DEFAULT_EMULATOR_HOSTS = {
  firestore: '127.0.0.1:8085',
  auth: '127.0.0.1:9099',
} as const;

/**
 * Startup guard: the gcp profile refuses every mock/local infrastructure adapter
 * and the Firebase emulators. Returns the list of violations (empty = allowed).
 *
 * `stagedRollout` (L1, GCP_STAGED_ROLLOUT=true — temporary): while the Gemini and
 * WhatsApp adapters are still being built, the gcp profile may run the mock agent. That is
 * the only exception; the simulator channel is allowed in gcp anyway (approved fallback).
 */
export function profileViolations(
  profile: Profile,
  adapters: AdapterSelection,
  usingEmulators: boolean,
  stagedRollout = false,
): string[] {
  if (profile !== 'gcp') return [];
  const violations: string[] = [];
  if (adapters.commerce === 'mock') violations.push('COMMERCE_PROVIDER=mock');
  if (adapters.agentRuntime === 'mock' && !stagedRollout) violations.push('AGENT_RUNTIME=mock');
  if (adapters.fileStorage === 'local') violations.push('FILE_STORAGE=local');
  if (adapters.eventSink === 'local') violations.push('EVENT_SINK=local');
  if (usingEmulators) violations.push('Firebase emulator hosts');
  // SimulatorMessagingProvider is explicitly allowed (approved fallback channel).
  return violations;
}

/**
 * What a staged gcp rollout runs instead of the target adapters (shown at startup and in
 * /api/health). Empty outside a staged gcp rollout.
 */
export function stagedAdapters(profile: Profile, adapters: AdapterSelection, stagedRollout: boolean): string[] {
  if (profile !== 'gcp' || !stagedRollout) return [];
  const staged: string[] = [];
  if (adapters.agentRuntime === 'mock') staged.push('AGENT_RUNTIME=mock');
  if (!adapters.messagingChannels.includes('whatsapp')) staged.push('MESSAGING_CHANNELS=simulator');
  return staged;
}
