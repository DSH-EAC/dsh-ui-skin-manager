export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult<T = unknown> {
  ok: boolean;
  issues: ValidationIssue[];
  value?: T;
}

export interface AssetRecord {
  path: string;
  sha256: string;
}

export interface SlotContribution {
  id: string;
  slot: string;
  entry: string;
  assets: string[];
  style?: {entry: string; assets: string[]};
  requires: {capabilities: string[]; slotKind: string[]; slotScope: string[]};
  lifecycle: {mount: string; health: string; unmount: string};
}

export interface SkinManifest {
  apiVersion: "dsh.eac.ui-skin/v1";
  kind: "SkinPackage";
  metadata: {id: string; version: string; name: string; author: string};
  engines: {manager: string; hostProfile: string; dsh?: string};
  dependencies?: Array<{id: string; range: string}>;
  contributions: SlotContribution[];
  assets: AssetRecord[];
  integrity: Record<string, string>;
}

export interface SlotDescriptor {
  id: string;
  region: string;
  kind: string;
  scope: string;
  propsSchema: Record<string, unknown>;
  mountContract: string;
  zIndexPolicy: {min: number; max: number};
  capabilities: string[];
  fallbackSkin: string;
}

export interface HostProfile {
  id: string;
  version: string;
  regions: string[];
  slots: SlotDescriptor[];
  instanceKinds: string[];
  zIndexPolicy: Record<string, {min: number; max: number}>;
  capabilities: Array<{id: string; version: string}>;
  dshAdapters: unknown[];
  fallbackSkin: {id: string; version: string; digest: string};
}

export interface SlotBinding {
  slot: string;
  package: {id: string; version: string; digest: string};
  contribution: string;
  generation: number;
  state: "staged" | "active" | "failed" | "inactive";
}

export interface BindingGeneration {
  generation: number;
  bindings: Record<string, SlotBinding>;
}

export interface QuarantineRecord {
  packageId: string;
  slot: string;
  reason: string;
  timestamp: string;
}

export interface FaultEvent {
  timestamp: string;
  severity: "warning" | "error" | "fatal";
  errorCode: string;
  message: string;
  correlationId: string;
  generation: number;
  regionOrSlot: string;
  lifecycleStage: string;
  source: "official" | "third-party";
  recoverable: boolean;
  recoveryAction: string;
  bindingState: string;
  packageId?: string;
  packageVersion?: string;
  packageDigest?: string;
  control?: string;
  detail?: Record<string, unknown>;
}

export interface DisposeReport {
  generation: number;
  slot: string;
  attempted: number;
  released: number;
  remaining: string[];
  errors: string[];
  timedOut: boolean;
  completedAt: string;
}
