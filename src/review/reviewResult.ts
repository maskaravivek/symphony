import type { VerificationEvidence, VerificationReviewer } from '../merge/mergePolicy.js';

export type ReviewVerdict = 'pass' | 'block' | 'retry';
export type ReviewFindingDisposition = 'actionable' | 'nit' | 'ambiguous';

export interface ReviewFinding {
  disposition: ReviewFindingDisposition;
  severity: string;
  summary: string;
  file: string | null;
  line: number | null;
}

export interface StructuredReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  evidence: VerificationEvidence[];
  reviewer: VerificationReviewer | null;
  structured: boolean;
}

const RESULT_MARKER = 'SYMPHONY_REVIEW_RESULT:';
const EVIDENCE_MARKER = 'SYMPHONY_VERIFICATION_EVIDENCE:';
const REVIEWER_MARKER = 'SYMPHONY_REVIEWER:';

function parseMarkerObject(output: string, marker: string): Record<string, unknown> | null {
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const raw = line.slice(index + marker.length).trim();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Keep looking. Hook logs may contain a failed or quoted attempt before the final marker.
    }
  }
  return null;
}

function normalizeEvidence(value: unknown): VerificationEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.kind !== 'string' || typeof item.summary !== 'string') return [];
    return [{
      kind: item.kind.trim().toLowerCase(),
      summary: item.summary.trim(),
      command: typeof item.command === 'string' ? item.command : null,
      artifact: typeof item.artifact === 'string' ? item.artifact : null,
    }];
  }).filter((entry) => entry.kind && entry.summary);
}

function normalizeReviewer(value: unknown): VerificationReviewer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.execution_id !== 'string' || !item.execution_id.trim()) return null;
  return {
    execution_id: item.execution_id.trim(),
    provider: typeof item.provider === 'string' ? item.provider : null,
    model: typeof item.model === 'string' ? item.model : null,
    lens: typeof item.lens === 'string' ? item.lens : null,
  };
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (item.disposition !== 'actionable' && item.disposition !== 'nit' && item.disposition !== 'ambiguous') return [];
    if (typeof item.summary !== 'string' || !item.summary.trim()) return [];
    return [{
      disposition: item.disposition,
      severity: typeof item.severity === 'string' ? item.severity : 'unspecified',
      summary: item.summary.trim(),
      file: typeof item.file === 'string' ? item.file : null,
      line: typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0 ? item.line : null,
    }];
  });
}

export function parseStructuredReviewResult(output: string): StructuredReviewResult | null {
  const payload = parseMarkerObject(output, RESULT_MARKER);
  const evidencePayload = parseMarkerObject(output, EVIDENCE_MARKER);
  const reviewerPayload = parseMarkerObject(output, REVIEWER_MARKER);
  const legacyMatches = [...output.matchAll(/REVIEW_VERDICT:\s*(PASS|BLOCK|RETRY)\b/gi)];
  const legacyVerdict = legacyMatches.at(-1)?.[1]?.toLowerCase() as ReviewVerdict | undefined;

  if (!payload) {
    if (!legacyVerdict) return null;
    return {
      verdict: legacyVerdict,
      summary: `Review hook returned REVIEW_VERDICT: ${legacyVerdict.toUpperCase()}`,
      findings: [],
      evidence: [
        { kind: 'review', summary: 'Independent code review completed', command: null, artifact: null },
        ...normalizeEvidence(evidencePayload?.evidence),
      ],
      reviewer: normalizeReviewer(reviewerPayload),
      structured: false,
    };
  }

  const verdict = payload.verdict;
  if (verdict !== 'pass' && verdict !== 'block' && verdict !== 'retry') return null;
  const findings = normalizeFindings(payload.findings);
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim()
    : `Structured review returned ${verdict}`;
  return {
    verdict,
    summary,
    findings,
    evidence: [
      { kind: 'review', summary, command: null, artifact: null },
      ...normalizeEvidence(payload.evidence),
      ...normalizeEvidence(evidencePayload?.evidence),
    ],
    reviewer: normalizeReviewer(reviewerPayload) ?? normalizeReviewer(payload.reviewer),
    structured: true,
  };
}

export function reviewNeedsHuman(result: StructuredReviewResult): boolean {
  return result.findings.some((finding) => finding.disposition === 'ambiguous');
}
