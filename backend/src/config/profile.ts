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
 */
export function profileViolations(profile: Profile, adapters: AdapterSelection, usingEmulators: boolean): string[] {
  if (profile !== 'gcp') return [];
  const violations: string[] = [];
  if (adapters.commerce === 'mock') violations.push('COMMERCE_PROVIDER=mock');
  if (adapters.agentRuntime === 'mock') violations.push('AGENT_RUNTIME=mock');
  if (adapters.fileStorage === 'local') violations.push('FILE_STORAGE=local');
  if (adapters.eventSink === 'local') violations.push('EVENT_SINK=local');
  if (usingEmulators) violations.push('Firebase emulator hosts');
  // SimulatorMessagingProvider is explicitly allowed (approved fallback channel).
  return violations;
}
