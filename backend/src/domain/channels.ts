/** Customer channels (docs/04_DATA_MODEL.md §6, §12). */
export const CHANNELS = ['WHATSAPP', 'SIMULATOR'] as const;
export type Channel = (typeof CHANNELS)[number];
