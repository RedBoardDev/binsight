import type { Exactness } from '@app/applications/Shared/Figure/Domain/figure';

// The glyph that stands before a figure: a lower bound (≥), an estimate (≈), unavailable (—). The
// API already resolves several causes to the strongest one (— over ≈ over ≥).
export const EXACTNESS_GLYPHS: Record<Exactness, string> = {
  complete: '',
  partial: '≥',
  estimated: '≈',
  unavailable: '—',
};
