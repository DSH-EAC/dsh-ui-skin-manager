import type {FaultEvent, ValidationIssue} from "../contracts/models.ts";
import {validateFaultEvent} from "../contracts/validation.ts";
import {redactDetail} from "./redaction.ts";

export interface DiagnosticEntry {
  timestamp?: string;
  errorCode: string;
  regionOrSlot: string;
  lifecycleStage: string;
  message: string;
  correlationId?: string;
}

export type RecordedDiagnostic = {recorded: true; fault: FaultEvent} | {recorded: false; issues: ValidationIssue[]};

const DEFAULT_LIMIT = 500;

function normalize(entry: Partial<FaultEvent>): FaultEvent {
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const correlationId = typeof entry.correlationId === "string" && entry.correlationId.length > 0 ? entry.correlationId : `diagnostic-${timestamp}`;
  const fault: FaultEvent = {
    timestamp,
    severity: entry.severity ?? "error",
    errorCode: entry.errorCode ?? "",
    message: entry.message ?? "",
    correlationId,
    generation: entry.generation ?? 0,
    regionOrSlot: entry.regionOrSlot ?? "",
    lifecycleStage: entry.lifecycleStage ?? "",
    source: entry.source ?? "third-party",
    recoverable: entry.recoverable ?? true,
    recoveryAction: entry.recoveryAction ?? "none",
    bindingState: entry.bindingState ?? "inactive"
  };
  for (const key of ["packageId", "packageVersion", "packageDigest", "control"] as const) {
    const value: unknown = entry[key];
    if (typeof value === "string" && value.length > 0) fault[key] = value;
  }
  if (entry.detail !== undefined) fault.detail = redactDetail(entry.detail);
  return fault;
}

export class DiagnosticStore {
  readonly limit: number;
  #entries: FaultEvent[] = [];
  #dropped = 0;

  constructor(options: {limit?: number} = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) throw new RangeError("limit must be a positive integer");
  }

  // ADR 0002 section 6: redaction is applied before anything is retained, and only a bounded selection is
  // exportable. A record that cannot satisfy the FaultEvent contract is counted as dropped, never laundered.
  record(entry: DiagnosticEntry | Partial<FaultEvent>): RecordedDiagnostic {
    const fault = normalize(entry);
    const validation = validateFaultEvent(fault);
    if (!validation.ok) {
      this.#dropped += 1;
      return {recorded: false, issues: validation.issues};
    }
    this.#entries.push(fault);
    const overflow = this.#entries.length - this.limit;
    if (overflow > 0) {
      this.#entries.splice(0, overflow);
      this.#dropped += overflow;
    }
    return {recorded: true, fault};
  }

  export(): FaultEvent[] {
    return this.#entries.map((entry) => ({...entry}));
  }

  get dropped(): number { return this.#dropped; }

  clear(): void {
    this.#entries = [];
    this.#dropped = 0;
  }
}
