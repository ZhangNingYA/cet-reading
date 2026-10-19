import { randomUUID } from 'node:crypto';
import type { AnalysisRequestTrace } from '@cet-reading/contracts/analysis-diagnostics';

export type TraceObserver = (trace: AnalysisRequestTrace) => Promise<void>;
export const TRACE_TEXT_LIMIT = 131072;
const now = () => new Date().toISOString();
export function redactDiagnosticText(value: string, apiKey: string) {
  return (apiKey ? value.split(apiKey).join('[已隐藏密钥]') : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏密钥]');
}

export class ModelRequestTrace {
  readonly data: AnalysisRequestTrace;
  constructor(model: string, round: number, transportAttempt: number, requestText: string,
    private readonly apiKey: string, private readonly observer?: TraceObserver) {
    this.data = {
      id: randomUUID(), model, round, transportAttempt, purpose: round === 1 ? 'initial' : 'repair',
      sentAt: now(), responseAt: null, firstContentAt: null, completedAt: null, validatedAt: null,
      httpStatus: null, providerRequestId: null, requestText: requestText.slice(0, TRACE_TEXT_LIMIT),
      requestTruncated: requestText.length > TRACE_TEXT_LIMIT,
      responseText: '', responseBody: '', responseChars: 0, responseTruncated: false,
      responseKind: 'model_content', finishReason: null, errorMessage: null,
      validationStatus: 'pending', validationError: null, validationIssues: [],
    };
  }
  append(piece: string) {
    if (!piece) return;
    this.data.firstContentAt ??= now();
    this.data.responseChars += piece.length;
    this.data.responseText = (this.data.responseText + piece).slice(0, TRACE_TEXT_LIMIT);
    this.data.responseTruncated = this.data.responseChars > TRACE_TEXT_LIMIT;
  }
  body(value: string, kind: AnalysisRequestTrace['responseKind']) {
    this.data.responseBody = value.slice(0, TRACE_TEXT_LIMIT);
    this.data.responseKind = kind;
    this.data.responseTruncated ||= value.length > TRACE_TEXT_LIMIT;
  }
  async headers(response: Response) {
    this.data.responseAt = now();
    this.data.httpStatus = response.status;
    this.data.providerRequestId = (response.headers.get('x-request-id') ?? response.headers.get('request-id'))?.slice(0, 200) ?? null;
    await this.publish();
  }
  async finish(error?: unknown) {
    this.data.completedAt = now();
    if (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `; ${error.cause.message}` : '';
      this.data.errorMessage = `${error instanceof Error ? error.message : String(error)}${cause}`;
      this.data.validationStatus = 'not_run';
    }
    await this.publish();
  }
  async validate(error?: unknown) {
    this.data.validatedAt = now();
    this.data.validationStatus = error ? 'failed' : 'passed';
    this.data.validationError = error ? error instanceof Error ? error.message : String(error) : null;
    const issues = error && typeof error === 'object' && 'issues' in error ? error.issues : [];
    if (Array.isArray(issues)) this.data.validationIssues = issues.slice(0, 50).map(issue => ({
      path: Array.isArray(issue.path) ? issue.path.join('.') : '', message: String(issue.message ?? ''),
    }));
    await this.publish();
  }
  async publish() {
    if (!this.observer) return;
    // Never store authorization headers or let an echoed API key reach diagnostics.
    const snapshot = JSON.parse(JSON.stringify(this.data, (_key, value) => typeof value === 'string' ? redactDiagnosticText(value, this.apiKey) : value)) as AnalysisRequestTrace;
    try { await this.observer(snapshot); }
    catch { console.warn(JSON.stringify({ event: 'analysis_trace_write_failed', requestId: this.data.id })); }
  }
}
