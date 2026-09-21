import {DiagnosticStore} from "../../diagnostics/diagnostic-store.ts";
import type {FaultEvent} from "../../contracts/models.ts";

export interface RuntimeErrorSurface {
  show(fault: FaultEvent): {
    retry(): void;
    disable(): void;
    restoreDefault(): void;
    viewLogs(): void;
    copyDiagnostics(): string;
  };
}

export interface RuntimeTask {
  slot: string;
  generation: number;
  packageId: string;
  packageVersion: string;
  packageDigest: string;
  source?: "official" | "third-party";
  run(): void | Promise<void>;
}

export class RuntimeSupervisor {
  readonly diagnostics = new DiagnosticStore();
  readonly errorSurface: RuntimeErrorSurface;

  constructor(options: {errorSurface: RuntimeErrorSurface}) {
    this.errorSurface = options.errorSurface;
  }

  async run(task: RuntimeTask): Promise<{ok: true} | {ok: false; error: Error; errorUi: ReturnType<RuntimeErrorSurface["show"]>}> {
    try {
      await task.run();
      return {ok: true};
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const correlationId = `runtime-${task.slot}-${task.generation}`;
      const fault: FaultEvent = {
        timestamp: new Date().toISOString(),
        severity: "error",
        errorCode: "RUNTIME_COMPONENT_FAILED",
        message: redact(error.message),
        correlationId,
        generation: task.generation,
        regionOrSlot: task.slot,
        lifecycleStage: "runtime",
        source: task.source ?? "third-party",
        recoverable: true,
        recoveryAction: "restore-default",
        bindingState: "failed",
        packageId: task.packageId,
        packageVersion: task.packageVersion,
        packageDigest: task.packageDigest
      };
      this.diagnostics.record(fault);
      return {ok: false, error, errorUi: this.errorSurface.show(fault)};
    }
  }
}

function redact(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)(?:[^\\/\s]+[\\/])*[^\\/\s]*/g, "<redacted-path>")
    .replace(/\b(?:token|password|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>");
}
