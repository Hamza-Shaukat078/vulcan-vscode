export interface VulcanVuln {
  id: string;
  type: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  confidence: number;
  owasp?: string;
  cwe?: string;
  location: {
    file: string;
    // backend sends start_line/end_line; line is a fallback alias
    start_line?: number;
    end_line?: number;
    line?: number;
    column?: number;
  };
  evidence?: {
    source?: string;
    sink?: string;
    dataflow?: string;
    code_snippet?: string;
    data_flow_path?: string[];
  };
  analysis?: {
    remediation?: string;
    llm_classification?: {
      remediation?: string;
      explanation?: string;
      severity?: string;
      exploitability?: number;
      confidence?: number;
      classification?: string;
    };
    static_detection?: {
      severity?: string;
      confidence?: number;
      reason?: string;
    };
  };
  patch?: {
    status?: string;
    patch_id?: string;
    confidence?: number;
  };
}

export interface ScanResult {
  success: boolean;
  filename: string;
  language: string;
  vulnerabilities_found: number;
  vulnerabilities: VulcanVuln[];
  analysis_time_seconds?: number;
}

export interface PatchResult {
  patch_id: string;
  unified_diff: string;
  explanation: string;
  confidence: number;
  score_breakdown: {
    structural: number;
    semantic: number;
    overall: number;
    label: string;
  };
  validations: Array<{
    name: string;
    passed: boolean;
    details: string;
  }>;
  status: string;
  review_status: string;
  cwe?: string;
  owasp?: string;
  version: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}
