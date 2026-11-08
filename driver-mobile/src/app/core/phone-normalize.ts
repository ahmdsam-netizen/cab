/**
 * Normalizes phone input for India-first Cabbies flow.
 * - Strips spaces
 * * If already starts with +, returns as-is (after space trim)
 * * If 10 digits, assumes India mobile → +91
 */
export function normalizePhoneToE164(raw: string, defaultCountryCode = '91'): string {
  let p = raw.replace(/\s/g, '').replace(/-/g, '');
  if (!p) return '';
  if (p.startsWith('+')) {
    return p;
  }
  if (p.startsWith('0')) {
    p = p.slice(1);
  }
  if (/^\d{10}$/.test(p)) {
    return `+${defaultCountryCode}${p}`;
  }
  if (/^\d{12}$/.test(p) && p.startsWith(defaultCountryCode)) {
    return `+${p}`;
  }
  return `+${p}`;
}
