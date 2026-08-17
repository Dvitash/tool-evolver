/**
 * @tool-evolver/e2e - Lifecycle Trace Reporter
 *
 * Captures machine-readable audit reports of every V1 architectural
 * and functional requirement assertion across E2E evolution runs.
 */

export type AssertionStatus = "pass" | "fail" | "skip";

export type RequirementCategory =
  | "functional"
  | "performance"
  | "reliability"
  | "security"
  | "isolation"
  | "user-controls"
  | "cloud-proxy";

export interface TraceAssertion {
  requirementId: string;
  name: string;
  category: RequirementCategory;
  status: AssertionStatus;
  timestamp: string;
  durationMs: number;
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface LifecycleTraceSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface LifecycleTraceReport {
  reportId: string;
  generatedAt: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    e2eVersion: string;
  };
  summary: LifecycleTraceSummary;
  categories: Record<RequirementCategory, { total: number; passed: number; failed: number }>;
  assertions: TraceAssertion[];
}

export class LifecycleTraceReporter {
  private assertions: TraceAssertion[] = [];
  private startTime = Date.now();

  /**
   * Record a verified requirement assertion.
   */
  recordAssertion(params: {
    requirementId: string;
    name: string;
    category?: RequirementCategory;
    status: AssertionStatus;
    durationMs?: number;
    evidence?: Record<string, unknown>;
    error?: string;
  }): TraceAssertion {
    const assertion: TraceAssertion = {
      requirementId: params.requirementId,
      name: params.name,
      category: params.category ?? "functional",
      status: params.status,
      timestamp: new Date().toISOString(),
      durationMs: params.durationMs ?? 0,
      evidence: params.evidence,
      error: params.error,
    };

    this.assertions.push(assertion);
    return assertion;
  }

  /**
   * Assert a requirement condition and record result.
   */
  assertRequirement(
    requirementId: string,
    name: string,
    condition: boolean,
    options: {
      category?: RequirementCategory;
      evidence?: Record<string, unknown>;
      errorMessage?: string;
      durationMs?: number;
    } = {},
  ): boolean {
    const status: AssertionStatus = condition ? "pass" : "fail";
    this.recordAssertion({
      requirementId,
      name,
      category: options.category ?? "functional",
      status,
      durationMs: options.durationMs ?? 0,
      evidence: options.evidence,
      error: condition
        ? undefined
        : (options.errorMessage ?? `Requirement ${requirementId} assertion failed: ${name}`),
    });

    return condition;
  }

  /**
   * Return high-level summary.
   */
  getSummary(): LifecycleTraceSummary {
    const passed = this.assertions.filter((a) => a.status === "pass").length;
    const failed = this.assertions.filter((a) => a.status === "fail").length;
    const skipped = this.assertions.filter((a) => a.status === "skip").length;

    return {
      total: this.assertions.length,
      passed,
      failed,
      skipped,
      durationMs: Date.now() - this.startTime,
    };
  }

  /**
   * Return all recorded assertions.
   */
  getAssertions(): readonly TraceAssertion[] {
    return [...this.assertions];
  }

  /**
   * Check if any assertion failed.
   */
  hasFailures(): boolean {
    return this.assertions.some((a) => a.status === "fail");
  }

  /**
   * Generate full structured report.
   */
  getReport(): LifecycleTraceReport {
    const summary = this.getSummary();
    const categories: Record<
      RequirementCategory,
      { total: number; passed: number; failed: number }
    > = {
      functional: { total: 0, passed: 0, failed: 0 },
      performance: { total: 0, passed: 0, failed: 0 },
      reliability: { total: 0, passed: 0, failed: 0 },
      security: { total: 0, passed: 0, failed: 0 },
      isolation: { total: 0, passed: 0, failed: 0 },
      "user-controls": { total: 0, passed: 0, failed: 0 },
      "cloud-proxy": { total: 0, passed: 0, failed: 0 },
    };

    for (const a of this.assertions) {
      const cat = categories[a.category];
      if (cat) {
        cat.total++;
        if (a.status === "pass") cat.passed++;
        if (a.status === "fail") cat.failed++;
      }
    }

    return {
      reportId: `trace_${Date.now().toString(16)}`,
      generatedAt: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        e2eVersion: "0.1.0",
      },
      summary,
      categories,
      assertions: [...this.assertions],
    };
  }

  /**
   * Export report as formatted JSON string.
   */
  exportJson(indent = 2): string {
    return JSON.stringify(this.getReport(), null, indent);
  }

  /**
   * Reset all recorded assertions.
   */
  reset(): void {
    this.assertions = [];
    this.startTime = Date.now();
  }
}
