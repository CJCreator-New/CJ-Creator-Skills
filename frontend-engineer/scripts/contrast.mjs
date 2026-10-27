#!/usr/bin/env node
// WCAG 2.x contrast ratio between a foreground and a background colour. Use it to check design
// tokens against the text and non-text thresholds before the rendered page is checked.
//
//   node scripts/contrast.mjs '#6b7280' '#ffffff'            normal text, needs 4.5:1
//   node scripts/contrast.mjs '#6b7280' '#ffffff' --large   large text, needs 3:1
//   node scripts/contrast.mjs '#d1d5db' '#ffffff' --non-text UI component or focus indicator, needs 3:1
//
// Colours: #rgb, #rrggbb, rgb(r, g, b) and rgba(r, g, b, a). A translucent foreground is
// composited over the background first. Prints one JSON line. Exit 2 on bad input.

import { pathToFileURL } from 'node:url';

export const THRESHOLDS = { normal: 4.5, large: 3, nonText: 3 };

export function parseColor(input) {
  const value = String(input).trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = parseInt(digits, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) {
    const [r, g, b] = fn.slice(1, 4).map(Number);
    const a = fn[4] === undefined ? 1 : Number(fn[4]);
    if ([r, g, b].some((c) => c > 255) || a < 0 || a > 1) throw new Error(`colour out of range: ${input}`);
    return { r, g, b, a };
  }
  throw new Error(`unsupported colour: ${input} (use #rgb, #rrggbb, rgb() or rgba())`);
}

// Source-over compositing of a translucent foreground onto an opaque background.
export function composite(fg, bg) {
  const mix = (f, b) => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

export function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export function check(fgInput, bgInput, { large = false, nonText = false } = {}) {
  const bg = parseColor(bgInput);
  const fg = composite(parseColor(fgInput), bg);
  const ratio = contrastRatio(fg, bg);
  const required = nonText ? THRESHOLDS.nonText : large ? THRESHOLDS.large : THRESHOLDS.normal;
  const kind = nonText ? 'non-text' : large ? 'large text' : 'normal text';
  return {
    foreground: fgInput,
    background: bgInput,
    kind,
    ratio: Math.round(ratio * 100) / 100,
    required,
    pass: ratio >= required,
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const colours = args.filter((a) => !a.startsWith('--'));
  const known = new Set(['--large', '--non-text']);
  const unknown = [...flags].filter((f) => !known.has(f));
  if (colours.length !== 2 || unknown.length) {
    process.stderr.write('usage: contrast.mjs <foreground> <background> [--large | --non-text]\n');
    process.exit(2);
  }
  try {
    const result = check(colours[0], colours[1], { large: flags.has('--large'), nonText: flags.has('--non-text') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
