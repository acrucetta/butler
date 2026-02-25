import {
  AdminStateSchema,
  JobCreateRequestSchema,
  JobEventsResponseSchema,
  JobSchema,
  type AdminState,
  type Job,
  type JobCreateRequest,
  type JobEventsResponse
} from "@pi-self/contracts";

export class OrchestratorClient {
  private readonly requestTimeoutMs: number;
  private readonly getRetryCount: number;
  private readonly getRetryDelayMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly gatewayToken: string,
    options?: {
      requestTimeoutMs?: number;
      getRetryCount?: number;
      getRetryDelayMs?: number;
    }
  ) {
    this.requestTimeoutMs = Math.max(1_000, Math.floor(options?.requestTimeoutMs ?? 20_000));
    this.getRetryCount = Math.max(0, Math.floor(options?.getRetryCount ?? 2));
    this.getRetryDelayMs = Math.max(0, Math.floor(options?.getRetryDelayMs ?? 400));
  }

  async createJob(input: JobCreateRequest): Promise<Job> {
    const parsed = JobCreateRequestSchema.parse(input);
    const payload = await this.request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(parsed)
    });
    return JobSchema.parse(payload.job);
  }

  async getJob(jobId: string): Promise<Job> {
    const payload = await this.request(`/v1/jobs/${jobId}`, {
      method: "GET"
    });
    return JobSchema.parse(payload.job);
  }

  async getEvents(jobId: string, cursor: number): Promise<JobEventsResponse> {
    const payload = await this.request(`/v1/jobs/${jobId}/events?cursor=${encodeURIComponent(String(cursor))}`, {
      method: "GET"
    });
    return JobEventsResponseSchema.parse(payload);
  }

  async approveJob(jobId: string): Promise<Job> {
    const payload = await this.request(`/v1/jobs/${jobId}/approve`, {
      method: "POST",
      body: "{}"
    });
    return JobSchema.parse(payload.job);
  }

  async abortJob(jobId: string): Promise<Job> {
    const payload = await this.request(`/v1/jobs/${jobId}/abort`, {
      method: "POST",
      body: "{}"
    });
    return JobSchema.parse(payload.job);
  }

  async getAdminState(): Promise<AdminState> {
    const payload = await this.request("/v1/admin/state", {
      method: "GET"
    });
    return AdminStateSchema.parse(payload.admin);
  }

  async pause(reason?: string): Promise<AdminState> {
    const payload = await this.request("/v1/admin/pause", {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    return AdminStateSchema.parse(payload.admin);
  }

  async resume(): Promise<AdminState> {
    const payload = await this.request("/v1/admin/resume", {
      method: "POST",
      body: "{}"
    });
    return AdminStateSchema.parse(payload.admin);
  }

  async listPendingProactiveDeliveries(limit = 20): Promise<Job[]> {
    const payload = await this.request(`/v1/proactive/deliveries/pending?limit=${encodeURIComponent(String(limit))}`, {
      method: "GET"
    });
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    return jobs.map((job: unknown) => JobSchema.parse(job));
  }

  async ackProactiveDelivery(jobId: string, receipt: string): Promise<Job> {
    const payload = await this.request(`/v1/proactive/deliveries/${encodeURIComponent(jobId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ receipt })
    });
    return JobSchema.parse(payload.job);
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    const method = String(init.method ?? "GET").toUpperCase();
    const maxAttempts = method === "GET" ? this.getRetryCount + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, this.requestTimeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": this.gatewayToken,
            ...(init.headers ?? {})
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt < maxAttempts && isRetryableNetworkError(error)) {
          await sleep(this.getRetryDelayMs * attempt);
          continue;
        }
        throw error;
      }
      clearTimeout(timeout);

      if (response.ok) {
        return response.json();
      }

      const text = await response.text();
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(this.getRetryDelayMs * attempt);
        continue;
      }
      throw new Error(`orchestrator request failed (${response.status}): ${text}`);
    }

    throw new Error("orchestrator request failed: retries exhausted");
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("socket") ||
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("timed out") ||
    text.includes("aborted")
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
