/**
 * TfL line palette + display names for the preview only. The BACKEND is the
 * source of truth for the colour that actually ships (enrichPayload looks it
 * up from LineIconService). This subset just lets the preview tint the chip
 * the way the device will, and powers the line-id dropdown.
 */
export interface LineMeta {
  id: string;
  name: string;
  color: string;
}

export const TFL_LINES: LineMeta[] = [
  { id: 'bakerloo', name: 'Bakerloo', color: '#B36305' },
  { id: 'central', name: 'Central', color: '#E32017' },
  { id: 'circle', name: 'Circle', color: '#FFD300' },
  { id: 'district', name: 'District', color: '#00782A' },
  { id: 'hammersmith-city', name: 'Hammersmith & City', color: '#F3A9BB' },
  { id: 'jubilee', name: 'Jubilee', color: '#A0A5A9' },
  { id: 'metropolitan', name: 'Metropolitan', color: '#9B0056' },
  { id: 'northern', name: 'Northern', color: '#000000' },
  { id: 'piccadilly', name: 'Piccadilly', color: '#003688' },
  { id: 'victoria', name: 'Victoria', color: '#0098D4' },
  { id: 'waterloo-city', name: 'Waterloo & City', color: '#95CDBA' },
  { id: 'elizabeth', name: 'Elizabeth', color: '#6950A1' },
  { id: 'dlr', name: 'DLR', color: '#00A4A7' },
  { id: 'overground', name: 'Overground', color: '#EE7C0E' },
];

export function lineColor(lineId?: string): string | undefined {
  if (!lineId) return undefined;
  return TFL_LINES.find((l) => l.id === lineId.toLowerCase())?.color;
}
