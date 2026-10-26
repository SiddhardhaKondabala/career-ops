/**
 * Dependency-free company blacklist parser and matcher.
 *
 * Both scan.mjs and the approved-job exporter import this module so the safety
 * gate cannot drift from the canonical scan behavior. Keep it free of optional
 * packages: queue export must still enforce the blacklist before `npm install`.
 */

import { normalizeTextKey } from '../tracker-parse.mjs';

function normalizeBlacklistDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Parse the user-owned `data/blacklist.md` table. First duplicate key wins. */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue;
    if (company.toLowerCase() === 'company') continue;
    const scope = (cells[3] || 'company').toLowerCase();
    const value = scope === 'domain'
      ? normalizeBlacklistDomain(company)
      : normalizeTextKey(company);
    const key = scope === 'domain' ? `domain:${value}` : value;
    if (!value || entries.has(key)) continue;
    entries.set(key, {
      company,
      since: cells[2] || '',
      scope: scope === 'domain' ? 'domain' : 'company',
      reason: cells[4] || '',
    });
  }
  return entries;
}

/** Find the company-name or hostname-suffix entry that blocks a posting. */
export function findBlacklistEntry(blacklist, company, url) {
  if (!blacklist || blacklist.size === 0) return null;

  const companyEntry = blacklist.get(normalizeTextKey(company || ''));
  if (companyEntry && companyEntry.scope !== 'domain') return companyEntry;

  let hostname;
  try {
    hostname = normalizeBlacklistDomain(new URL(url).hostname);
  } catch {
    return null;
  }

  for (const entry of blacklist.values()) {
    if (entry.scope !== 'domain') continue;
    const suffix = normalizeBlacklistDomain(entry.company);
    if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) return entry;
  }
  return null;
}
