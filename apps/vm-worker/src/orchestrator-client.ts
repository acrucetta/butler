import {
  ClaimJobResponseSchema,
  type Job,
  JobSchema,
  type JobEvent,
  WorkerHeartbeatResponseSchema
} from "@pi-self/contracts";

export class OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly workerToken: string
  ) {}

  async claimJob(workerId: string): Promise<Job | null> {
    const payload = await this.request("/v1/workers/claim", {
      method: "POST",
      body: JSON.stringify({ workerId })
    });
    const parsed = ClaimJobResponseSchema.parse(payload);
    return parsed.job;
  }

  async postEvent(jobId: string, event: JobEvent): Promise<void> {
    await this.request(`/v1/workers/${jobId}/events`, {
      method: "POST",
      body: JSON.stringify({ event })
    });
  }

  async heartbeat(jobId: string): Promise<boolean> {
    const payload = await this.request(`/v1/workers/${jobId}/heartbeat`, {
      method: "GET"
    });
    const parsed = WorkerHeartbeatResponseSchema.parse(payload);
    return parsed.abortRequested;
  }

  async complete(jobId: string, resultText: string): Promise<Job> {
    const payload = await this.request(`/v1/workers/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify({ resultText })
    });
    return JobSchema.parse((payload as { job: unknown }).job);
  }

  async fail(jobId: string, error: string): Promise<Job> {
    const payload = await this.request(`/v1/workers/${jobId}/fail`, {
      method: "POST",
      body: JSON.stringify({ error })
    });
    return JobSchema.parse((payload as { job: unknown }).job);
  }

  async aborted(jobId: string, reason?: string): Promise<Job> {
    const payload = await this.request(`/v1/workers/${jobId}/aborted`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    return JobSchema.parse((payload as { job: unknown }).job);
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 20_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.workerToken,
          ...(init.headers ?? {})
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`orchestrator request failed (${response.status}): ${text}`);
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }
}
