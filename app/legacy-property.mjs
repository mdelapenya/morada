import { readFileSync } from 'node:fs';

// Only older, single-property installations need this local migration setting.
// New installations start with an empty housing list.
let saved = null;
try {
  const source = process.env.IDEALISTA_LEGACY_PROPERTY_FILE ??
    new URL('../.local/legacy-property.json', import.meta.url);
  const value = JSON.parse(readFileSync(source, 'utf8'));
  if (value && /^\d{8,}$/.test(value.id) && typeof value.listingLabel === 'string') saved = value;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

export const legacyProperty = saved;
export const DEFAULT_PROPERTY_ID = saved?.id ?? 'legacy-unconfigured';
