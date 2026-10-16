/** Tag mapping and attribute sanitization applied before any value is recorded. */

import type { TaroReplayNodeLike } from '../types';
import { isInputNode, rawAttributeValue } from './nodes';

export const TAG_MAP: Record<string, string> = {
  root: 'div',
  view: 'div',
  text: 'span',
  image: 'img',
  input: 'input',
  textarea: 'textarea',
  button: 'button',
  form: 'form',
  label: 'label',
  scrollview: 'div',
  'scroll-view': 'div',
  swiper: 'div',
  'swiper-item': 'div',
  'root-portal': 'div',
  'picker-view': 'div',
  'picker-view-column': 'div',
};

export const SELF_CLOSING_TAGS = new Set(['img', 'input']);

export const URL_ATTRIBUTE_NAMES = new Set([
  'action',
  'formaction',
  'href',
  'poster',
  'src',
  'xlink:href',
]);
export const INPUT_MASK_ATTRIBUTE_NAMES = new Set(['password', 'type', 'data-sentry-mask']);
export const SENSITIVE_ATTRIBUTE_NAME =
  /(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|open[-_]?id|union[-_]?id|phone|email|idcard|user[-_]?id|account)/i;

export function sanitizeUrl(value: string): string {
  // Browser URL parsing skips leading C0/space and removes ASCII tabs/newlines.
  // Use that copy only to detect data URLs; exact image keys and other URLs stay unchanged.
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) start++;
  const dataUrlCandidate = value.slice(start).replace(/[\t\n\r]/g, '');
  if (/^data:/i.test(dataUrlCandidate)) {
    const mimeType = dataUrlCandidate.match(/^data:([^;,]+)/i)?.[1] || 'text/plain';
    return `data:${mimeType}`;
  }

  if (/^(?:javascript|vbscript|blob):/i.test(dataUrlCandidate)) return '[Filtered]';
  const withoutQueryOrFragment = (dataUrlCandidate.split(/[?#]/, 1)[0] || '').replace(
    /^((?:https?|wss?|ftp):)[\\/]*/i,
    '$1//',
  );
  return withoutQueryOrFragment.replace(
    /^((?:[a-z][a-z0-9+.-]*:)?[\\/]{2})([^\\/]*@)/i,
    '$1[filtered]:[filtered]@',
  );
}

export function primitiveAttributeValue(value: unknown): string | number | true | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return true;
  if (typeof value === 'number') return value;
  return String(value);
}

export function maskValue(value: unknown): string {
  return String(value ?? '').replace(/\S/gu, '*');
}

export function hasMaskingFlag(node: TaroReplayNodeLike, name: string): boolean {
  const value = rawAttributeValue(node, name);
  return value === true || value === 1 || value === '' || value === 'true' || value === '1';
}

export function privacyMarker(node: TaroReplayNodeLike, name: string): boolean {
  if (hasMaskingFlag(node, `data-sentry-${name}`)) return true;
  const className = rawAttributeValue(node, 'class') ?? rawAttributeValue(node, 'classname');
  return typeof className === 'string' && className.split(/\s+/).includes(`sentry-${name}`);
}

export function sanitizeAttributeValue(
  node: TaroReplayNodeLike,
  name: string,
  value: unknown,
  maskInputValues: boolean,
): string | number | true | null {
  let safeValue = value;
  if (SENSITIVE_ATTRIBUTE_NAME.test(name)) {
    safeValue = '[Filtered]';
  } else if (
    maskInputValues &&
    isInputNode(node) &&
    ['value', 'defaultvalue'].includes(name.toLowerCase())
  ) {
    safeValue = maskValue(value);
  } else if (URL_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
    safeValue = sanitizeUrl(String(value ?? ''));
  }
  return primitiveAttributeValue(safeValue);
}
