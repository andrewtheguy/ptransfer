/**
 * The terminal UI's colours, in one place.
 *
 * Terminals disagree about everything except that these hex colours are
 * readable on both a dark and a light background, so nothing here depends on
 * the palette the terminal was configured with.
 */
export const theme = {
  accent: '#7aa2f7',
  heading: '#c0caf5',
  muted: '#8b93a7',
  good: '#9ece6a',
  warn: '#e0af68',
  bad: '#f7768e',
  border: '#565f89',
} as const;
