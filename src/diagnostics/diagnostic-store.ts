export interface DiagnosticEntry {
  timestamp?: string;
  errorCode: string;
  regionOrSlot: string;
  lifecycleStage: string;
  message: string;
  correlationId?: string;
}

export class DiagnosticStore {
  #entries: DiagnosticEntry[] = [];
  record(entry: DiagnosticEntry): void { this.#entries.push({...entry, timestamp: entry.timestamp ?? new Date().toISOString()}); }
  export(): DiagnosticEntry[] { return this.#entries.map((entry) => ({...entry})); }
  clear(): void { this.#entries = []; }
}
