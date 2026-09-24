import {DiagnosticStore} from "../../diagnostics/diagnostic-store.ts";
import {redact} from "../../diagnostics/redaction.ts";
import type {FaultEvent} from "../../contracts/models.ts";

export interface ErrorSurfaceActions {
  retry(): void;
  disable(): void;
  restoreDefault(): void;
  viewLogs(): void;
  copyDiagnostics(): string;
  viewPackageSource(): string;
}

export interface RuntimeErrorSurface {
  show(fault: FaultEvent): ErrorSurfaceActions;
}

export interface RuntimeTask {
  slot: string;
  generation: number;
  packageId: string;
  packageVersion: string;
  packageDigest: string;
  source?: "official" | "third-party";
  control?: string;
  run(): void | Promise<void>;
}

export class RuntimeSupervisor {
  readonly diagnostics: DiagnosticStore;
  readonly errorSurface: RuntimeErrorSurface;

  constructor(options: {errorSurface: RuntimeErrorSurface; diagnostics?: DiagnosticStore}) {
    this.errorSurface = options.errorSurface;
    this.diagnostics = options.diagnostics ?? new DiagnosticStore();
  }

  async run(task: RuntimeTask): Promise<{ok: true} | {ok: false; error: Error; errorUi: ErrorSurfaceActions; fault: FaultEvent}> {
    try {
      await task.run();
      return {ok: true};
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const fault: FaultEvent = {
        timestamp: new Date().toISOString(),
        severity: "error",
        errorCode: "RUNTIME_COMPONENT_FAILED",
        message: redact(error.message),
        correlationId: `runtime-${task.slot}-${task.generation}`,
        generation: task.generation,
        regionOrSlot: task.slot,
        lifecycleStage: "runtime",
        source: task.source ?? "third-party",
        recoverable: true,
        recoveryAction: "restore-default",
        bindingState: "failed",
        packageId: task.packageId,
        packageVersion: task.packageVersion,
        packageDigest: task.packageDigest,
        ...(task.control === undefined ? {} : {control: task.control})
      };
      this.diagnostics.record(fault);
      return {ok: false, error, errorUi: this.errorSurface.show(fault), fault};
    }
  }
}
