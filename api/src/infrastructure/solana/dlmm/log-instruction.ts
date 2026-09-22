import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { classifyInstruction } from '@/domain/dlmm';

const KIND_PRIORITY: Record<string, number> = { close: 5, open: 4, remove: 3, add: 2, claim: 1 };

/**
 * A single tx often carries several DLMM instructions (a close is
 * `RemoveLiquidityByRange2 → ClaimFee2 → ClosePositionIfEmpty`). Returning only the FIRST one made
 * closes look like plain removes and lost the ws:close fast-path. We now scan ALL DLMM instructions and
 * return the highest-priority one (close > open > remove > add > claim); a partial close with no
 * `ClosePosition*` correctly stays `remove`.
 */
export function parseInstruction(logs: string[]): string | null {
  let inDlmm = false;
  let best: string | null = null;
  let bestPriority = 0;
  for (const l of logs) {
    if (l.includes(`Program ${DLMM_PROGRAM_ID} invoke`)) inDlmm = true;
    else if (l.includes(`Program ${DLMM_PROGRAM_ID} success`)) inDlmm = false;
    else if (inDlmm && l.startsWith('Program log: Instruction:')) {
      const ix = l.replace('Program log: Instruction:', '').trim();
      if (best === null) best = ix; // keep the first as a fallback even if it doesn't classify
      const kind = classifyInstruction(ix);
      const priority = kind ? (KIND_PRIORITY[kind] ?? 0) : 0;
      if (priority > bestPriority) {
        best = ix;
        bestPriority = priority;
      }
    }
  }
  return best;
}
