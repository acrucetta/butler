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
  constructor(
    private readonly baseUrl: string,
    private readonly gatewayToken: string
  ) {}

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

  private async request(path: string, init: RequestInit): Promise<any> {
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
          "x-api-key": this.gatewayToken,
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

    return response.json();
  }
}
